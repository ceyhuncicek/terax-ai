import { MarkdownCode } from "@/components/ai-elements/markdown-code";
import { cn } from "@/lib/utils";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { type ComponentProps, useEffect, useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import { resolveMarkdownImageSrc } from "./lib/resolveMarkdownImageSrc";
import { MarkdownLink } from "./MarkdownLink";
import { MarkdownViewToggle } from "./MarkdownViewToggle";

// Resolved once per process; panes mounted before it lands subscribe and
// re-render so `~/`-relative images stop rendering as their literal source.
let cachedHome: string | null = null;
const homePath: Promise<string | null> = homeDir()
  .then((h) => {
    cachedHome = h.replace(/\\/g, "/").replace(/\/+$/, "");
    return cachedHome;
  })
  .catch(() => null);

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type Status =
  | { kind: "loading" }
  | { kind: "ready"; content: string }
  | { kind: "binary" }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "error"; message: string };

type Props = {
  path: string;
  visible: boolean;
  onSetView: (mode: "rendered" | "raw") => void;
};

type MarkdownImageProps = ComponentProps<"img"> & { node?: unknown };

function markdownComponents(mdFileDir: string, home: string | null) {
  return {
    a: MarkdownLink,
    code: MarkdownCode,
    img: ({ alt, node: _node, src, ...props }: MarkdownImageProps) => {
      const resolved =
        typeof src === "string"
          ? resolveMarkdownImageSrc(src, mdFileDir, home)
          : null;
      return (
        <img
          {...props}
          alt={alt ?? ""}
          src={resolved ? convertFileSrc(resolved) : src}
        />
      );
    },
  };
}

export function MarkdownPreviewPane({ path, visible, onSetView }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [home, setHome] = useState<string | null>(cachedHome);
  const components = useMemo(
    () =>
      markdownComponents(
        path.replace(/\\/g, "/").replace(/\/[^/]*$/, ""),
        home,
      ),
    [path, home],
  );

  useEffect(() => {
    if (home !== null) return;
    let cancelled = false;
    void homePath.then((h) => {
      if (!cancelled) setHome(h);
    });
    return () => {
      cancelled = true;
    };
  }, [home]);

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading" });
    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
    })
      .then((res) => {
        if (cancelled) return;
        if (res.kind === "text") {
          setStatus({ kind: "ready", content: res.content });
        } else if (res.kind === "binary") {
          setStatus({ kind: "binary" });
        } else {
          setStatus({ kind: "toolarge", size: res.size, limit: res.limit });
        }
      })
      .catch((e) => {
        if (!cancelled) setStatus({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden bg-background",
        !visible && "pointer-events-none",
      )}
    >
      <MarkdownViewToggle mode="rendered" onChange={onSetView} />
      <div className="flex-1 overflow-auto">
        <div className="px-8 py-6">
          {status.kind === "loading" && (
            <p className="text-[12px] text-muted-foreground">Loading…</p>
          )}
          {status.kind === "error" && (
            <p className="text-[12px] text-destructive">
              Failed to read file: {status.message}
            </p>
          )}
          {status.kind === "binary" && (
            <p className="text-[12px] text-muted-foreground">
              Binary file — cannot render as markdown.
            </p>
          )}
          {status.kind === "toolarge" && (
            <p className="text-[12px] text-muted-foreground">
              File is {status.size} bytes; limit {status.limit}.
            </p>
          )}
          {status.kind === "ready" && (
            <Streamdown
              className="select-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              components={components}
              mode="static"
              parseIncompleteMarkdown={false}
            >
              {status.content}
            </Streamdown>
          )}
        </div>
      </div>
    </div>
  );
}
