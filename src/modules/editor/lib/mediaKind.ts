export type MediaKind = "image" | "video" | "audio" | "pdf" | null;

const IMAGE_MIME = new Map<string, string>([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["ico", "image/x-icon"],
]);

const VIDEO_EXT = new Set(["mp4", "webm", "ogg", "mov"]);
const AUDIO_EXT = new Set(["mp3", "wav", "flac", "aac", "m4a"]);

/** Lowercased extension of the last path segment, "" when there is none. A dot
 * in a parent directory must not leak in, and a leading dot names a dotfile
 * rather than an extension. */
function extensionOf(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function mediaKindForPath(path: string): MediaKind {
  const ext = extensionOf(path);
  if (IMAGE_MIME.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  return null;
}

export function imageMimeForPath(path: string): string {
  return IMAGE_MIME.get(extensionOf(path)) ?? "application/octet-stream";
}
