import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import { Parser } from "htmlparser2";

const MAX_BYTES = 256_000;
type Address = { address: string; family: number };
type Page = {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
};
export type LinkPreview = {
  url: string;
  domain: string;
  title: string;
  description: string;
};
type Dependencies = {
  lookup?: (host: string) => Promise<Address[]>;
  request?: (url: URL, address: Address, signal: AbortSignal) => Promise<Page>;
  now?: () => number;
};

function webUrl(input: string) {
  const u = new URL(input);
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    input.length > 4096 ||
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.port ||
    (!host.includes(".") && !isIP(host)) ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)
  )
    throw Error("Unsupported preview URL");
  return u;
}
function publicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

// DNS is checked in full, then the chosen public address is pinned to the socket.
// Each redirect repeats this check; no cookies, WordPress token or user headers
// are sent to article servers. Fetch only a small HTML prefix, never execute it.
async function requestPage(
  u: URL,
  address: Address,
  signal: AbortSignal,
): Promise<Page> {
  return new Promise((resolve, reject) => {
    const request = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      u,
      {
        method: "GET",
        agent: false,
        family: address.family,
        signal,
        lookup: (_host, _options, callback) =>
          callback(null, address.address, address.family),
        headers: {
          "user-agent": "AsterismReader/0.1 (link preview)",
          accept: "text/html,application/xhtml+xml",
          "accept-encoding": "identity",
        },
      },
      (res) => {
        const headers = Object.fromEntries(
          Object.entries(res.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v[0] : v,
          ]),
        );
        const status = res.statusCode || 0;
        if (
          status !== 200 ||
          !/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(
            headers["content-type"] || "",
          )
        ) {
          resolve({ status, headers, body: "" });
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0,
          finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          const charset =
            headers["content-type"]?.match(/charset=["']?([^;\s"']+)/i)?.[1] ||
            "utf-8";
          const bytes = Buffer.concat(chunks);
          let body: string;
          try {
            body = new TextDecoder(charset).decode(bytes);
          } catch {
            body = bytes.toString("utf8");
          }
          resolve({ status, headers, body });
        };
        res.on("data", (chunk: Buffer) => {
          const part = chunk.subarray(0, MAX_BYTES - size);
          chunks.push(part);
          size += part.length;
          if (size >= MAX_BYTES) {
            finish();
            res.destroy();
          }
        });
        res.on("end", finish);
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const clean = (value: string, limit: number) =>
  value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
export function parsePreviewMetadata(
  html: string,
  destination: string,
): LinkPreview {
  const meta = new Map<string, string>();
  let title = "",
    inTitle = false;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "title") inTitle = true;
        if (name === "meta") {
          const key = (attrs.property || attrs.name || "").toLowerCase();
          if (attrs.content && !meta.has(key)) meta.set(key, attrs.content);
        }
      },
      ontext(text) {
        if (inTitle && title.length < 1000) title += text;
      },
      onclosetag(name) {
        if (name === "title") inTitle = false;
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  const u = new URL(destination);
  return {
    url: u.href,
    domain: u.hostname,
    title: clean(
      meta.get("og:title") || meta.get("twitter:title") || title,
      200,
    ),
    description: clean(
      meta.get("og:description") ||
        meta.get("twitter:description") ||
        meta.get("description") ||
        "",
      320,
    ),
  };
}

export function createPreviewService(deps: Dependencies = {}) {
  const resolve =
    deps.lookup ||
    (async (host: string) => lookup(host, { all: true, verbatim: true }));
  const request = deps.request || requestPage,
    now = deps.now || Date.now;
  const cache = new Map<
    string,
    { value: LinkPreview | null; expires: number }
  >();
  const pending = new Map<string, Promise<LinkPreview | null>>();
  const queue: (() => void)[] = [];
  let active = 0;
  async function retrieve(destination: string) {
    const signal = AbortSignal.timeout(8000);
    let u = webUrl(destination);
    for (let hop = 0; hop < 4; hop++) {
      signal.throwIfAborted();
      const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
      let abort: () => void = () => {};
      const timeout = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      let addresses: Address[];
      try {
        addresses = isIP(host)
          ? [{ address: host, family: isIP(host) }]
          : await Promise.race([resolve(host), timeout]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
      if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
        return null;
      signal.throwIfAborted();
      const page = await request(
        u,
        addresses.find((a) => a.family === 4) || addresses[0],
        signal,
      );
      if (
        [301, 302, 303, 307, 308].includes(page.status) &&
        page.headers.location
      ) {
        u = webUrl(new URL(page.headers.location, u).href);
        continue;
      }
      if (
        page.status !== 200 ||
        !/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(
          page.headers["content-type"] || "",
        ) ||
        Buffer.byteLength(page.body) > MAX_BYTES
      )
        return null;
      const preview = parsePreviewMetadata(page.body, destination);
      return preview.title ? preview : null;
    }
    return null;
  }
  return {
    async get(input: string): Promise<LinkPreview | null> {
      let key: string;
      try {
        key = webUrl(input).href;
      } catch {
        return null;
      }
      const cached = cache.get(key);
      if (cached && cached.expires > now()) return cached.value;
      const existing = pending.get(key);
      if (existing) return existing;
      if (queue.length >= 30) return null;
      const task = (async () => {
        if (active >= 2)
          await new Promise<void>((resolve) => queue.push(resolve));
        else active++;
        try {
          const value = await retrieve(key).catch(() => null);
          cache.delete(key);
          cache.set(key, {
            value,
            expires: now() + (value ? 86400_000 : 1800_000),
          });
          if (cache.size > 256) cache.delete(cache.keys().next().value!);
          return value;
        } finally {
          pending.delete(key);
          const next = queue.shift();
          if (next) next();
          else active--;
        }
      })();
      pending.set(key, task);
      return task;
    },
  };
}
