import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  getSourceControlRemoteIndicator,
  type SourceControlSummary,
} from "@/modules/source-control";
import { CloudUploadIcon, GitBranchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";
import { toast } from "sonner";

const REMOTE_POLL_INTERVAL_MS = 5 * 60_000;

type Props = {
  sourceControl: SourceControlSummary;
};

export function GitSyncPill({ sourceControl }: Props) {
  const { hasRepo, repo, status, busyAction, refresh, runRemoteAction } =
    sourceControl;
  const branch = status?.branch ?? repo?.branch ?? null;
  const indicator = getSourceControlRemoteIndicator(sourceControl);

  // Keep behind/ahead counts fresh while the app idles; the summary hook
  // throttles the actual network fetch per repo.
  useEffect(() => {
    if (!hasRepo) return;
    const timer = window.setInterval(() => {
      void refresh({ remote: "auto" });
    }, REMOTE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasRepo, refresh]);

  if (!hasRepo || !branch || repo?.isDetached) return null;

  const busy = busyAction !== null;
  const actionable = indicator.visible && !indicator.disabled && !busy;

  const handleClick = async () => {
    if (!actionable || !indicator.action) return;
    const result = await runRemoteAction(indicator.action);
    if (!result.ok && result.error) toast.error(result.error);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void handleClick()}
          aria-disabled={!actionable}
          className={cn(
            "flex h-6 shrink-0 items-center gap-1 rounded-full bg-accent/70 px-2 text-[10.5px] font-medium text-muted-foreground transition-colors",
            actionable
              ? "cursor-pointer hover:bg-accent hover:text-foreground"
              : "cursor-default",
          )}
        >
          {busy ? (
            <Spinner className="size-3" />
          ) : (
            <HugeiconsIcon icon={GitBranchIcon} size={11} strokeWidth={2} />
          )}
          <span className="max-w-40 truncate">{branch}</span>
          {indicator.visible ? (
            indicator.action === "publish" ? (
              <HugeiconsIcon icon={CloudUploadIcon} size={11} strokeWidth={2} />
            ) : (
              <span className="tabular-nums">{indicator.label}</span>
            )
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-64 text-[11px] leading-relaxed"
      >
        {indicator.visible ? indicator.title : `On branch ${branch}.`}
      </TooltipContent>
    </Tooltip>
  );
}
