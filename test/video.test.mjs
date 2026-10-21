import test from "node:test";
import assert from "node:assert/strict";

import {
  attributeValue,
  decodeEntities,
  findMediaHolders,
  kindFromUrl,
  normalizeStreams,
  parseHtml,
  pickStream,
  streamsFromDataSources,
  streamsFromHolder,
} from "../lib/video.js";

const PAGE = `
<html><body>
  <video
    data-sources="[{&quot;src&quot;:&quot;https://dms.licdn.com/playlist/vid/v2/abc/master.m3u8&quot;,&quot;type&quot;:&quot;application/x-mpegURL&quot;}]"
    data-poster-url="https://media.licdn.com/poster.jpg"></video>
  <code id="bpr-guid-1">{"data":{"video":{"progressiveStreams":[
      {"streamingLocations":[{"url":"https://dms.licdn.com/video/v1/abc/360p.mp4"}],"width":640,"height":360,"bitRate":600000},
      {"streamingLocations":[{"url":"https://dms.licdn.com/video/v1/abc/720p.mp4"}],"width":1280,"height":720,"bitRate":2000000}
    ],
    "adaptiveStreams":[{"protocol":"HLS","masterPlaylists":[{"url":"https://dms.licdn.com/video/v1/abc/master.m3u8"}]}]}}}</code>
</body></html>`;

test("desfaz entidades do HTML", () => {
  assert.equal(decodeEntities("&quot;a&quot;"), '"a"');
  assert.equal(decodeEntities("a &amp; b"), "a & b");
  assert.equal(decodeEntities("&#x27;x&#x27;"), "'x'");
  assert.equal(decodeEntities("sem entidade"), "sem entidade");
});

test("classifica o endereço pelo tipo e pelo sufixo", () => {
  assert.equal(kindFromUrl("https://x/a.m3u8"), "hls");
  assert.equal(kindFromUrl("https://x/a", "application/x-mpegURL"), "hls");
  assert.equal(kindFromUrl("https://x/a.mp4"), "mp4");
  assert.equal(kindFromUrl("https://x/a", "video/mp4"), "mp4");
  assert.equal(kindFromUrl("https://x/manifest(format=mpd-time-csf)"), "dash");
});

test("lê o data-sources do player", () => {
  const streams = streamsFromDataSources(
    "[{&quot;src&quot;:&quot;https://dms.licdn.com/a.mp4&quot;,&quot;type&quot;:&quot;video/mp4&quot;,&quot;data-bitrate&quot;:&quot;1200000&quot;}]"
  );
  assert.equal(streams.length, 1);
  assert.equal(streams[0].kind, "mp4");
  assert.equal(streams[0].bitrate, 1200000);
});

test("lixo no atributo não quebra nada", () => {
  assert.deepEqual(streamsFromDataSources("não é json"), []);
  assert.deepEqual(streamsFromDataSources(null), []);
});

test("acha os blocos de mídia dentro de um JSON comprido", () => {
  const holders = findMediaHolders({
    a: { b: [{ c: { progressiveStreams: [{ width: 1 }] } }] },
    d: { adaptiveStreams: [] },
  });
  assert.equal(holders.length, 2);
});

test("converte progressive e adaptive em endereços", () => {
  const streams = streamsFromHolder({
    progressiveStreams: [
      { streamingLocations: [{ url: "https://dms.licdn.com/v/720.mp4" }], width: 1280, height: 720, bitRate: 2000 },
      { streamingLocations: [] },
    ],
    adaptiveStreams: [{ protocol: "HLS", masterPlaylists: ["https://dms.licdn.com/v/master.m3u8"] }],
  });
  assert.equal(streams.length, 2);
  assert.equal(streams[0].kind, "mp4");
  assert.equal(streams[1].kind, "hls");
});

test("lê a página inteira e põe o MP4 antes dos pedaços", () => {
  const streams = parseHtml(PAGE);
  // Dois HLS porque o player e o bloco de dados apontam para listas diferentes.
  assert.equal(streams.length, 4);
  assert.equal(streams[0].kind, "mp4");
  assert.equal(streams[0].height, 720);
  assert.equal(streams[1].height, 360);
  assert.equal(streams[2].kind, "hls");
  assert.equal(streams[3].kind, "hls");
  assert.match(streams[0].label, /720p/);
});

test("tira repetido e endereço inválido", () => {
  const streams = normalizeStreams([
    { url: "https://x/a.mp4", kind: "mp4", height: 720 },
    { url: "https://x/a.mp4", kind: "mp4", height: 720 },
    { url: "javascript:alert(1)", kind: "mp4" },
    { url: "https://x/m.mpd", kind: "dash" },
  ]);
  assert.equal(streams.length, 1);
});

test("escolhe a qualidade pedida e cai para a menor acima quando falta", () => {
  const streams = normalizeStreams([
    { url: "https://x/1080.mp4", kind: "mp4", height: 1080 },
    { url: "https://x/720.mp4", kind: "mp4", height: 720 },
    { url: "https://x/360.mp4", kind: "mp4", height: 360 },
  ]);
  assert.equal(pickStream(streams, "best").height, 1080);
  assert.equal(pickStream(streams, "720p").height, 720);
  assert.equal(pickStream(streams, "480p").height, 360);
  assert.equal(pickStream(streams, "2160p").height, 1080);
  assert.equal(pickStream([], "best"), null);
});

test("lê o valor de um atributo dentro da etiqueta", () => {
  assert.equal(attributeValue('<video data-sources="[1]" poster="p.jpg">', "data-sources"), "[1]");
  assert.equal(attributeValue("<video poster='p.jpg'>", "poster"), "p.jpg");
  assert.equal(attributeValue("<video>", "data-sources"), null);
});
