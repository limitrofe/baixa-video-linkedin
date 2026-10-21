import { pickStream } from "../lib/video.js";

const els = {
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  form: document.getElementById("paste-form"),
  input: document.getElementById("paste-input"),
  settings: document.getElementById("settings"),
  toggleSettings: document.getElementById("toggle-settings"),
  quality: document.getElementById("quality"),
  saveAs: document.getElementById("save-as"),
};

const DEFAULTS = { quality: "best", saveAs: false };

let settings = { ...DEFAULTS };
let current = null;
let requestId = 0;

function setStatus(text, kind = "") {
  els.status.hidden = !text;
  els.status.textContent = text ?? "";
  els.status.className = `status ${kind}`.trim();
}

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return { ok: false, error: "Não consegui falar com a extensão. Recarregue a página." };
  }
}

async function listFromTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus("Abra um post do LinkedIn com vídeo.");
    return null;
  }

  if (!/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\//i.test(tab.url ?? "")) {
    setStatus("Esta aba não é do LinkedIn. Abra o post e clique no ícone de novo.");
    return null;
  }

  // Caminho principal: a página já sabe onde está o vídeo.
  try {
    const answer = await chrome.tabs.sendMessage(tab.id, { type: "bvl:list" });
    if (answer?.streams?.length) return { ...answer, via: "página" };
  } catch {
    // content script ainda não rodou nesta aba: cai no caminho de reserva
  }

  // Reserva: a extensão lê a página com a sua sessão.
  const response = await send({ type: "resolveUrl", url: tab.url });
  if (!response?.ok) {
    setStatus(response?.error || "Não achei vídeo nesta aba.", "is-error");
    return null;
  }
  return { ...response, via: "leitura da página" };
}

async function download(stream, button, context) {
  if (button) button.disabled = true;

  const response = await send({
    type: "download",
    url: stream.url,
    kind: stream.kind,
    quality: stream.quality,
    author: context?.author ?? null,
    postId: context?.postId ?? null,
  });

  if (button) button.disabled = false;

  if (!response?.ok) {
    setStatus(response?.error || "Falha ao baixar.", "is-error");
    return;
  }

  setStatus(
    response.mode === "montagem"
      ? "Juntando os pedaços… o arquivo vai aparecer na sua pasta de downloads."
      : "Download iniciado — veja a lista de downloads do Chrome.",
    "ok"
  );
}

function buildCard(context) {
  const card = document.createElement("article");
  card.className = "card";

  const media = document.createElement("div");
  media.className = "card-media";

  const meta = document.createElement("div");
  meta.className = "card-meta";
  const title = document.createElement("strong");
  title.textContent = context.author ? `@${context.author}` : "Vídeo do LinkedIn";
  const sub = document.createElement("span");
  const total = context.streams.length;
  sub.textContent = `${total} opç${total > 1 ? "ões" : "ão"} · ${context.via}`;
  meta.append(title, sub);
  media.append(meta);
  card.append(media);

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const preferred = pickStream(context.streams, settings.quality);
  if (preferred) {
    const main = document.createElement("button");
    main.type = "button";
    main.className = "primary";
    main.textContent = `Baixar · ${preferred.label}`;
    main.addEventListener("click", () => download(preferred, main, context));
    actions.append(main);
  }

  if (context.streams.length > 1) {
    const qualities = document.createElement("div");
    qualities.className = "qualities";
    for (const stream of context.streams) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = stream.quality ?? stream.label;
      button.title = stream.label;
      button.addEventListener("click", () => download(stream, button, context));
      qualities.append(button);
    }
    actions.append(qualities);
  }

  card.append(actions);
  return card;
}

function render(context) {
  current = context;
  els.results.replaceChildren();

  if (!context?.streams?.length) {
    setStatus("Esse post não tem vídeo — ou o vídeo ainda não carregou na página.", "is-error");
    return;
  }

  els.results.append(buildCard(context));

  const preferred = pickStream(context.streams, settings.quality);
  const note = preferred?.kind === "hls" ? " Veio em pedaços: a extensão junta antes de salvar." : "";
  setStatus(`Vídeo encontrado (${context.streams.length} opções).${note}`, "ok");
}

async function loadFromTab() {
  const token = ++requestId;
  current = null;
  els.results.replaceChildren();
  setStatus("Procurando vídeo nesta aba…");

  const context = await listFromTab();
  if (token !== requestId) return;
  if (!context) return;

  if (!context.postId && context.url) els.input.value = context.url;
  render(context);
}

let pasteTimer = null;

els.input.addEventListener("input", () => {
  clearTimeout(pasteTimer);
  const value = els.input.value.trim();
  if (!/linkedin\.com\//i.test(value)) return;

  pasteTimer = setTimeout(async () => {
    setStatus("Lendo o link…");
    els.results.replaceChildren();
    const response = await send({ type: "resolveUrl", url: value });
    if (!response?.ok) {
      setStatus(response?.error || "Não achei vídeo nesse link.", "is-error");
      return;
    }
    render({ ...response, via: "leitura do link" });
  }, 420);
});

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  els.input.dispatchEvent(new Event("input"));
});

els.toggleSettings.addEventListener("click", () => {
  els.settings.hidden = !els.settings.hidden;
});

els.quality.addEventListener("change", async () => {
  settings.quality = els.quality.value;
  await send({ type: "saveSettings", settings: { quality: settings.quality } });
  if (current) render(current);
});

els.saveAs.addEventListener("change", async () => {
  settings.saveAs = els.saveAs.checked;
  await send({ type: "saveSettings", settings: { saveAs: settings.saveAs } });
});

// Barra de progresso da montagem vem da página escondida, direto para cá.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "bvl:progress") return;
  setStatus(`Juntando os pedaços… ${message.done} de ${message.total}`, "");
});

(async function init() {
  const response = await send({ type: "settings" });
  settings = { ...DEFAULTS, ...(response?.settings ?? {}) };
  els.quality.value = settings.quality;
  els.saveAs.checked = Boolean(settings.saveAs);

  const tab = await listFromTab().catch(() => null);
  if (tab) render(tab);
  else if (!els.status.textContent) setStatus("Abra um post do LinkedIn com vídeo.");
})();
