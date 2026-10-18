// Mastodon exports use handles, never the numeric IDs of the old instance.
export function accountHandle(
  value: unknown,
  localOrigin?: string,
): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^@/, "");
  const match = /^([\p{L}\p{N}_.-]+)(?:@([^\s/@:?#]+))?$/u.exec(text);
  if (!match || (!match[2] && !localOrigin)) return null;
  try {
    const host = new URL(
      match[2] ? "https://" + match[2] : localOrigin!,
    ).hostname
      .toLowerCase()
      .replace(/\.$/, "");
    if (!host.includes(".")) return null;
    return match[1].toLowerCase() + "@" + host;
  } catch {
    return null;
  }
}

export function accountIdentity(
  account: any,
  localOrigin: string,
): string | null {
  const handle = accountHandle(account?.acct, localOrigin);
  if (handle) return handle;
  // RSS and other Friends accounts can still be assigned manually to a list.
  if (typeof account?.url === "string") {
    try {
      const url = new URL(account.url);
      if (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      ) {
        url.hash = "";
        return "profile:" + url.href;
      }
    } catch {
      /* Fall back to an ID scoped to this WordPress site. */
    }
  }
  return account?.id ? "wordpress:" + localOrigin + ":" + account.id : null;
}
