// Isolated fixture: real authentication and an in-memory database; every
// WordPress request is replaced here. This file is excluded from the image.
import { createApp } from "../src/server/app.js";
import { configuration } from "../src/server/config.js";
import { hash, seal } from "../src/server/security.js";
import { Store } from "../src/server/store.js";
const config = configuration({
  APP_ORIGIN: "http://localhost:4321",
  ENCRYPTION_KEY: "b".repeat(64),
  OWNER_INVITE_HASH: hash("browser-test-invite"),
  OWNER_INVITE_EXPIRES_AT: "2099-01-01T00:00:00Z",
  DATABASE_PATH: ":memory:",
});
const db = new Store(":memory:");
db.run(
  "INSERT INTO secrets VALUES(?,?)",
  "connection",
  seal(
    {
      access_token: "fixture-token",
      account: { id: "10", display_name: "Test reader", acct: "reader" },
    },
    config.key,
  ),
);
const person = {
  id: "20",
  display_name: "Sample author",
  username: "sample",
  acct: "sample@example.test",
  locked: false,
};
const post = {
  id: "42",
  account: person,
  created_at: "2026-10-17T08:00:00Z",
  content:
    '<p>A small discovery on a quiet morning. <strong>Room for curiosity.</strong></p><script>window.injected=true</script><img src=x onerror="window.injected=true"><a href="javascript:alert(1)">Unsafe link</a>',
  visibility: "public",
  spoiler_text: "",
  sensitive: false,
  media_attachments: [],
  tags: [{ name: "curiosity" }],
  favourited: false,
  bookmarked: false,
  favourites_count: 2,
  replies_count: 0,
};
let follows = false;
const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  let data: unknown;
  if (url.pathname.endsWith("/favourite")) {
    post.favourited = true;
    post.favourites_count = 3;
    data = post;
  } else if (url.pathname.endsWith("/unfavourite")) {
    post.favourited = false;
    post.favourites_count = 2;
    data = post;
  } else if (url.pathname.endsWith("/bookmark")) {
    post.bookmarked = true;
    data = post;
  } else if (url.pathname.endsWith("/unbookmark")) {
    post.bookmarked = false;
    data = post;
  } else if (url.pathname.endsWith("/follow")) {
    follows = true;
    data = { id: "20", following: true, requested: false };
  } else if (url.pathname.endsWith("/following"))
    data = follows ? [person] : [];
  else if (url.pathname.endsWith("/context"))
    data = { ancestors: [], descendants: [] };
  else if (url.pathname.endsWith("/statuses/42")) data = post;
  else if (url.pathname.endsWith("/statuses") && init?.method === "POST") {
    data = { ...post, id: "43" };
    post.replies_count++;
  } else if (url.pathname.endsWith("/search"))
    data = {
      accounts: [person],
      statuses: [post],
      hashtags: [{ name: "curiosity" }],
    };
  else if (
    url.pathname.includes("/timelines/") ||
    url.pathname.endsWith("/bookmarks")
  )
    data = [
      post,
      {
        ...post,
        id: "44",
        content:
          "<p>Longer thoughts deserve a little breathing room.</p><blockquote>Reading at your own pace.</blockquote>",
        spoiler_text: "A thoughtful aside",
        tags: [],
      },
    ];
  else return new Response("{}", { status: 404 });
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
};
const { app } = createApp(config, db, fakeFetch);
app.listen(4321, "127.0.0.1", () =>
  console.log("Isolated browser test server ready on 4321"),
);
