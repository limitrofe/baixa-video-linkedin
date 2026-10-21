/**
 * Página escondida: junta os pedaços numa memória só.
 *
 * Precisa ser uma página (e não o service worker) porque só página tem
 * `Blob` + `URL.createObjectURL`, e é esse endereço temporário que o
 * `chrome.downloads` transforma em arquivo na pasta do usuário.
 */

import { downloadHls, downloadParts } from "./lib/hls.js";

const MIME_BY_CONTAINER = {
  ts: "video/mp2t",
  mp4: "video/mp4",
  bin: "application/octet-stream",
};

const REVOKE_AFTER_MS = 10 * 60 * 1000;

/**
 * Transforma os bytes num arquivo e entrega ao Chrome.
 * @param {{parts: ArrayBuffer[], container: string, segments: number}} result
 * @param {string} filename
 */
async function save(result, filename) {
  const { parts, container } = result;
  const blob = new Blob(parts, { type: MIME_BY_CONTAINER[container] ?? MIME_BY_CONTAINER.bin });
  const objectUrl = URL.createObjectURL(blob);

  const extension = container === "bin" ? "mp4" : container;
  const finalName = filename.replace(/\.(mp4|ts|bin|webm)$/i, `.${extension}`);

  const id = await new Promise((resolve, reject) => {
    chrome.downloads.download({ url: objectUrl, filename: finalName, saveAs: false }, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error || downloadId === undefined) {
        reject(new Error(error?.message || "O Chrome recusou o arquivo montado."));
        return;
      }
      resolve(downloadId);
    });
  });

  // O endereço temporário só pode sumir depois que o Chrome terminou de copiar.
  setTimeout(() => URL.revokeObjectURL(objectUrl), REVOKE_AFTER_MS);

  return { id, filename: finalName, segments: result.segments, container, bytes: blob.size };
}

/**
 * @param {{url?: string, init?: string|null, segments?: string[], filename: string}} message
 */
async function assemble(message) {
  const onProgress = ({ done, total }) => {
    // O popup escuta este recado para mostrar andamento.
    chrome.runtime.sendMessage({ type: "bvl:progress", done, total, filename: message.filename }).catch(() => {});
  };

  // Lista pronta (bloco Video.js/VHS): já sabemos cada pedaço.
  const result = message.segments?.length
    ? await downloadParts(message.init ? [message.init] : [], message.segments, { onProgress })
    : await downloadHls(message.url, { onProgress });

  return save(result, message.filename);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  if (message.type !== "assemble") {
    sendResponse({ ok: false, error: "Pedido desconhecido." });
    return false;
  }

  assemble(message)
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));

  return true;
});
