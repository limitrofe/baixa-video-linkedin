/**
 * Página escondida: junta os pedaços numa memória só.
 *
 * Precisa ser uma página (e não o service worker) porque só página tem
 * `Blob` + `URL.createObjectURL`, e é esse endereço temporário que o
 * `chrome.downloads` transforma em arquivo na pasta do usuário.
 */

import { downloadHls } from "./lib/hls.js";

const MIME_BY_CONTAINER = {
  ts: "video/mp2t",
  mp4: "video/mp4",
  bin: "application/octet-stream",
};

const REVOKE_AFTER_MS = 10 * 60 * 1000;

/**
 * @param {{url: string, filename: string}} message
 */
async function assemble(message) {
  const { url, filename } = message;

  const { parts, container, segments } = await downloadHls(url, {
    onProgress: ({ done, total }) => {
      // O popup escuta este recado para mostrar a barra de progresso.
      chrome.runtime.sendMessage({ type: "bvl:progress", done, total, filename }).catch(() => {});
    },
  });

  const blob = new Blob(parts, { type: MIME_BY_CONTAINER[container] ?? MIME_BY_CONTAINER.bin });
  const objectUrl = URL.createObjectURL(blob);

  const finalName = filename.replace(/\.(mp4|ts|bin)$/i, `.${container === "bin" ? "mp4" : container}`);

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

  return { id, filename: finalName, segments, container, bytes: blob.size };
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
