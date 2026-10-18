// Preview images load in the browser, without a referrer. Only accept HTTPS
// URLs on named hosts; omit credentials, unusual ports and local/IP targets.
export function previewImageUrl(input: unknown, base?: string): string {
  if (typeof input !== "string" || !input.trim() || input.length > 4096)
    return "";
  try {
    const u = new URL(input, base);
    const host = u.hostname.replace(/\.$/, "");
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      !host.includes(".") ||
      host.includes(":") ||
      /^[\d.]+$/.test(host) ||
      /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)
    )
      return "";
    return u.href;
  } catch {
    return "";
  }
}
