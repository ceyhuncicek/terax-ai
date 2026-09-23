function normalizePosix(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  return absolute ? `/${out.join("/")}` : out.join("/");
}

/** Resolves a markdown `![](src)` target to an absolute filesystem path the
 * caller can hand to `convertFileSrc`. Returns `null` when the src already
 * addresses something the webview can load on its own (`http(s):`, `data:`,
 * `blob:`, …) or when it cannot be resolved, in which case it should be
 * rendered untouched. */
export function resolveMarkdownImageSrc(
  src: string,
  mdFileDir: string,
  homeDir: string | null = null,
): string | null {
  const target = src.trim().replace(/\\/g, "/");
  if (target.length === 0) return null;
  // Anything carrying a URI scheme is already addressable as-is.
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  if (target.startsWith("//")) return null;

  if (target.startsWith("/")) return normalizePosix(target);

  // A markdown file sitting at the filesystem root has an empty directory,
  // which still resolves relative sources against `/`.
  const base =
    target === "~" || target.startsWith("~/")
      ? homeDir?.replace(/\\/g, "/")
      : mdFileDir.replace(/\\/g, "/") || "/";
  if (!base) return null;

  const relative = target.startsWith("~") ? target.slice(1) : `/${target}`;
  const resolved = normalizePosix(`${base}${relative}`);
  return resolved.length === 0 ? null : resolved;
}
