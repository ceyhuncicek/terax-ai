const AUTHOR_TINTS = [
  "#7aa2f7", // soft blue
  "#bb9af7", // soft purple
  "#9ece6a", // soft green
  "#e0af68", // soft amber
  "#f7768e", // soft rose
  "#73daca", // soft teal
  "#ff9e64", // soft orange
  "#b4f9f8", // pale cyan
];

const GITHUB_NOREPLY_SUFFIX = "@users.noreply.github.com";

export function authorInitials(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

export function authorTint(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return AUTHOR_TINTS[Math.abs(hash) % AUTHOR_TINTS.length];
}

export function normalizeAuthorEmail(email: string): string {
  return (email ?? "").trim().toLowerCase();
}

function pixelSize(size: number): number {
  if (!Number.isFinite(size)) return 1;
  return Math.max(1, Math.round(size));
}

function isGithubLogin(login: string): boolean {
  return login.length > 0 && !/[\s/?#]/.test(login);
}

/**
 * GitHub noreply addresses identify the account directly, so they resolve
 * without handing the email to a third party.
 */
export function githubAvatarUrl(email: string, size: number): string | null {
  const normalized = normalizeAuthorEmail(email);
  if (!normalized.endsWith(GITHUB_NOREPLY_SUFFIX)) return null;
  const local = normalized.slice(0, -GITHUB_NOREPLY_SUFFIX.length);
  const px = pixelSize(size);
  const plus = local.indexOf("+");
  if (plus < 0) {
    if (!isGithubLogin(local)) return null;
    return `https://github.com/${local}.png?size=${px}`;
  }
  const id = local.slice(0, plus);
  const login = local.slice(plus + 1);
  if (!/^\d+$/.test(id)) return null;
  if (!isGithubLogin(login)) return null;
  return `https://avatars.githubusercontent.com/u/${id}?s=${px}`;
}

/**
 * `d=404` makes Gravatar answer 404 instead of a generic image, so an author
 * with no avatar falls back to initials rather than caching a placeholder.
 */
export function gravatarUrl(hashHex: string, size: number): string {
  return `https://www.gravatar.com/avatar/${hashHex}?s=${pixelSize(size)}&d=404`;
}
