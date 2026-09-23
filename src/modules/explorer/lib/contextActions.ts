import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Best-effort; ignore in environments without clipboard permission.
  }
}

export function relativePath(rootPath: string, path: string): string {
  if (path === rootPath) return ".";
  if (path.startsWith(`${rootPath}/`)) return path.slice(rootPath.length + 1);
  return path;
}

export async function revealInFinder(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch (e) {
    console.error("revealItemInDir failed:", e);
  }
}

export async function openInDefaultApp(path: string): Promise<boolean> {
  try {
    await openPath(path);
    return true;
  } catch (e) {
    console.error("openPath failed:", e);
    return false;
  }
}

/** Menu-facing wrapper: `openInDefaultApp` reports failure through its return
 * value, which a bare `void` call site would otherwise drop on the floor. */
export async function openInDefaultAppOrWarn(path: string): Promise<void> {
  if (!(await openInDefaultApp(path))) {
    toast.error("Could not open in the default app");
  }
}
