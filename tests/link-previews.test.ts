import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPreviewService,
  parsePreviewMetadata,
} from "../src/server/link-previews.js";
import { previewImageUrl } from "../src/shared/preview-image.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const html = (body = "<title>Article title</title>") => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body,
});

test("preview metadata prefers Open Graph text and preserves the original destination", () => {
  const preview = parsePreviewMetadata(
    '<title>Fallback</title><meta content="A &amp; B" property="og:title"><meta name="description" content="A useful summary"><meta property="og:url" content="https://other.test/">',
    "https://example.com/story?gift=private#part",
  );
  assert.equal(preview.title, "A & B");
  assert.equal(preview.description, "A useful summary");
  assert.equal(preview.url, "https://example.com/story?gift=private#part");
  assert.equal(
    parsePreviewMetadata(
      "<title>Fallback &amp; title</title>",
      "https://example.com",
    ).title,
    "Fallback & title",
  );
  assert.ok(!("html" in preview));
});

test("preview fetching rejects private, local, unusual-port and non-web destinations before a request", async () => {
  let requests = 0;
  const service = createPreviewService({
    lookup: publicLookup,
    request: async () => {
      requests++;
      return html();
    },
  });
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://localhost/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "https://example.com:4320/",
    "https://user:pass@example.com/",
  ])
    assert.equal(await service.get(url), null, url);
  assert.equal(requests, 0);
});

test("thumbnail metadata prefers secure Open Graph images and supports Twitter fallback", () => {
  const destination = "https://example.com/articles/story";
  assert.equal(
    parsePreviewMetadata(
      '<meta property="og:image" content="/ordinary.jpg"><meta property="og:image:secure_url" content="//cdn.example.com/small.jpg?a=1&amp;b=2"><meta name="twitter:image" content="/twitter.jpg">',
      destination,
    ).image,
    "https://cdn.example.com/small.jpg?a=1&b=2",
  );
  assert.equal(
    parsePreviewMetadata(
      '<meta property="og:image" content="http://example.com/insecure.jpg"><meta name="twitter:image" content="../twitter.jpg">',
      destination,
    ).image,
    "https://example.com/twitter.jpg",
  );
  assert.equal(
    parsePreviewMetadata("<title>No image</title>", destination).image,
    "",
  );
  for (const unsafe of [
    "javascript:alert(1)",
    "data:image/svg+xml,test",
    "http://example.com/image.jpg",
    "https://127.0.0.1/x",
    "https://2130706433/x",
    "https://[::1]/x",
    "https://localhost/x",
    "https://foo.local/x",
    "https://example.com:4320/x",
    "https://user:pass@example.com/x",
  ])
    assert.equal(previewImageUrl(unsafe), "", unsafe);
});

test("relative thumbnails resolve against the final page while the post link stays original", async () => {
  const service = createPreviewService({
    lookup: publicLookup,
    request: async (u) =>
      u.hostname === "example.com"
        ? {
            status: 302,
            headers: { location: "https://news.example.com/articles/story" },
            body: "",
          }
        : html(
            '<title>Redirected article</title><meta property="og:image" content="../images/photo.jpg">',
          ),
  });
  const preview = await service.get("https://example.com/gift?token=keep");
  assert.equal(preview?.url, "https://example.com/gift?token=keep");
  assert.equal(preview?.image, "https://news.example.com/images/photo.jpg");
});

test("preview connections pin a verified public DNS answer and reject mixed private answers", async () => {
  let pinned = "";
  const service = createPreviewService({
    lookup: publicLookup,
    request: async (_url, address) => {
      pinned = address.address;
      return html();
    },
  });
  assert.equal(
    (await service.get("https://example.com/story"))?.title,
    "Article title",
  );
  assert.equal(pinned, "93.184.216.34");
  const mixed = createPreviewService({
    lookup: async () => [
      ...(await publicLookup()),
      { address: "127.0.0.1", family: 4 },
    ],
    request: async () => {
      throw Error("Private answer reached transport");
    },
  });
  assert.equal(await mixed.get("https://example.com"), null);
});

test("redirects are checked again and cannot reach metadata or private networks", async () => {
  let requests = 0;
  const service = createPreviewService({
    lookup: publicLookup,
    request: async () => {
      requests++;
      return {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
        body: "",
      };
    },
  });
  assert.equal(await service.get("https://example.com"), null);
  assert.equal(requests, 1);
  const redirect = createPreviewService({
    lookup: publicLookup,
    request: async (u) =>
      u.pathname === "/one"
        ? { status: 302, headers: { location: "/two" }, body: "" }
        : html(),
  });
  assert.equal(
    (await redirect.get("https://example.com/one"))?.title,
    "Article title",
  );
});

test("blocked pages, non-HTML, oversized bodies and redirect loops fall back without breaking the feed", async () => {
  for (const response of [
    { status: 403, headers: {}, body: "Blocked" },
    {
      status: 200,
      headers: { "content-type": "application/pdf" },
      body: "%PDF",
    },
    html("<title>Oversized article</title>" + "x".repeat(300_000)),
    { status: 302, headers: { location: "/" }, body: "" },
  ]) {
    const service = createPreviewService({
      lookup: publicLookup,
      request: async () => response,
    });
    assert.equal(await service.get("https://example.com/"), null);
  }
});

test("previews coalesce duplicate requests, expire cache entries and limit concurrent retrievals", async () => {
  let requests = 0,
    active = 0,
    maximum = 0,
    now = 0;
  const service = createPreviewService({
    lookup: publicLookup,
    now: () => now,
    request: async () => {
      requests++;
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return html();
    },
  });
  await Promise.all([
    service.get("https://example.com/one"),
    service.get("https://example.com/one"),
  ]);
  assert.equal(requests, 1);
  await service.get("https://example.com/one");
  assert.equal(requests, 1);
  now = 2 * 86400_000;
  await service.get("https://example.com/one");
  assert.equal(requests, 2);
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      service.get("https://example.com/story-" + i),
    ),
  );
  assert.ok(maximum <= 2);
});
