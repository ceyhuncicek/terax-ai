import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { imageMimeForPath } from "./mediaKind";

export type MediaObjectUrl = {
  url: string | null;
  error: string | null;
};

/** Loads image bytes over IPC and hands back a blob URL. Keeps images off the
 * asset protocol, whose scope refuses any path with a dot-prefixed component. */
export function useMediaObjectUrl(
  path: string,
  enabled: boolean,
): MediaObjectUrl {
  const [state, setState] = useState<MediaObjectUrl>({
    url: null,
    error: null,
  });

  useEffect(() => {
    if (!enabled) return;
    setState({ url: null, error: null });

    let cancelled = false;
    let objectUrl: string | null = null;
    invoke<ArrayBuffer>("fs_read_media", {
      path,
      workspace: currentWorkspaceEnv(),
    })
      .then((bytes) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: imageMimeForPath(path) }),
        );
        setState({ url: objectUrl, error: null });
      })
      .catch((e) => {
        if (!cancelled) setState({ url: null, error: String(e) });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, enabled]);

  return state;
}
