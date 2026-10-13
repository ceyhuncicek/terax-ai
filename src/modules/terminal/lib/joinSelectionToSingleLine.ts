/** Joins text that a TUI hard-wrapped across lines back into one pasteable line. */
export function joinSelectionToSingleLine(text: string): string {
  const parts: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    let line = raw.trim();
    const continuation = /(\\+)$/.exec(line);
    // An odd run of trailing backslashes is a shell line continuation.
    if (continuation && continuation[1].length % 2 === 1) {
      line = line.slice(0, -1).trimEnd();
    }
    if (line) parts.push(line);
  }
  return parts.join(" ");
}
