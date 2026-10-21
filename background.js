/**
 * Service worker: decide o caminho do download e acompanha a aba ativa.
 *
 * Dois caminhos possíveis:
 *
 *   MP4 inteiro  → `chrome.downloads` baixa direto do CDN, em paralelo,
 *                  com barra de progresso e retomada do próprio Chrome.
 *   Pedaços      → a página escondida (offscreen.html) junta tudo em memória
 *                  e entrega um arquivo só.
 *
 * Nenhum byte de vídeo passa por servidor de terceiros em nenhum dos casos.
 */

import { buildFilename, cleanPostUrl, parseAuthorFromUrl, parsePostId } from "./lib/links.js";
import { parseHtml, pickStream } from "./lib/video.js";

const DEFAULTS = { quality: "best", saveAs: false };
const QUALITIES = ["best", "2160p", "1080p", "720p", "540p", "480p", "360p", "270p"];

const OFFSCREEN_TIMEOUT_MS = 10 * 60 * 1000;

// ------------------------------------------------------------------ preferências

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  const settings = { ...DEFAULTS, ...stored };
  if (!QUALITIES.includes(settings.quality)) settings.quality = DEFAULTS.quality;
  return settings;
}

// ------------------------------------------------------------------ download direto

/**
 * @param {{url: string, filename: string, saveAs?: boolean}} params
 * @returns {Promise<{id: number, filename: string}>}
 */
function startDownload({ url, filename, saveAs = false }) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs }, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error || downloadId === undefined) {
        reject(new Error(error?.message || "O Chrome recusou o download."));
        return;
      }
      resolve({ id: downloadId, filename });
    });
  });
}

// ------------------------------------------------------------------ página escondida

let creatingOffscreen = null;

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument().catch(() => false);
  if (has) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Juntar os pedaços do vídeo num arquivo único para o download.",
      })
      .catch((error) => {
        // Duas chamadas ao mesmo tempo: a segunda reclama que já existe.
        if (!/single offscreen|already/i.test(String(error?.message))) throw error;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }

  await creatingOffscreen;
}

// ------------------------------------------------------------------ ações

/**
 * Baixa um vídeo já localizado.
 * @param {{url: string, kind?: string, filename?: string, quality?: string, saveAs?: boolean, author?: string, postId?: string}} message
 */
async function download(message) {
  const settings = await getSettings();
  const quality = message.quality ?? settings.quality;
  const saveAs = message.saveAs === undefined ? settings.saveAs : Boolean(message.saveAs);

  if (!message?.url) throw new Error("Endereço do vídeo não informado.");

  const extension = message.kind === "hls" ? "ts" : "mp4";
  const filename =
    message.filename ??
    buildFilename({
      author: message.author ?? null,
      postId: message.postId ?? null,
      quality: typeof quality === "string" && quality !== "best" ? quality : null,
      extension,
    });

  if (message.kind === "hls") {
    await ensureOffscreen();
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "assemble",
      url: message.url,
      filename: filename.replace(/\.(mp4|ts|bin)$/i, ".ts"),
    });
    if (!response?.ok) throw new Error(response?.error || "A montagem do vídeo falhou.");
    return { mode: "montagem", filename: response.filename, segments: response.segments ?? null };
  }

  const started = await startDownload({ url: message.url, filename, saveAs });
  return { mode: "direto", downloads: [started], filename };
}

/**
 * Lê a página com a sessão do usuário e tenta achar o vídeo pelo link.
 * Serve para o campo "cole o link" do popup.
 * @param {{url: string}} message
 */
async function resolveUrl(message) {
  const target = cleanPostUrl(message?.url ?? "");
  if (!/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\//i.test(target)) {
    throw new Error("Isso não parece um link do LinkedIn.");
  }

  const response = await fetch(target, {
    credentials: "include",
    headers: { accept: "text/html,application/xhtml+xml" },
  });

  if (response.status === 999 || response.status === 429) {
    throw new Error("O LinkedIn bloqueou a leitura automática. Abra o post e use o botão da página.");
  }
  if (!response.ok) throw new Error(`O LinkedIn respondeu ${response.status}.`);

  const html = await response.text();
  if (/authwall|Join LinkedIn to see/i.test(html) && !/<video|progressiveStreams/i.test(html)) {
    throw new Error("O LinkedIn pediu login. Entre na sua conta e abra o post.");
  }

  const streams = parseHtml(html);
  if (streams.length === 0) {
    throw new Error("Não achei vídeo nessa página. Abra o post e clique de novo.");
  }

  return {
    postId: parsePostId(target),
    author: parseAuthorFromUrl(target),
    url: target,
    streams,
    best: pickStream(streams, (await getSettings()).quality),
  };
}

// ------------------------------------------------- contexto da aba ativa (para o popup)

const CONTEXT_PREFIX = "tabContext:";

async function writeContext(tabId, context) {
  await chrome.storage.session.set({ [`${CONTEXT_PREFIX}${tabId}`]: context });
}

async function readContext(tabId) {
  const key = `${CONTEXT_PREFIX}${tabId}`;
  const stored = await chrome.storage.session.get(key);
  return stored?.[key] ?? null;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`${CONTEXT_PREFIX}${tabId}`);
});

// ------------------------------------------------------------------ mensagens

const ACTIONS = {
  async download(message) {
    return download(message);
  },

  async resolveUrl(message) {
    return resolveUrl(message);
  },

  async settings() {
    return { settings: await getSettings() };
  },

  async saveSettings(message) {
    const patch = message.settings ?? {};
    const clean = {};
    if (typeof patch.quality === "string" && QUALITIES.includes(patch.quality)) clean.quality = patch.quality;
    if (typeof patch.saveAs === "boolean") clean.saveAs = patch.saveAs;
    if (Object.keys(clean).length > 0) await chrome.storage.sync.set(clean);
    return { settings: await getSettings() };
  },

  async tabContext(message, sender) {
    const tabId = sender?.tab?.id;
    if (typeof tabId === "number") {
      await writeContext(tabId, {
        postId: message.postId ?? null,
        author: message.author ?? null,
        count: message.count ?? 0,
        url: message.url ?? null,
        at: Date.now(),
      });
    }
    return {};
  },

  async getTabContext(message) {
    return { context: await readContext(message.tabId) };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Recado destinado à página escondida: não é daqui.
  if (message?.target === "offscreen") return false;

  const handler = ACTIONS[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: "Ação desconhecida." });
    return false;
  }

  handler(message, sender)
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));

  return true; // resposta assíncrona
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULTS).then((stored) => {
    chrome.storage.sync.set({ ...DEFAULTS, ...stored });
  });
});
