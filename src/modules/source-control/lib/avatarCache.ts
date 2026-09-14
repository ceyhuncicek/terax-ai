import {
  githubAvatarUrl,
  gravatarUrl,
  normalizeAuthorEmail,
} from "./authorAvatar";

// One size for every call site: the cache is keyed by email only, so a single
// request serves every row and every avatar box.
const AVATAR_REQUEST_SIZE = 64;

const resolved = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchAvatar(email: string): Promise<string | null> {
  if (!email.includes("@")) return null;
  const direct = githubAvatarUrl(email, AVATAR_REQUEST_SIZE);
  const url =
    direct ?? gravatarUrl(await sha256Hex(email), AVATAR_REQUEST_SIZE);
  const response = await fetch(url);
  if (!response.ok) return null;
  const blob = await response.blob();
  if (blob.size === 0) return null;
  // The app CSP forbids remote img sources but allows blob:, so the bytes have
  // to come through fetch and be handed to the img tag as an object URL.
  return URL.createObjectURL(blob);
}

/**
 * Synchronous cache read. `undefined` means not resolved yet, `null` means the
 * author is known to have no avatar.
 */
export function peekAuthorAvatar(email: string): string | null | undefined {
  return resolved.get(normalizeAuthorEmail(email));
}

/**
 * Misses are cached for the session, including failures, so a repo full of
 * commits by the same handful of authors costs one request per author.
 */
export function resolveAuthorAvatar(email: string): Promise<string | null> {
  const key = normalizeAuthorEmail(email);
  const cached = resolved.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = fetchAvatar(key)
    .catch(() => null)
    .then((url) => {
      resolved.set(key, url);
      inflight.delete(key);
      return url;
    });
  inflight.set(key, task);
  return task;
}
