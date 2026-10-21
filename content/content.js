/**
 * Content script: acha o vídeo dentro de cada post e coloca o botão de baixar.
 *
 * Este arquivo não importa nada de propósito: content script declarado no
 * manifest não roda como módulo. As poucas funções que ele divide com o resto
 * da extensão (limpar nome, escolher qualidade) estão duplicadas aqui em
 * versão mínima, e é de propósito — mexer no DOM do LinkedIn exige reação
 * rápida, não uma viagem de import.
 */

(() => {
  if (window.__bvlInstalled) return;
  window.__bvlInstalled = true;

  // O LinkedIn carrega centenas de arquivos; o histórico de recursos do
  // navegador guarda só os últimos 250 e pode esquecer justamente o vídeo.
  try {
    performance.setResourceTimingBufferSize?.(2000);
  } catch {
    // sem problema: a captura de rede do serviço em segundo plano cobre isso
  }

  const BUTTON_FLAG = "data-bvl-host";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const DOWNLOAD_PATH =
    "M12 3a1 1 0 0 1 1 1v8.586l2.293-2.293a1 1 0 0 1 1.414 1.414l-4 4a1 1 0 0 1-1.414 0l-4-4a1 1 0 1 1 1.414-1.414L11 12.586V4a1 1 0 0 1 1-1Zm-6 15a1 1 0 0 1 1-1h10a1 1 0 1 1 0 2H7a1 1 0 0 1-1-1Z";

  const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

  // ---------------------------------------------------------------- utilidades

  function decodeEntities(text) {
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

  function kindFromUrl(url, type = "") {
    const text = `${url ?? ""} ${type ?? ""}`.toLowerCase();
    if (/mpegurl|\.m3u8|m3u8-aapl/.test(text)) return "hls";
    if (/dash|\.mpd\b|format=mpd/.test(text)) return "dash";
    if (/\.mp4\b|video\/mp4|fragments\(/.test(text)) return "mp4";
    return "outro";
  }

  function qualityFromHeight(height) {
    if (!height) return null;
    const known = [2160, 1440, 1080, 720, 540, 480, 360, 270, 240, 144];
    return `${known.reduce((best, option) => (Math.abs(option - height) < Math.abs(best - height) ? option : best))}p`;
  }

  function normalize(streams) {
    const seen = new Set();
    const list = [];

    for (const stream of streams) {
      // Lista de pedaços já pronta (bloco do player): não tem um endereço só.
      const isSegments =
        stream?.kind === "segments" && Array.isArray(stream.segments) && stream.segments.length > 0;

      if (!isSegments && (!stream?.url || !/^https?:\/\//i.test(stream.url))) continue;

      const url = isSegments ? stream.segments[0] : String(stream.url).trim();
      const key = isSegments ? `segments:${stream.segments.join("|")}` : url;
      if (seen.has(key)) continue;
      seen.add(key);

      const kind = isSegments ? "segments" : stream.kind ?? kindFromUrl(url);
      if (kind === "dash") continue;

      const height = Number(stream.height) || null;
      const quality = qualityFromHeight(height);
      const what = kind === "hls" ? "pedaços" : kind === "segments" ? "completo" : "arquivo inteiro";
      const parts = [quality, what];
      if (stream.bitrate >= 1_000_000) parts.push(`${(stream.bitrate / 1_000_000).toFixed(1).replace(".", ",")} Mbps`);

      list.push({
        url,
        kind,
        height,
        quality,
        bitrate: Number(stream.bitrate) || 0,
        label: parts.filter(Boolean).join(" · "),
        ...(isSegments ? { init: stream.init ?? null, segments: stream.segments } : {}),
      });
    }

    const rank = { mp4: 0, segments: 0, hls: 1, outro: 2 };
    list.sort(
      (a, b) =>
        (b.height ?? 0) - (a.height ?? 0) ||
        (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) ||
        b.bitrate - a.bitrate
    );
    return list;
  }

  function pickStream(streams, preferred = "best") {
    if (!streams?.length) return null;
    if (!preferred || preferred === "best") return streams[0];
    const exact = streams.find((stream) => stream.quality === preferred);
    if (exact) return exact;
    const target = Number(String(preferred).replace(/\D/g, "")) || 0;
    if (target <= 0) return streams[0];
    return streams.find((stream) => (stream.height ?? 0) <= target) ?? streams[streams.length - 1];
  }

  // ------------------------------------------------------- bloco do player (VHS)

  // O LinkedIn não deixa `<video data-sources>`. Ele embute na página um bloco
  // `data:application/vnd.videojs.vhs+json,{...}` com todas as qualidades e o
  // endereço assinado de cada pedaço de ~4 segundos. É daí que sai o vídeo.
  const VHS_MARKER = "data:application/vnd.videojs.vhs+json,";

  function segmentsFromManifest(manifest) {
    const playlists = Array.isArray(manifest?.playlists) ? manifest.playlists : [];
    const candidates = [];

    for (const playlist of playlists) {
      const entries = Array.isArray(playlist?.segments) ? playlist.segments : [];
      const urls = entries
        .map((entry) => entry?.uri)
        .filter((url) => typeof url === "string" && url.startsWith("http"));
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
      });
    }

    // AV1 no mesmo tamanho do H.264 só atrapalha: menos players abrem.
    const h264Heights = new Set(
      candidates.filter((item) => /avc1/i.test(item.codecs)).map((item) => item.height)
    );
    const seen = new Set();
    return candidates.filter((item) => {
      if (!/avc1/i.test(item.codecs) && h264Heights.has(item.height)) return false;
      const key = `${item.height}|${item.segments.join("|")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Recorta o bloco: pode vir escapado (string de JS) ou cru (atributo src). */
  function readPayload(source, start) {
    let cursor = start;
    let raw = "";

    if (source[cursor] === "%") {
      while (cursor < source.length) {
        const char = source[cursor];
        if (char === '"' || char === "'" || char === "<" || char === "\n" || char === " ") break;
        raw += char;
        cursor += 1;
      }
      return { raw, next: cursor };
    }

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

  /** Lê todos os blocos VHS de um texto (atributo do player ou HTML da página). */
  function vhsStreamsFrom(text) {
    const source = String(text ?? "");
    const out = [];
    let index = 0;

    while (index < source.length) {
      const at = source.indexOf(VHS_MARKER, index);
      if (at === -1) break;

      const start = at + VHS_MARKER.length;
      const { raw, next } = readPayload(source, start);

      if (raw.length > 0) {
        let json = raw
          .replace(/\\u0026/gi, "&")
          .replace(/\\"/g, '"')
          .replace(/\\\//g, "/")
          .replace(/&quot;|&#34;/gi, '"')
          .replace(/&amp;/g, "&");
        if (json.startsWith("%7B")) {
          try {
            json = decodeURIComponent(json);
          } catch {
            // payload em outro formato: ignora
          }
        }
        try {
          out.push(...segmentsFromManifest(JSON.parse(json)));
        } catch {
          // bloco cortado ou em formato novo: segue procurando
        }
      }

      index = next > start ? next : start;
    }

    return out;
  }

  // ------------------------------------------------------- extrair os endereços

  function streamsFromVideoElement(video) {
    const out = [];

    // Caminho que o LinkedIn usa: o bloco do player vai no próprio src.
    for (const candidate of [video.getAttribute?.("src"), video.src, video.currentSrc]) {
      if (typeof candidate === "string" && candidate.startsWith(VHS_MARKER)) {
        out.push(...vhsStreamsFrom(candidate));
      }
    }

    const raw = video.getAttribute?.("data-sources");
    if (raw) {
      try {
        const parsed = JSON.parse(decodeEntities(raw));
        if (Array.isArray(parsed)) {
          for (const source of parsed) {
            const url = source?.src ?? source?.url ?? null;
            if (!url) continue;
            out.push({
              url,
              kind: kindFromUrl(url, source?.type ?? ""),
              width: Number(source?.width) || null,
              height: Number(source?.height) || null,
              bitrate: Number(source?.["data-bitrate"]) || 0,
            });
          }
        }
      } catch {
        // atributo em outro formato: segue para as outras pistas
      }
    }

    // Alguns players usam <source src="..."> em vez do atributo.
    for (const source of video.querySelectorAll?.("source[src]") ?? []) {
      const src = source.getAttribute("src");
      if (!src || src.startsWith("blob:")) continue;
      out.push({ url: src, kind: kindFromUrl(src, source.getAttribute("type") ?? ""), height: null, bitrate: 0 });
    }

    return out;
  }

  function holdMedia(node, found, depth) {
    if (!node || typeof node !== "object" || depth > 14 || found.length >= 6) return;
    if (!Array.isArray(node) && (node.progressiveStreams || node.adaptiveStreams)) {
      found.push(node);
      return;
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      holdMedia(child, found, depth + 1);
    }
  }

  function streamsFromHolder(holder) {
    const out = [];

    for (const stream of holder.progressiveStreams ?? []) {
      const url = stream?.streamingLocations?.find?.((item) => item?.url)?.url ?? stream?.url ?? null;
      if (!url) continue;
      out.push({
        url,
        kind: "mp4",
        width: Number(stream?.width) || null,
        height: Number(stream?.height) || null,
        bitrate: Number(stream?.bitRate) || 0,
      });
    }

    for (const stream of holder.adaptiveStreams ?? []) {
      const first = Array.isArray(stream?.masterPlaylists)
        ? stream.masterPlaylists.find((item) => (typeof item === "string" ? item : item?.url))
        : null;
      const url = typeof first === "string" ? first : first?.url ?? null;
      if (!url) continue;
      out.push({ url, kind: String(stream?.protocol ?? "").toUpperCase() === "DASH" ? "dash" : "hls", height: null, bitrate: 0 });
    }

    return out;
  }

  function streamsFromCodes(root) {
    const out = [];
    for (const code of root.querySelectorAll("code")) {
      const text = (code.textContent ?? "").trim();
      if (!text.startsWith("{") && !text.startsWith("[")) continue;

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }

      const holders = [];
      holdMedia(data, holders, 0);
      for (const holder of holders) out.push(...streamsFromHolder(holder));
    }
    return out;
  }

  const CONTAINER_SELECTOR =
    '[data-id^="urn:li:"], [data-urn^="urn:li:"], .feed-shared-update-v2, article, li';

  function containerFor(node) {
    return node?.closest?.(CONTAINER_SELECTOR) ?? node?.parentElement ?? document.body;
  }

  function postIdFor(container) {
    const raw = container?.getAttribute?.("data-id") ?? container?.getAttribute?.("data-urn") ?? "";
    const match = /(\d{15,25})/.exec(raw) ?? /[_-](\d{15,25})(?:[_-]|[/?#]|$)/.exec(location.pathname + location.href);
    return match ? match[1] : null;
  }

  function authorFor(container) {
    const link = container?.querySelector?.('a[href*="/in/"], a[href*="/company/"]');
    const href = link?.getAttribute("href") ?? "";
    const match = /\/(?:in|company)\/([^/?#]+)/.exec(href);
    if (match) return match[1];
    const fromUrl = /\/posts\/([^/?#_]+)/.exec(location.href);
    return fromUrl ? fromUrl[1] : null;
  }

  /**
   * Junta todas as pistas de um vídeo: atributo do player, dados do post e,
   * se não houver nada no post, a varredura da página inteira.
   * @param {Element|null} element player, bloco com data-sources, ou null
   */
  function collect(element) {
    const video = element?.tagName === "VIDEO" ? element : element?.querySelector?.("video") ?? null;
    const anchor = video ?? element ?? null;
    const container = anchor ? containerFor(anchor) : document.body;

    const streams = [];
    if (video) streams.push(...streamsFromVideoElement(video));
    if (element?.getAttribute?.("data-sources")) streams.push(...streamsFromVideoElement(element));
    if (container) streams.push(...streamsFromCodes(container));

    const normalized = normalize(streams);
    return {
      streams: normalized.length > 0 ? normalized : pageStreams(),
      postId: postIdFor(container),
      author: authorFor(container),
      url: location.href,
      counts: counts(),
    };
  }

  /** Endereços de vídeo que a própria página já pediu (sem precisar de HTML). */
  function networkStreams() {
    const out = [];
    const whole = /(\.m3u8|playlist\/vid\/|\.mp4(\?|$))/i;
    // `.../2/1792507391280` é um pedaço de ~4 segundos, não um vídeo.
    const segment = /(Fragments\(|QualityLevels\(|\.ts(\?|$)|\.m4s(\?|$)|init\.mp4|playlist\/vid\/[^?]*\/\d+\/\d+(\?|$))/i;

    for (const entry of performance.getEntriesByType("resource")) {
      const url = entry.name;
      if (!url || !whole.test(url) || segment.test(url)) continue;
      out.push({ url, kind: kindFromUrl(url), height: null, bitrate: 0 });
    }
    return out;
  }

  // Ler o HTML inteiro custa caro; guarda o resultado por um tempo.
  let htmlScanAt = 0;
  let htmlScanStreams = [];

  function htmlStreams() {
    if (Date.now() - htmlScanAt < 10_000) return htmlScanStreams;
    htmlScanAt = Date.now();
    try {
      htmlScanStreams = vhsStreamsFrom(document.documentElement.outerHTML);
    } catch {
      htmlScanStreams = [];
    }
    return htmlScanStreams;
  }

  /** Varre a página inteira sem depender de achar o player. */
  function pageStreams() {
    const found = [];

    for (const element of document.querySelectorAll("video, [data-sources]")) {
      found.push(...streamsFromVideoElement(element));
    }
    found.push(...streamsFromCodes(document));
    found.push(...htmlStreams());
    found.push(...networkStreams());

    return normalize(found);
  }

  function counts() {
    const frames = [...document.querySelectorAll("iframe")].filter((frame) =>
      /youtube|vimeo|dailymotion|wistia/i.test(frame.getAttribute("src") ?? "")
    ).length;

    return {
      videos: document.querySelectorAll("video").length,
      payloads: document.querySelectorAll("[data-sources]").length,
      codes: document.querySelectorAll("code").length,
      frames,
    };
  }

  /** O vídeo "principal" da página: o maior que está à vista. */
  function mainVideo() {
    const videos = [...document.querySelectorAll("video")];
    if (videos.length === 0) return null;

    const visible = videos.filter((video) => {
      const rect = video.getBoundingClientRect();
      return rect.width > 120 && rect.height > 80;
    });

    // Post com vídeo "de capa": o player só existe depois do clique, e aí
    // qualquer vídeo da página serve de referência.
    const pool = visible.length > 0 ? visible : videos;

    return pool.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    })[0];
  }

  // ------------------------------------------------------------------- conversa

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return { ok: false, error: "Extensão recarregada. Recarregue a página do LinkedIn." };
    }
  }

  async function settings() {
    const stored = await chrome.storage.sync.get({ quality: "best", saveAs: false }).catch(() => ({}));
    return { quality: stored?.quality ?? "best", saveAs: Boolean(stored?.saveAs) };
  }

  // ------------------------------------------------------------------- feedback

  let toastTimer = null;

  function toast(text, kind = "info") {
    let node = document.querySelector("[data-bvl-toast]");
    if (!node) {
      node = document.createElement("div");
      node.setAttribute("data-bvl-toast", "");
      document.body.append(node);
    }
    node.textContent = text;
    node.className = `bvl-toast bvl-toast--${kind} bvl-toast--on`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("bvl-toast--on"), 5200);
  }

  function setBusy(button, busy) {
    button.classList.toggle("is-busy", busy);
    button.disabled = busy;
  }

  // ------------------------------------------------- gravar em tempo real (reserva)

  function pickRecorderMime() {
    const options = [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm",
    ];
    return options.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) ?? "";
  }

  /**
   * Última saída quando o vídeo só existe em pedaços protegidos: toca o vídeo
   * do começo ao fim e grava a imagem que está na tela.
   * Demora o tempo do vídeo, mas funciona sempre.
   */
  async function recordVideo(video, filenameBase) {
    const stream = video.captureStream?.() ?? video.mozCaptureStream?.();
    if (!stream) throw new Error("Este navegador não deixa gravar o vídeo em tempo real.");

    const mime = pickRecorderMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };

    const finished = new Promise((resolve) => {
      recorder.onstop = resolve;
    });

    video.muted = false;
    video.currentTime = 0;
    recorder.start(1000);
    await video.play().catch(() => {});

    const limit = Number.isFinite(video.duration) ? video.duration * 1000 + 4000 : 20 * 60 * 1000;
    await new Promise((resolve) => {
      video.addEventListener("ended", resolve, { once: true });
      setTimeout(resolve, limit);
    });

    recorder.stop();
    await finished;

    const extension = mime.includes("mp4") ? "mp4" : "webm";
    const blob = new Blob(chunks, { type: mime || "video/webm" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${filenameBase}.${extension}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);

    return { filename: link.download, bytes: blob.size };
  }

  // ------------------------------------------------------------------- download

  async function handleClick(button, element) {
    const video = element.tagName === "VIDEO" ? element : element.querySelector?.("video");
    const context = collect(element);

    // Nada no HTML? Então usa o que a página pediu na rede ao tocar o vídeo.
    if (context.streams.length === 0) {
      const captured = await send({ type: "captured" });
      context.streams = normalize(
        (captured?.items ?? []).map((url) => ({ url, kind: kindFromUrl(url), height: null, bitrate: 0 }))
      );
    }

    if (context.streams.length === 0) {
      toast("Não achei o arquivo deste vídeo. Dê play nele por 2 segundos e clique de novo.", "error");
      return;
    }

    if (button.dataset.bvlFallback === "1") {
      if (!video) {
        toast("Dê play no vídeo e tente de novo — a gravação precisa dele tocando.", "error");
        return;
      }
      setBusy(button, true);
      toast("Gravando em tempo real… não feche a aba até o vídeo terminar.", "ok");
      try {
        const base = `linkedin-${context.author ?? "video"}-${context.postId ?? Date.now()}`;
        const result = await recordVideo(video, base);
        toast(`Gravação salva: ${result.filename}`, "ok");
        delete button.dataset.bvlFallback;
      } catch (error) {
        toast(error?.message || "A gravação falhou.", "error");
      } finally {
        setBusy(button, false);
      }
      return;
    }

    const prefs = await settings();
    const stream = pickStream(context.streams, prefs.quality);
    if (!stream) {
      toast("Nenhuma qualidade disponível.", "error");
      return;
    }

    setBusy(button, true);
    const response = await send({
      type: "download",
      url: stream.url,
      kind: stream.kind,
      init: stream.init ?? null,
      segments: stream.segments ?? null,
      quality: stream.quality,
      author: context.author,
      postId: context.postId,
    });
    setBusy(button, false);

    if (!response?.ok) {
      button.dataset.bvlFallback = "1";
      toast(
        `${response?.error || "Falha no download."} — clique de novo para gravar em tempo real.`,
        "error"
      );
      return;
    }

    toast(
      response.mode === "montagem"
        ? "Juntando os pedaços… o arquivo aparece na pasta de downloads quando terminar."
        : "Download iniciado. Veja a lista de downloads do Chrome.",
      "ok"
    );
  }

  // ---------------------------------------------------------------------- botão

  function makeIcon(size = 18) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", DOWNLOAD_PATH);
    path.setAttribute("fill", "currentColor");
    svg.append(path);
    return svg;
  }

  function decorate(element) {
    const host = element.parentElement;
    if (!host || host.querySelector(`[${BUTTON_FLAG}]`)) return;
    if (collect(element).streams.length === 0) return;

    if (getComputedStyle(host).position === "static") host.style.position = "relative";

    const button = document.createElement("button");
    button.setAttribute(BUTTON_FLAG, "");
    button.type = "button";
    button.className = "bvl-overlay";
    button.title = "Baixar este vídeo (Baixa Vídeo LinkedIn)";
    button.setAttribute("aria-label", "Baixar vídeo");
    button.append(makeIcon());

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handleClick(button, element);
    });

    host.append(button);
  }

  function scan() {
    for (const element of document.querySelectorAll("video, [data-sources]")) {
      if (element.closest(`[${BUTTON_FLAG}]`)) continue;
      decorate(element);
    }
  }

  // ------------------------------------------------------------ contexto da aba

  let lastReported = null;

  function reportContext() {
    const context = collect(mainVideo());
    if (context.streams.length === 0) return;
    const key = `${context.postId}|${context.streams.length}`;
    if (key === lastReported) return;
    lastReported = key;

    const pending = chrome.runtime.sendMessage({
      type: "tabContext",
      postId: context.postId,
      author: context.author,
      count: context.streams.length,
      url: location.href,
    });
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "bvl:list") return false;

    const video = mainVideo();
    const context = collect(video);

    sendResponse({ ok: true, ...context });
    return false;
  });

  // ---------------------------------------------------------------- ciclo de vida

  // O LinkedIn mexe no DOM o tempo todo (rolagem infinita, reações, vídeo
  // carregando). Uma passada por quadro seria desperdício: 300 ms resolve.
  let scheduled = false;
  let timer = null;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      scheduled = false;
      try {
        scan();
        reportContext();
      } catch {
        // DOM no meio de uma troca de tela: a próxima passada resolve
      }
    }, 300);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastReported = null;
      schedule();
    }
  }, 900);

  schedule();
})();
