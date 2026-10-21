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
      if (!stream?.url || !/^https?:\/\//i.test(stream.url)) continue;
      const url = stream.url.trim();
      if (seen.has(url)) continue;
      seen.add(url);

      const kind = stream.kind ?? kindFromUrl(url);
      if (kind === "dash") continue;

      const height = Number(stream.height) || null;
      const quality = qualityFromHeight(height);
      const parts = [quality, kind === "hls" ? "pedaços" : "arquivo inteiro"];
      if (stream.bitrate >= 1_000_000) parts.push(`${(stream.bitrate / 1_000_000).toFixed(1).replace(".", ",")} Mbps`);

      list.push({
        url,
        kind,
        height,
        quality,
        bitrate: Number(stream.bitrate) || 0,
        label: parts.filter(Boolean).join(" · "),
      });
    }

    const rank = { mp4: 0, hls: 1, outro: 2 };
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

  // ------------------------------------------------------- extrair os endereços

  function streamsFromVideoElement(video) {
    const raw = video.getAttribute("data-sources");
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
        if (!url) return null;
        return {
          url,
          kind: kindFromUrl(url, source?.type ?? ""),
          width: Number(source?.width) || null,
          height: Number(source?.height) || null,
          bitrate: Number(source?.["data-bitrate"]) || 0,
        };
      })
      .filter(Boolean);
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

  function containerFor(video) {
    return (
      video.closest('[data-id^="urn:li:"], [data-urn^="urn:li:"], .feed-shared-update-v2, article, li') ??
      video.parentElement
    );
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
   */
  function collect(video) {
    const container = containerFor(video);
    const streams = [...streamsFromVideoElement(video), ...streamsFromCodes(container)];
    if (streams.length === 0) streams.push(...streamsFromCodes(document));

    return {
      streams: normalize(streams),
      postId: postIdFor(container),
      author: authorFor(container),
      url: location.href,
    };
  }

  /** O vídeo "principal" da página: o maior que está à vista. */
  function mainVideo() {
    const videos = [...document.querySelectorAll("video")].filter((video) => {
      const rect = video.getBoundingClientRect();
      return rect.width > 120 && rect.height > 80;
    });
    if (videos.length === 0) return null;
    return videos.sort((a, b) => {
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

  async function handleClick(button, video) {
    const context = collect(video);
    if (context.streams.length === 0) {
      toast("Não achei o endereço deste vídeo. Role a página até ele aparecer e tente de novo.", "error");
      return;
    }

    if (button.dataset.bvlFallback === "1") {
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

  function decorate(video) {
    const host = video.parentElement;
    if (!host || host.querySelector(`[${BUTTON_FLAG}]`)) return;
    if (collect(video).streams.length === 0) return;

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
      handleClick(button, video);
    });

    host.append(button);
  }

  function scan() {
    for (const video of document.querySelectorAll("video")) {
      if (video.closest(`[${BUTTON_FLAG}]`)) continue;
      decorate(video);
    }
  }

  // ------------------------------------------------------------ contexto da aba

  let lastReported = null;

  function reportContext() {
    const video = mainVideo();
    if (!video) return;
    const context = collect(video);
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
    if (!video) {
      sendResponse({ ok: true, streams: [], postId: null, author: null, url: location.href });
      return false;
    }

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
