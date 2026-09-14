import { invoke, isTauri } from "@tauri-apps/api/core";

export async function readTerminalClipboard(): Promise<string> {
  try {
    if (isTauri()) {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return await readText();
    }
    return (await navigator.clipboard?.readText()) ?? "";
  } catch {
    return "";
  }
}

/** Spills a clipboard image to a temp PNG and returns its path, so an agent CLI
 * reading the pasteboard itself still receives an attachment over the pty. */
export async function readTerminalClipboardImage(): Promise<string | null> {
  try {
    if (!isTauri()) return null;
    return await invoke<string | null>("clipboard_read_image_to_temp");
  } catch {
    return null;
  }
}

export async function writeTerminalClipboard(text: string): Promise<void> {
  if (isTauri()) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  }
  if (!navigator.clipboard) throw new Error("Clipboard is unavailable");
  await navigator.clipboard.writeText(text);
}
