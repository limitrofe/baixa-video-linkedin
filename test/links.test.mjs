import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFilename,
  cleanPostUrl,
  isDownloadableUrl,
  parseAuthorFromUrl,
  parsePostId,
  qualityFromHeight,
} from "../lib/links.js";

test("acha o número do post em todos os formatos de link", () => {
  const expected = "7518320846965379072";
  const links = [
    "https://www.linkedin.com/posts/matthieulorrain_from-one-world-into-another-ian-ugcPost-7518320846965379072-xz_U/",
    "https://www.linkedin.com/feed/update/urn:li:activity:7518320846965379072/",
    "https://www.linkedin.com/feed/update/urn:li:ugcPost:7518320846965379072",
    "https://www.linkedin.com/posts/activity-7518320846965379072-abcd",
  ];
  for (const link of links) assert.equal(parsePostId(link), expected, link);
});

test("não inventa número onde não existe", () => {
  assert.equal(parsePostId("https://www.linkedin.com/feed/"), null);
  assert.equal(parsePostId(""), null);
  assert.equal(parsePostId(null), null);
});

test("lê o autor do endereço", () => {
  assert.equal(
    parseAuthorFromUrl(
      "https://www.linkedin.com/posts/matthieulorrain_from-one-world-into-another-ian-ugcPost-7518320846965379072-xz_U/"
    ),
    "matthieulorrain"
  );
  assert.equal(parseAuthorFromUrl("https://www.linkedin.com/in/joana-silva/recent-activity/all/"), "joana-silva");
  assert.equal(parseAuthorFromUrl("https://www.linkedin.com/company/acme/posts/"), "acme");
  assert.equal(parseAuthorFromUrl(null), null);
});

test("nome de arquivo é seguro e ordenável", () => {
  const name = buildFilename({ author: "matthieulorrain", postId: "7518320846965379072", quality: "1080p" });
  assert.equal(name, "linkedin-matthieulorrain-7518320846965379072-1080p.mp4");

  const dirty = buildFilename({ author: 'a/b:c*?"<>|', postId: "1", extension: "ts" });
  assert.doesNotMatch(dirty, /[\\/:*?"<>|]/);
  assert.ok(dirty.endsWith(".ts"));
});

test("vários vídeos no mesmo post ganham número", () => {
  const name = buildFilename({ author: "ana", postId: "123", index: 1, total: 3 });
  assert.equal(name, "linkedin-ana-123-2.mp4");
});

test("altura vira rótulo curto", () => {
  assert.equal(qualityFromHeight(1080), "1080p");
  assert.equal(qualityFromHeight(1078), "1080p");
  assert.equal(qualityFromHeight(720), "720p");
  assert.equal(qualityFromHeight(null), null);
});

test("só aceita endereço de verdade", () => {
  assert.equal(isDownloadableUrl("https://dms.licdn.com/a.mp4"), true);
  assert.equal(isDownloadableUrl("blob:https://www.linkedin.com/abc"), false);
  assert.equal(isDownloadableUrl("javascript:alert(1)"), false);
});

test("limpa parâmetros de rastreio do link", () => {
  const cleaned = cleanPostUrl(
    "https://www.linkedin.com/posts/x_y-ugcPost-7518320846965379072-xz_U/?utm_source=share&utm_medium=member_desktop&rcm=ABC"
  );
  assert.equal(
    cleaned,
    "https://www.linkedin.com/posts/x_y-ugcPost-7518320846965379072-xz_U/"
  );
});
