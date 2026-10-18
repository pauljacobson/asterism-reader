// Friends currently federates boosts publicly. Unknown visibility and ordinary
// RSS identities fail closed; an existing boost can still be undone later.
export function canBoost(post: any, ownerId?: string) {
  if (post?.visibility !== "public") return false;
  const acct = post.account?.acct;
  const federated =
    typeof acct === "string" && /^[^@\s/:]+@[^@\s/:]+\.[^@\s/:]+$/.test(acct);
  if (!federated && (!ownerId || String(post.account?.id) !== ownerId))
    return false;
  try {
    const source = new URL(post.uri || post.url);
    return (
      ["https:", "http:"].includes(source.protocol) &&
      !source.username &&
      !source.password
    );
  } catch {
    return false;
  }
}
