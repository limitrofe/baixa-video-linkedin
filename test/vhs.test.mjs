import test from "node:test";
import assert from "node:assert/strict";

import { decodeVhsPayload, scanVhsPayloads, streamsFromVhs, vhsStreamsFrom } from "../lib/vhs.js";
import { normalizeStreams, parseHtml, pickStream } from "../lib/video.js";

// Formato real do LinkedIn: qualidades + pedaços assinados, cada pedaço com
// ~4 segundos. O primeiro `segments` de algumas qualidades é o inicializador.
const MANIFEST = {
  duration: 8.5,
  playlists: [
    {
      attributes: {
        NAME: "hls-720p-quality-analysis",
        RESOLUTION: { width: 1280, height: 720 },
        CODECS: "avc1.42001e,mp4a.40.2",
        BANDWIDTH: 2460000,
      },
      segments: [
        { uri: "https://dms.licdn.com/playlist/vid/v2/abc/1/sig?e=1&v=beta", map: { uri: "https://dms.licdn.com/playlist/vid/v2/abc/1/sig?e=1&v=beta" } },
        { uri: "https://dms.licdn.com/playlist/vid/v2/abc/2/sig?e=1&v=beta", map: { uri: "https://dms.licdn.com/playlist/vid/v2/abc/1/sig?e=1&v=beta" } },
        { uri: "https://dms.licdn.com/playlist/vid/v2/abc/3/sig?e=1&v=beta", map: { uri: "https://dms.licdn.com/playlist/vid/v2/abc/1/sig?e=1&v=beta" } },
      ],
    },
    {
      // Mesmo tamanho, mas em AV1: só atrapalha, tem que sobrar o H.264.
      attributes: {
        RESOLUTION: { width: 1280, height: 720 },
        CODECS: "av01.0.04M.10,mp4a.40.2",
        BANDWIDTH: 3000000,
      },
      segments: [
        { uri: "https://dms.licdn.com/playlist/vid/v2/av1/1/sig" },
        { uri: "https://dms.licdn.com/playlist/vid/v2/av1/2/sig" },
      ],
    },
    {
      attributes: {
        RESOLUTION: { width: 640, height: 360 },
        CODECS: "avc1.42001e,mp4a.40.2",
        BANDWIDTH: 460000,
      },
      segments: [
        { uri: "https://dms.licdn.com/playlist/vid/v2/360/1/sig", map: { uri: "https://dms.licdn.com/playlist/vid/v2/360/1/sig" } },
        { uri: "https://dms.licdn.com/playlist/vid/v2/360/2/sig", map: { uri: "https://dms.licdn.com/playlist/vid/v2/360/1/sig" } },
      ],
    },
  ],
};

// Como o LinkedIn entrega: JSON dentro de uma string de JS, com aspas
// escapadas e `&` trocado por \u0026.
const ESCAPED = JSON.stringify(MANIFEST).replace(/"/g, '\\"').replace(/&/g, "\\u0026");
const PAGE = `<html><body><script>self.__next_f.push([1,"video:data:application/vnd.videojs.vhs+json,${ESCAPED}"])</script></body></html>`;

test("acha o bloco do player no meio do HTML", () => {
  const payloads = scanVhsPayloads(PAGE);
  assert.equal(payloads.length, 1);

  const manifest = decodeVhsPayload(payloads[0]);
  assert.equal(manifest.duration, 8.5);
  assert.equal(manifest.playlists.length, 3);
});

test("devolve o endereço com & no lugar de \\u0026", () => {
  const [stream] = vhsStreamsFrom(PAGE);
  assert.match(stream.segments[0], /e=1&v=beta$/);
});

test("monta inicializador + pedaços sem repetir", () => {
  const [stream] = vhsStreamsFrom(PAGE);
  assert.equal(stream.kind, "segments");
  assert.equal(stream.height, 720);
  assert.equal(stream.init, "https://dms.licdn.com/playlist/vid/v2/abc/1/sig?e=1&v=beta");
  assert.deepEqual(stream.segments, [
    "https://dms.licdn.com/playlist/vid/v2/abc/2/sig?e=1&v=beta",
    "https://dms.licdn.com/playlist/vid/v2/abc/3/sig?e=1&v=beta",
  ]);
  assert.equal(stream.bitrate, 2460000);
});

test("prefere H.264 e descarta a versão AV1 do mesmo tamanho", () => {
  const streams = vhsStreamsFrom(PAGE);
  assert.equal(streams.length, 2);
  assert.ok(streams.every((stream) => /avc1/.test(stream.codecs)));
  assert.deepEqual(streams.map((stream) => stream.height), [720, 360]);
});

test("lê o bloco quando ele vem no src do player, sem escape", () => {
  const raw = `data:application/vnd.videojs.vhs+json,${JSON.stringify(MANIFEST)}`;
  const streams = vhsStreamsFrom(raw);
  assert.equal(streams.length, 2);
});

test("texto sem bloco não vira nada", () => {
  assert.deepEqual(vhsStreamsFrom("<html><video src='blob:https://x/y'></video></html>"), []);
  assert.equal(decodeVhsPayload("{quebrado"), null);
  assert.deepEqual(streamsFromVhs({}), []);
});

test("a leitura do HTML já entrega a lista do player", () => {
  const streams = parseHtml(PAGE);
  assert.equal(streams.length, 2);
  assert.equal(streams[0].kind, "segments");
  assert.equal(streams[0].quality, "720p");
  assert.equal(streams[0].label, "720p · completo · 2,5 Mbps");
  assert.equal(streams[0].segments.length, 2);
});

test("a lista do player sobrevive ao normalize e é escolhida primeiro", () => {
  const list = normalizeStreams([
    { url: "https://x/a.m3u8", kind: "hls", height: 720, bitrate: 1000 },
    ...vhsStreamsFrom(PAGE),
  ]);

  assert.equal(list[0].kind, "segments");
  assert.equal(pickStream(list, "best").kind, "segments");
  assert.equal(pickStream(list, "360p").segments.length, 1);
});
