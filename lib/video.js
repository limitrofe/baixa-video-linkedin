/**
 * Achar os endereços de vídeo escondidos na página do LinkedIn.
 *
 * O LinkedIn guarda o vídeo em dois lugares diferentes, e a versão da página
 * decide qual dos dois aparece:
 *
 * 1. Na própria etiqueta do player: `<video data-sources='[{"src": "..."}]'>`.
 *    Pode ser um MP4 inteiro ou uma "lista de pedaços" (.m3u8).
 * 2. Num bloco de dados `<code>` com um JSON grande, contendo
 *    `progressiveStreams` (MP4 prontos) e `adaptiveStreams` (listas de pedaços).
 *
 * Quando o MP4 inteiro existe, ele é sempre a melhor escolha: um arquivo só,
 * com som e imagem juntos, e o download vai direto para o Chrome.
 */

import { isDownloadableUrl, qualityFromHeight } from "./links.js";

/** Entidades que aparecem nos valores de atributo vindos do HTML cru. */
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * Desfaz `&quot;`, `&amp;`, `&#x27;` etc.
 * Quando o valor vem do DOM (`getAttribute`), já está desfeito — rodar de novo
 * não estraga nada.
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
  return String(text ?? "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, code) => {
    const key = code.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)) return NAMED_ENTITIES[key];
    try {
      if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
      if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
    } catch {
      return whole;
    }
    return whole;
  });
}

/**
 * Classifica o endereço: arquivo inteiro, lista de pedaços ou outro protocolo.
 * @param {string} url
 * @param {string} [type]
 * @returns {"mp4"|"hls"|"dash"|"outro"}
 */
export function kindFromUrl(url, type = "") {
  const text = `${url ?? ""} ${type ?? ""}`.toLowerCase();
  if (/mpegurl|\.m3u8|m3u8-aapl/.test(text)) return "hls";
  if (/dash|\.mpd\b|manifest\(format=mpd/.test(text)) return "dash";
  if (/\.mp4\b|video\/mp4|fragments\(/.test(text)) return "mp4";
  return "outro";
}

/**
 * Lê o atributo `data-sources` do player.
 * @param {string} raw
 * @returns {Array<object>}
 */
export function streamsFromDataSources(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(decodeEntities(raw));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((source) => {
      const url = source?.src ?? source?.url ?? null;
      if (!isDownloadableUrl(url)) return null;
      return {
        url,
        kind: kindFromUrl(url, source?.type ?? ""),
        width: Number(source?.width) || null,
        height: Number(source?.height) || null,
        bitrate: Number(source?.["data-bitrate"] ?? source?.bitrate) || 0,
        origin: "player",
      };
    })
    .filter(Boolean);
}

/**
 * Procura, dentro de um JSON qualquer, os objetos que guardam as mídias.
 * @param {unknown} root
 * @returns {Array<any>}
 */
export function findMediaHolders(root) {
  const found = [];
  const seen = new Set();

  function walk(node, depth) {
    if (!node || typeof node !== "object" || depth > 14 || found.length >= 6) return;
    if (seen.has(node)) return;
    seen.add(node);

    if (!Array.isArray(node) && (node.progressiveStreams || node.adaptiveStreams)) {
      found.push(node);
      return;
    }
    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) walk(child, depth + 1);
  }

  walk(root, 0);
  return found;
}

/**
 * Converte um bloco `progressiveStreams`/`adaptiveStreams` em endereços.
 * @param {any} holder
 * @returns {Array<object>}
 */
export function streamsFromHolder(holder) {
  const out = [];

  for (const stream of holder?.progressiveStreams ?? []) {
    const url = stream?.streamingLocations?.find?.((item) => item?.url)?.url ?? stream?.url ?? null;
    if (!isDownloadableUrl(url)) continue;
    out.push({
      url,
      kind: "mp4",
      width: Number(stream?.width) || null,
      height: Number(stream?.height) || null,
      bitrate: Number(stream?.bitRate) || 0,
      origin: "dados",
    });
  }

  for (const stream of holder?.adaptiveStreams ?? []) {
    const first = Array.isArray(stream?.masterPlaylists)
      ? stream.masterPlaylists.find((item) => (typeof item === "string" ? item : item?.url))
      : null;
    const url = typeof first === "string" ? first : first?.url ?? null;
    if (!isDownloadableUrl(url)) continue;
    const protocol = String(stream?.protocol ?? "").toUpperCase();
    out.push({
      url,
      kind: protocol === "DASH" ? "dash" : "hls",
      width: null,
      height: null,
      bitrate: 0,
      origin: "dados",
    });
  }

  return out;
}

/**
 * Junta tudo, tira repetido e ordena do melhor para o pior.
 * MP4 inteiro sempre antes das listas de pedaços.
 * @param {Array<object>} streams
 * @returns {Array<object>}
 */
export function normalizeStreams(streams) {
  const seen = new Set();
  const list = [];

  for (const stream of streams ?? []) {
    if (!stream || !isDownloadableUrl(stream.url)) continue;
    const url = stream.url.trim();
    if (seen.has(url)) continue;
    seen.add(url);

    const kind = stream.kind ?? kindFromUrl(url);
    if (kind === "dash") continue; // o remontador trata HLS; DASH fica de fora

    const height = Number(stream.height) || null;
    const quality = qualityFromHeight(height);
    const label = labelFor({ kind, quality, bitrate: stream.bitrate });
    list.push({ url, kind, width: stream.width ?? null, height, quality, bitrate: Number(stream.bitrate) || 0, label, origin: stream.origin ?? null });
  }

  const rank = { mp4: 0, hls: 1, outro: 2 };
  list.sort((a, b) => {
    const byHeight = (b.height ?? 0) - (a.height ?? 0);
    if (byHeight !== 0) return byHeight;
    const byKind = (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9);
    if (byKind !== 0) return byKind;
    return b.bitrate - a.bitrate;
  });

  return list;
}

/**
 * Texto curto para o botão ("1080p · 4,2 Mbps" ou "Pedacos").
 * @param {{kind: string, quality?: string|null, bitrate?: number}} stream
 * @returns {string}
 */
export function labelFor(stream) {
  const parts = [];
  if (stream.quality) parts.push(stream.quality);
  if (stream.kind === "mp4") parts.push("arquivo inteiro");
  else if (stream.kind === "hls") parts.push("pedaços");
  if (stream.bitrate >= 1_000_000) {
    parts.push(`${(stream.bitrate / 1_000_000).toFixed(1).replace(".", ",")} Mbps`);
  }
  return parts.length ? parts.join(" · ") : "vídeo";
}

/**
 * Lê uma página inteira (HTML cru) e devolve os vídeos que encontrar.
 * Funciona no service worker, onde não existe DOMParser.
 * @param {string} html
 * @returns {Array<object>}
 */
export function parseHtml(html) {
  const text = String(html ?? "");
  const streams = [];

  // 1. Etiquetas <video data-sources="...">
  for (const match of text.matchAll(/<video\b[^>]*>/gi)) {
    const raw = attributeValue(match[0], "data-sources");
    if (raw) streams.push(...streamsFromDataSources(raw));
  }

  // 2. Blocos <code> com o JSON das mídias
  for (const match of text.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)) {
    const inner = decodeEntities(match[1]).trim();
    if (!inner.startsWith("{") && !inner.startsWith("[")) continue;
    let data;
    try {
      data = JSON.parse(inner);
    } catch {
      continue;
    }
    for (const holder of findMediaHolders(data)) {
      streams.push(...streamsFromHolder(holder));
    }
  }

  return normalizeStreams(streams);
}

/**
 * Valor de um atributo dentro do texto de uma etiqueta.
 * @param {string} tag
 * @param {string} name
 * @returns {string|null}
 */
export function attributeValue(tag, name) {
  const pattern = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const match = pattern.exec(tag);
  if (!match) return null;
  return match[2] ?? match[3] ?? null;
}

/**
 * Escolhe o vídeo a baixar conforme a qualidade preferida.
 * @param {Array<object>} streams
 * @param {string} [preferred] "best" ou "720p" etc.
 * @returns {object|null}
 */
export function pickStream(streams, preferred = "best") {
  if (!Array.isArray(streams) || streams.length === 0) return null;
  if (!preferred || preferred === "best") return streams[0];

  const exact = streams.find((stream) => stream.quality === preferred);
  if (exact) return exact;

  const target = Number(String(preferred).replace(/\D/g, "")) || 0;
  if (target <= 0) return streams[0];
  const below = streams.filter((stream) => (stream.height ?? 0) <= target);
  return below[0] ?? streams[streams.length - 1];
}
