/**
 * Link, identificação do post e nome de arquivo.
 *
 * O LinkedIn usa vários formatos de endereço para o mesmo post:
 *   /posts/<autor>_<texto>-ugcPost-7518320846965379072-xz_U/
 *   /feed/update/urn:li:activity:7518320846965379072/
 *   /feed/update/urn:li:ugcPost:7518320846965379072/
 * Todos carregam o mesmo número no fim, e é ele que interessa.
 */

/**
 * Extrai o número do post de um link (ou de um texto qualquer que o contenha).
 * @param {string|null|undefined} input
 * @returns {string|null}
 */
export function parsePostId(input) {
  if (!input) return null;
  const text = String(input);
  const patterns = [
    /urn:li:(?:activity|ugcPost|share):(\d{15,25})/i,
    /(?:activity|ugcPost|share)[:-](\d{15,25})/i,
    /(?:status|update)\/(\d{15,25})/i,
    /[_-](\d{15,25})(?:[_-]|[/?#]|$)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[1];
  }
  return null;
}

/**
 * Nome do autor a partir do endereço, quando não dá para ler da página.
 * Em `/posts/matthieulorrain_from-one-world...` o autor é o pedaço antes do "_".
 * @param {string|null|undefined} input
 * @returns {string|null}
 */
export function parseAuthorFromUrl(input) {
  if (!input) return null;
  const text = String(input);

  const posts = /\/posts\/([^/?#]+)/i.exec(text);
  if (posts) {
    const slug = posts[1];
    const head = slug.split("_")[0];
    // Slug de autor não costuma ter hífen; se tiver, o "_" já resolveu.
    if (head && /^[a-z0-9-]{2,80}$/i.test(head)) return head;
  }

  const profile = /\/(?:in|company|school)\/([^/?#]+)/i.exec(text);
  if (profile) return profile[1];

  return null;
}

/**
 * Transforma uma altura em pixels num rótulo curto ("720p").
 * @param {number|null|undefined} height
 * @returns {string|null}
 */
export function qualityFromHeight(height) {
  if (!height) return null;
  const known = [2160, 1440, 1080, 720, 540, 480, 360, 270, 240, 144];
  const closest = known.reduce((best, option) =>
    Math.abs(option - height) < Math.abs(best - height) ? option : best
  );
  return `${closest}p`;
}

/**
 * Nome de arquivo seguro, legível e ordenável.
 * @param {{author?: string|null, postId?: string|null, quality?: string|null, extension?: string, index?: number, total?: number}} options
 * @returns {string}
 */
export function buildFilename(options = {}) {
  const { author, postId, quality, extension = "mp4", index = 0, total = 1 } = options;
  const who = author ? `${author}-` : "";
  const qualityPart = quality ? `-${quality}` : "";
  const orderPart = total > 1 ? `-${index + 1}` : "";
  const raw = `linkedin-${who}${postId ?? "video"}${orderPart}${qualityPart}.${extension}`;
  return raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .slice(0, 150);
}

/**
 * Mantém só endereços que valem a pena tentar (http/https).
 * @param {string} url
 * @returns {boolean}
 */
export function isDownloadableUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim());
}

/**
 * Endereço limpo: tira os parâmetros de rastreio que não mudam a página.
 * @param {string} input
 * @returns {string}
 */
export function cleanPostUrl(input) {
  try {
    const url = new URL(input);
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "rcm", "trk", "trackingId"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return String(input ?? "");
  }
}
