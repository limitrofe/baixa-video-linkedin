/**
 * Leitor do formato Video.js/VHS — o que o LinkedIn usa de verdade.
 *
 * O player não deixa `<video data-sources>` na página. Ele embute um bloco
 * assim, com todas as qualidades e os endereços assinados de cada pedaço:
 *
 *   data:application/vnd.videojs.vhs+json,{"duration":50.3,"playlists":[
 *     {"attributes":{"RESOLUTION":{"width":1280,"height":720},...},
 *      "segments":[{"uri":"https://dms.licdn.com/playlist/vid/.../2/...",
 *                   "map":{"uri":"https://dms.licdn.com/.../1/..."}}]}]}
 *
 * Cada "segment" é um pedaço de ~4 segundos; o `map` do primeiro é o
 * inicializador do arquivo. Juntando inicializador + pedaços na ordem, sai um
 * MP4 completo — sem reencode, sem perda.
 */

export const VHS_MARKER = "data:application/vnd.videojs.vhs+json,";

/**
 * Descobre onde o bloco termina e devolve o texto cru.
 * Existem dois jeitos de o mesmo JSON aparecer:
 *   - dentro de uma string de JS: `{\"duration\":50}` (aspas escapadas)
 *   - num atributo/`src`: `{"duration":50}` (aspas cruas)
 * @param {string} source
 * @param {number} start
 * @returns {{raw: string, next: number}}
 */
function readPayload(source, start) {
  let cursor = start;
  let raw = "";

  // Percent-encoded: vai até o fim do atributo.
  if (source[cursor] === "%") {
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === '"' || char === "'" || char === "<" || char === "\n" || char === " ") break;
      raw += char;
      cursor += 1;
    }
    return { raw, next: cursor };
  }

  // JSON escapado dentro de uma string: termina na aspa crua.
  if (source[cursor] === "{" && source[cursor + 1] === "\\") {
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === "\\") {
        raw += char + (source[cursor + 1] ?? "");
        cursor += 2;
        continue;
      }
      if (char === '"' || char === "'" || char === "<" || char === "\n") break;
      raw += char;
      cursor += 1;
    }
    return { raw, next: cursor };
  }

  // JSON cru: conta chaves, sem se perder nas aspas de dentro dos textos.
  let depth = 0;
  let inString = false;

  while (cursor < source.length) {
    const char = source[cursor];
    raw += char;
    cursor += 1;

    if (inString) {
      if (char === "\\") {
        raw += source[cursor] ?? "";
        cursor += 1;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }

  return { raw, next: cursor };
}

/**
 * Acha todos os blocos VHS dentro de um texto (HTML, string de JS, atributo).
 * @param {string} text
 * @returns {string[]} payloads crus, ainda escapados
 */
export function scanVhsPayloads(text) {
  const source = String(text ?? "");
  const out = [];
  let index = 0;

  while (index < source.length) {
    const at = source.indexOf(VHS_MARKER, index);
    if (at === -1) break;

    const start = at + VHS_MARKER.length;
    const { raw, next } = readPayload(source, start);

    if (raw.length > 0) out.push(raw);
    index = next > start ? next : start;
  }

  return out;
}

/**
 * Desfaz os escapes e transforma o payload em objeto.
 * @param {string} raw
 * @returns {any|null}
 */
export function decodeVhsPayload(raw) {
  let text = String(raw ?? "")
    .replace(/\\u0026/gi, "&")
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&amp;/g, "&");

  if (text.startsWith("%7B")) {
    try {
      text = decodeURIComponent(text);
    } catch {
      return null;
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Converte o manifesto em "arquivos" selecionáveis.
 * @param {any} manifest
 * @returns {Array<object>}
 */
export function streamsFromVhs(manifest) {
  const playlists = Array.isArray(manifest?.playlists) ? manifest.playlists : [];
  const candidates = [];

  for (const playlist of playlists) {
    const entries = Array.isArray(playlist?.segments) ? playlist.segments : [];
    const urls = entries.map((entry) => entry?.uri).filter((url) => typeof url === "string" && url.startsWith("http"));
    if (urls.length === 0) continue;

    const init = entries[0]?.map?.uri ?? null;
    // Em algumas qualidades o primeiro "pedaço" é o próprio inicializador.
    const segments = urls.filter((url) => url !== init);
    if (segments.length === 0) continue;

    const attributes = playlist?.attributes ?? {};
    candidates.push({
      kind: "segments",
      init,
      segments,
      url: segments[0],
      width: Number(attributes?.RESOLUTION?.width) || null,
      height: Number(attributes?.RESOLUTION?.height) || null,
      bitrate: Number(attributes?.BANDWIDTH) || 0,
      codecs: String(attributes?.CODECS ?? ""),
      origin: "player",
    });
  }

  // AV1 no mesmo tamanho do H.264 só atrapalha: menos players abrem o arquivo.
  const h264Heights = new Set(
    candidates.filter((item) => /avc1/i.test(item.codecs)).map((item) => item.height)
  );
  const preferred = candidates.filter(
    (item) => /avc1/i.test(item.codecs) || !h264Heights.has(item.height)
  );

  // Sem repetir a mesma lista de pedaços.
  const seen = new Set();
  return preferred.filter((item) => {
    const key = `${item.height}|${item.segments.join("|")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Atalho: texto cru -> arquivos.
 * @param {string} text
 * @returns {Array<object>}
 */
export function vhsStreamsFrom(text) {
  const out = [];
  for (const raw of scanVhsPayloads(text)) {
    const manifest = decodeVhsPayload(raw);
    if (manifest) out.push(...streamsFromVhs(manifest));
  }
  return out;
}
