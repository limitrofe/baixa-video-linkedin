import test from "node:test";
import assert from "node:assert/strict";

import {
  detectContainer,
  downloadHls,
  ivFor,
  parseAttributes,
  parseMasterPlaylist,
  parseMediaPlaylist,
  resolveUrl,
} from "../lib/hls.js";

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,CODECS="avc1.42e01e,mp4a.40.2"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720/index.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123456789abcdef0123456789abcdef
#EXTINF:4.0,
seg0.ts
#EXTINF:4.0,
seg1.ts
`;

test("resolve endereço relativo", () => {
  assert.equal(resolveUrl("https://a.com/b/c.m3u8", "d.ts"), "https://a.com/b/d.ts");
  assert.equal(resolveUrl("https://a.com/b/c.m3u8", "/x/d.ts"), "https://a.com/x/d.ts");
});

test("lê atributos com vírgula dentro de aspas", () => {
  const attributes = parseAttributes('BANDWIDTH=600000,CODECS="avc1.42e01e,mp4a.40.2"');
  assert.equal(attributes.BANDWIDTH, "600000");
  assert.equal(attributes.CODECS, "avc1.42e01e,mp4a.40.2");
});

test("escolhe a melhor qualidade da lista de listas", () => {
  const variants = parseMasterPlaylist(MASTER, "https://a.com/v/master.m3u8");
  assert.equal(variants.length, 2);
  assert.equal(variants[0].height, 720);
  assert.equal(variants[0].url, "https://a.com/v/720/index.m3u8");
  assert.equal(variants[1].height, 360);
});

test("lê pedaços, inicializador e chave", () => {
  const { segments, initSegments } = parseMediaPlaylist(MEDIA, "https://a.com/v/720/index.m3u8");
  assert.equal(segments.length, 2);
  assert.equal(segments[0].url, "https://a.com/v/720/seg0.ts");
  assert.equal(segments[0].sequence, 7);
  assert.equal(segments[1].sequence, 8);
  assert.equal(segments[0].key.method, "AES-128");
  assert.equal(segments[0].key.uri, "https://a.com/v/720/key.bin");
  assert.deepEqual(initSegments, ["https://a.com/v/720/init.mp4"]);
});

test("vetor de inicialização: do IV ou do número de sequência", () => {
  const fromTag = ivFor({ iv: "0x0102030405060708090a0b0c0d0e0f10", sequence: 1 });
  assert.deepEqual([...fromTag], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

  const fromSequence = ivFor({ sequence: 258 });
  assert.equal(fromSequence.length, 16);
  assert.equal(fromSequence[15], 2);
  assert.equal(fromSequence[14], 1);
});

test("descobre o tipo do arquivo pelos primeiros bytes", () => {
  const ts = new Uint8Array(200);
  ts[0] = 0x47;
  assert.equal(detectContainer([ts.buffer]), "ts");

  const mp4 = new TextEncoder().encode("0000ftypisom");
  assert.equal(detectContainer([mp4.buffer]), "mp4");

  assert.equal(detectContainer([]), "bin");
});

test("junta os pedaços na ordem mesmo baixando em paralelo", async () => {
  const files = new Map([
    ["https://a.com/master.m3u8", MASTER.replace(/720\/index.m3u8/, "fm/index.m3u8").replace("360/index.m3u8", "fm/index.m3u8")],
    ["https://a.com/fm/index.m3u8", "#EXTM3U\n#EXTINF:1,\nseg0.ts\n#EXTINF:1,\nseg1.ts\n"],
    ["https://a.com/fm/seg0.ts", "PRIMEIRO"],
    ["https://a.com/fm/seg1.ts", "SEGUNDO"],
  ]);

  const fetchImpl = async (url) => {
    const body = files.get(url);
    if (body === undefined) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      text: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  };

  const progress = [];
  const result = await downloadHls("https://a.com/master.m3u8", {
    fetchImpl,
    concurrency: 2,
    onProgress: (info) => progress.push(info.done),
  });

  const text = result.parts.map((part) => new TextDecoder().decode(part)).join("");
  assert.equal(text, "PRIMEIROSEGUNDO");
  assert.equal(result.segments, 2);
  assert.deepEqual(progress.sort(), [1, 2]);
});

test("reclama quando o endereço não é uma lista", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => "<html>nada</html>",
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  await assert.rejects(() => downloadHls("https://a.com/x.m3u8", { fetchImpl }), /lista de pedaços/i);
});

test("reclama quando a lista não tem pedaço", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => "#EXTM3U\n#EXT-X-ENDLIST\n",
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  await assert.rejects(() => downloadHls("https://a.com/x.m3u8", { fetchImpl }), /vazia/i);
});
