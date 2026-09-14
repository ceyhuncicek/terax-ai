export type TerminalLinkTarget =
  | { readonly kind: "url"; readonly url: string }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly line?: number;
      readonly column?: number;
    };

export interface TerminalLinkMatch {
  readonly start: number;
  readonly end: number;
  readonly target: TerminalLinkTarget;
}

const MAX_LINKS = 256;

const URL_PATTERN = /(?:https?:\/\/|mailto:)[^\s<>"'`\u0000-\u001f\u007f]+/giu;

const SEGMENT_CHAR = String.raw`[\p{L}\p{N}_.+\-@#$%~]`;
const SEGMENTS = String.raw`(?:${SEGMENT_CHAR}+\/)*${SEGMENT_CHAR}+\/?`;
const POSITION = String.raw`(?::(\d{1,9})(?::(\d{1,9}))?|\((\d{1,9})(?:,\s?(\d{1,9}))?\))?`;
const FILE_PATTERN = new RegExp(
  `(~\\/(?:${SEGMENTS})?|(?:\\.{1,2}\\/)+(?:${SEGMENTS})?|\\/${SEGMENTS}|${SEGMENTS})${POSITION}`,
  "gu",
);

const EXTENSION = /\.\p{L}[\p{L}\p{N}_]{0,9}$/u;
const LETTER = /\p{L}/u;

interface Range {
  readonly start: number;
  readonly end: number;
}

function trimUnbalancedWrappers(uri: string): string {
  const opens = "([{";
  const closes = ")]}";
  const balance = [0, 0, 0];
  for (let index = 0; index < uri.length; index++) {
    const open = opens.indexOf(uri[index]);
    const close = closes.indexOf(uri[index]);
    if (open >= 0) balance[open]++;
    if (close >= 0) balance[close]--;
  }
  let end = uri.length;
  while (end > 0) {
    const close = closes.indexOf(uri[end - 1]);
    if (close < 0 || balance[close] >= 0) break;
    balance[close]++;
    end--;
  }
  return uri.slice(0, end);
}

function detectUrls(
  text: string,
  blocked: Range[],
): { readonly start: number; readonly end: number; readonly url: string }[] {
  const urls: { start: number; end: number; url: string }[] = [];
  URL_PATTERN.lastIndex = 0;
  for (
    let match = URL_PATTERN.exec(text);
    match && urls.length < MAX_LINKS;
    match = URL_PATTERN.exec(text)
  ) {
    const uri = trimUnbalancedWrappers(match[0].replace(/[.,;:!?]+$/, ""));
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "mailto:" && !parsed.hostname) continue;
      urls.push({
        start: match.index,
        end: match.index + uri.length,
        url: uri,
      });
      blocked.push({ start: match.index, end: match.index + match[0].length });
    } catch {
      /* Incomplete URLs stay ordinary terminal text. */
    }
  }
  return urls;
}

function hasExtension(segment: string): boolean {
  return EXTENSION.test(segment);
}

// Conservative on purpose: opening the wrong file is worse than missing a link.
function isPlausibleFilePath(path: string, hasPosition: boolean): boolean {
  if (path.startsWith("~/") || path.startsWith("./") || path.startsWith("../"))
    return true;
  if (!LETTER.test(path)) return false;

  const absolute = path.startsWith("/");
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (!absolute && segments.length < 2)
    return hasPosition && hasExtension(path);

  const last = segments[segments.length - 1];
  const substantial =
    path.endsWith("/") ||
    hasPosition ||
    (last !== undefined && hasExtension(last));
  return substantial || segments.length >= (absolute ? 2 : 3);
}

function detectFiles(
  text: string,
  blocked: readonly Range[],
): TerminalLinkMatch[] {
  const files: TerminalLinkMatch[] = [];
  FILE_PATTERN.lastIndex = 0;
  for (
    let match = FILE_PATTERN.exec(text);
    match && files.length < MAX_LINKS;
    match = FILE_PATTERN.exec(text)
  ) {
    const start = match.index;
    const end = start + match[0].length;
    const previous = start > 0 ? text[start - 1] : "";
    // Guards against scheme tails (`ftp://host/a`) and Windows separators.
    if (previous === ":" || previous === "/" || previous === "\\") continue;
    if (blocked.some((range) => start < range.end && range.start < end))
      continue;

    const line = match[2] ?? match[4];
    const column = match[3] ?? match[5];
    const hasPosition = line !== undefined;
    let path = match[1];
    let pathEnd = start + path.length;
    if (!hasPosition) {
      const trimmed = path.replace(/\.+$/, "");
      pathEnd -= path.length - trimmed.length;
      path = trimmed;
    }
    if (!isPlausibleFilePath(path, hasPosition)) continue;

    files.push({
      start,
      end: hasPosition ? end : pathEnd,
      target: {
        kind: "file",
        path,
        ...(line === undefined ? {} : { line: Number(line) }),
        ...(column === undefined ? {} : { column: Number(column) }),
      },
    });
  }
  return files;
}

export function detectTerminalLinks(
  text: string,
): readonly TerminalLinkMatch[] {
  const blocked: Range[] = [];
  const urls = detectUrls(text, blocked).map<TerminalLinkMatch>((url) => ({
    start: url.start,
    end: url.end,
    target: { kind: "url", url: url.url },
  }));
  const links = [...urls, ...detectFiles(text, blocked)];
  links.sort((left, right) => left.start - right.start);
  return links.length > MAX_LINKS ? links.slice(0, MAX_LINKS) : links;
}

function normalizePosix(input: string): string {
  const absolute = input.startsWith("/");
  const out: string[] = [];
  for (const segment of input.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      const last = out[out.length - 1];
      if (out.length > 0 && last !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  return absolute ? `/${out.join("/")}` : out.join("/");
}

export function resolveFileLinkPath(
  path: string,
  cwd: string | null,
  homeDir: string | null,
): string | null {
  if (path.length === 0) return null;
  const target = path.replace(/\\/g, "/");
  if (target.startsWith("/")) return normalizePosix(target);

  const base =
    target === "~" || target.startsWith("~/")
      ? homeDir?.replace(/\\/g, "/")
      : cwd?.replace(/\\/g, "/");
  if (!base) return null;

  const relative = target.startsWith("~") ? target.slice(1) : `/${target}`;
  const resolved = normalizePosix(`${base}${relative}`);
  return resolved.length === 0 ? null : resolved;
}
