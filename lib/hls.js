/**
 * Remontador de "lista de pedaços" (HLS).
 *
 * Quando o LinkedIn não oferece um MP4 inteiro, ele entrega um arquivo de texto
 * (.m3u8) que lista dezenas de pedacinhos do vídeo. Este módulo:
 *
 *   1. lê a lista;
 *   2. se for uma "lista de listas", escolhe a melhor qualidade;
 *   3. baixa os pedaços em paralelo;
 *   4. descriptografa quando houver AES-128;
 *   5. devolve os bytes na ordem, prontos para virar um arquivo só.
 *
 * Nada de reencode: os pedaços são copiados como estão. Isso mantém a qualidade
 * original e leva segundos, não minutos.
 */

/**
 * Lê `CHAVE=valor,CHAVE="valor com vírgula"` das etiquetas da lista.
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseAttributes(text) {
  const out = {};
  const pattern = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[2].startsWith('"') ? match[2].slice(1, -1) : match[2];
    out[match[1].toUpperCase()] = value;
  }
  return out;
}

/**
 * Resolve um endereço relativo contra o endereço base.
 * @param {string} base
 * @param {string} ref
 * @returns {string}
 */
export function resolveUrl(base, ref) {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

/**
 * Altura a partir de `RESOLUTION=1280x720`.
 * @param {string|undefined} resolution
 * @returns {number|null}
 */
function resolutionHeight(resolution) {
  if (!resolution) return null;
  const match = /(\d+)x(\d+)/.exec(resolution);
  return match ? Number(match[2]) || null : null;
}

/**
 * Lista de qualidades de uma "lista de listas", da melhor para a pior.
 * @param {string} text
 * @param {string} baseUrl
 * @returns {Array<{url: string, bandwidth: number, height: number|null, codecs: string|null}>}
 */
export function parseMasterPlaylist(text, baseUrl) {
  const lines = String(text ?? "").split(/\r?\n/);
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

    const attributes = parseAttributes(line.slice(line.indexOf(":") + 1));
    let cursor = index + 1;
    while (cursor < lines.length) {
      const candidate = lines[cursor].trim();
      if (candidate && !candidate.startsWith("#")) break;
      cursor += 1;
    }
    const uri = lines[cursor]?.trim();
    if (!uri) continue;

    variants.push({
      url: resolveUrl(baseUrl, uri),
      bandwidth: Number(attributes.BANDWIDTH) || 0,
      height: resolutionHeight(attributes.RESOLUTION),
      codecs: attributes.CODECS ?? null,
    });
  }

  variants.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth);
  return variants;
}

/**
 * Pedaços e chaves de uma lista simples.
 * @param {string} text
 * @param {string} baseUrl
 * @returns {{segments: Array<{url: string, duration: number, sequence: number, key: any|null}>, initSegments: string[]}}
 */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = String(text ?? "").split(/\r?\n/);
  const segments = [];
  const initSegments = [];

  let sequence = 0;
  let duration = 0;
  let key = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      sequence = Number(line.slice(line.indexOf(":") + 1)) || 0;
      continue;
    }

    if (line.startsWith("#EXT-X-KEY:")) {
      const attributes = parseAttributes(line.slice(line.indexOf(":") + 1));
      const method = String(attributes.METHOD ?? "NONE").toUpperCase();
      key =
        method === "NONE"
          ? null
          : {
              method,
              uri: attributes.URI ? resolveUrl(baseUrl, attributes.URI) : null,
              iv: attributes.IV ?? null,
            };
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      duration = parseFloat(line.slice(8)) || 0;
      continue;
    }

    if (line.startsWith("#EXT-X-MAP:")) {
      const attributes = parseAttributes(line.slice(line.indexOf(":") + 1));
      if (attributes.URI) initSegments.push(resolveUrl(baseUrl, attributes.URI));
      continue;
    }

    if (line.startsWith("#")) continue;

    segments.push({
      url: resolveUrl(baseUrl, line),
      duration,
      sequence: sequence + segments.length,
      key,
    });
    duration = 0;
  }

  return { segments, initSegments };
}

/**
 * Descobre o tipo do arquivo olhando os primeiros bytes.
 * @param {ArrayBuffer[]} parts
 * @returns {"ts"|"mp4"|"bin"}
 */
export function detectContainer(parts) {
  for (const part of parts ?? []) {
    if (!part || part.byteLength < 12) continue;
    const head = new Uint8Array(part, 0, 12);
    if (head[0] === 0x47) return "ts"; // MPEG-TS começa com 0x47 a cada 188 bytes
    const ascii = String.fromCharCode(...head);
    if (ascii.slice(4, 8) === "ftyp") return "mp4";
  }
  return "bin";
}

/**
 * Vetor de inicialização do AES: do `IV=` ou, na falta dele,
 * o número de sequência do pedaço em 16 bytes.
 * @param {{iv?: string|null, sequence?: number}} segment
 * @returns {Uint8Array}
 */
export function ivFor(segment) {
  if (segment?.iv) {
    const hex = String(segment.iv).replace(/^0x/i, "");
    const bytes = new Uint8Array(16);
    for (let index = 0; index < 16; index += 1) {
      bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2) || "0", 16) || 0;
    }
    return bytes;
  }

  const iv = new Uint8Array(16);
  let value = BigInt(segment?.sequence ?? 0);
  for (let index = 15; index >= 0; index -= 1) {
    iv[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return iv;
}

/**
 * Busca texto, com algumas tentativas.
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<string>}
 */
async function fetchText(url, fetchImpl) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, { credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error(`O servidor respondeu ${response.status}.`);
      return await response.text();
    } catch (error) {
      lastError = error;
      await pause(attempt * 400);
    }
  }
  throw new Error(`Não consegui ler a lista de pedaços: ${lastError?.message ?? "erro desconhecido"}`);
}

/**
 * Busca bytes, com algumas tentativas.
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchBuffer(url, fetchImpl) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, { credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error(`O servidor respondeu ${response.status}.`);
      return await response.arrayBuffer();
    } catch (error) {
      lastError = error;
      await pause(attempt * 400);
    }
  }
  throw new Error(`Falha ao baixar um pedaço do vídeo: ${lastError?.message ?? "erro desconhecido"}`);
}

/** @param {number} ms */
function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Descriptografa um pedaço com AES-128.
 * @param {ArrayBuffer} buffer
 * @param {any} segment
 * @param {Map<string, CryptoKey>} keyCache
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<ArrayBuffer>}
 */
async function decryptSegment(buffer, segment, keyCache, fetchImpl) {
  const uri = segment?.key?.uri;
  if (!uri) throw new Error("Pedaço criptografado sem endereço de chave.");

  let key = keyCache.get(uri);
  if (!key) {
    const raw = await fetchBuffer(uri, fetchImpl);
    key = await crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"]);
    keyCache.set(uri, key);
  }

  return crypto.subtle.decrypt({ name: "AES-CBC", iv: ivFor(segment) }, key, buffer);
}

/**
 * Normaliza pedaços: aceita string ou objeto.
 * @param {Array<string|{url: string}>} items
 * @returns {Array<{url: string, key?: any, sequence?: number}>}
 */
function normalizeItems(items) {
  return (items ?? [])
    .map((item) => (typeof item === "string" ? { url: item } : item))
    .filter((item) => item?.url);
}

/**
 * Baixa um inicializador + uma lista de pedaços já conhecida e devolve os
 * bytes na ordem. É o mesmo trabalho do HLS, só que sem lista para interpretar
 * — o LinkedIn entrega as qualidades prontas num bloco de dados.
 * @param {Array<string|{url: string}>} initItems
 * @param {Array<string|{url: string, key?: any, sequence?: number}>} segmentItems
 * @param {{fetchImpl?: typeof fetch, concurrency?: number, maxBytes?: number, onProgress?: (info: {done: number, total: number}) => void}} [options]
 * @returns {Promise<{parts: ArrayBuffer[], container: string, segments: number}>}
 */
export async function downloadParts(initItems, segmentItems, options = {}) {
  const {
    fetchImpl = fetch,
    concurrency = 4,
    maxBytes = 900 * 1024 * 1024,
    onProgress = () => {},
  } = options;

  const inits = normalizeItems(initItems);
  const segments = normalizeItems(segmentItems);
  if (segments.length === 0) throw new Error("Nenhum pedaço para baixar.");

  const keyCache = new Map();
  const head = [];
  let bytes = 0;

  for (const item of inits) {
    const buffer = await fetchBuffer(item.url, fetchImpl);
    head.push(buffer);
    bytes += buffer.byteLength;
  }

  const chunks = new Array(segments.length);
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < segments.length) {
      const index = next;
      next += 1;

      const segment = segments[index];
      let buffer = await fetchBuffer(segment.url, fetchImpl);
      if (segment.key?.method === "AES-128") {
        buffer = await decryptSegment(buffer, segment, keyCache, fetchImpl);
      }

      chunks[index] = buffer;
      bytes += buffer.byteLength;
      if (bytes > maxBytes) throw new Error("O vídeo é grande demais para juntar na memória do navegador.");

      done += 1;
      onProgress({ done, total: segments.length });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, () => worker()));

  return {
    parts: [...head, ...chunks],
    container: detectContainer(head.length > 0 ? head : chunks),
    segments: segments.length,
  };
}

/**
 * Baixa e remonta um vídeo a partir da lista de pedaços.
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, concurrency?: number, maxBytes?: number, onProgress?: (info: {done: number, total: number}) => void}} [options]
 * @returns {Promise<{parts: ArrayBuffer[], container: string, segments: number}>}
 */
export async function downloadHls(url, options = {}) {
  const { fetchImpl = fetch } = options;

  const playlist = await fetchText(url, fetchImpl);
  if (!/^#EXTM3U/i.test(playlist.trim())) {
    throw new Error("O endereço não devolveu uma lista de pedaços válida.");
  }

  let mediaUrl = url;
  let mediaText = playlist;

  if (/#EXT-X-STREAM-INF/i.test(playlist)) {
    const best = parseMasterPlaylist(playlist, url)[0];
    if (!best) throw new Error("A lista de qualidades veio vazia.");
    mediaUrl = best.url;
    mediaText = await fetchText(mediaUrl, fetchImpl);
  }

  const { segments, initSegments } = parseMediaPlaylist(mediaText, mediaUrl);
  if (segments.length === 0) throw new Error("A lista de pedaços veio vazia.");

  return downloadParts(initSegments, segments, options);
}
