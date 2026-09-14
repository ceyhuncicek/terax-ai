import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { type GitBranchEntry, native } from "@/modules/ai/lib/native";
import {
  CloudIcon,
  Folder01Icon,
  FolderGitTwoIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { filterBranches, groupBranches } from "./lib/branchPicker";
import { relativeTime } from "./CommitHistorySection";
import type { SourceControlRepositoryTarget } from "./repositoryTarget";

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

type Props = {
  repoRoot: string | null;
  repoLabel: string;
  displayRepoRoot: string | null;
  repositoryTarget: SourceControlRepositoryTarget;
  pending: boolean;
  onFollowRepositoryContext: () => void;
  onNavigateToPath?: (path: string) => void;
  onRefresh: () => void;
};

function BranchRow({
  entry,
  nowMs,
  onSelect,
}: {
  entry: GitBranchEntry;
  nowMs: number;
  onSelect: () => void;
}) {
  const icon =
    entry.kind === "worktree"
      ? Folder01Icon
      : entry.kind === "remote"
        ? CloudIcon
        : null;
  return (
    <CommandItem
      value={`${entry.kind}:${entry.worktreePath ?? entry.name}`}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2 text-[12px]"
    >
      {entry.isHead ? (
        <HugeiconsIcon
          icon={Tick02Icon}
          size={14}
          strokeWidth={1.8}
          className="shrink-0"
        />
      ) : icon ? (
        <HugeiconsIcon
          icon={icon}
          size={14}
          strokeWidth={1.5}
          className="shrink-0 text-muted-foreground"
        />
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{entry.name}</span>
        {entry.worktreePath ? (
          <span className="truncate text-[10px] text-muted-foreground">
            {entry.worktreePath}
          </span>
        ) : null}
      </div>
      {entry.committerDate ? (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/80">
          {relativeTime(entry.committerDate, nowMs)}
        </span>
      ) : null}
    </CommandItem>
  );
}

export function BranchPicker({
  repoRoot,
  repoLabel,
  displayRepoRoot,
  repositoryTarget,
  pending,
  onFollowRepositoryContext,
  onNavigateToPath,
  onRefresh,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [branches, setBranches] = useState<GitBranchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const requestRef = useRef(0);
  const checkoutInFlight = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const loadBranches = useCallback(async () => {
    const id = ++requestRef.current;
    if (!repoRoot) {
      setBranches([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await native.gitListBranches(repoRoot);
      if (id !== requestRef.current) return;
      setBranches(result.branches);
    } catch (e) {
      if (id !== requestRef.current) return;
      setError(String(e));
      setBranches([]);
    } finally {
      if (id === requestRef.current) {
        setLoading(false);
      }
    }
  }, [repoRoot]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setNowMs(Date.now());
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    void loadBranches();
    return () => cancelAnimationFrame(frame);
  }, [open, loadBranches]);

  const runCheckout = useCallback(
    async (run: () => Promise<unknown>) => {
      if (checkoutInFlight.current) return;
      checkoutInFlight.current = true;
      setCheckingOut(true);
      try {
        await run();
        setBranches([]);
        setOpen(false);
        onRefresh();
      } catch (e) {
        toast.error(String(e));
      } finally {
        checkoutInFlight.current = false;
        setCheckingOut(false);
      }
    },
    [onRefresh],
  );

  const handleSelect = useCallback(
    (entry: GitBranchEntry) => {
      if (entry.kind === "worktree") {
        if (entry.worktreePath && onNavigateToPath) {
          onNavigateToPath(entry.worktreePath);
          setOpen(false);
        }
        return;
      }
      if (!repoRoot || entry.isHead) {
        if (entry.isHead) setOpen(false);
        return;
      }
      void runCheckout(() =>
        entry.kind === "remote"
          ? native.gitCheckoutTrackingBranch(repoRoot, entry.name)
          : native.gitCheckoutBranch(repoRoot, entry.name),
      );
    },
    [onNavigateToPath, repoRoot, runCheckout],
  );

  const groups = useMemo(
    () => groupBranches(filterBranches(branches, query)),
    [branches, query],
  );
  const matchCount =
    groups.local.length + groups.worktree.length + groups.remote.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={checkingOut}
          title={displayRepoRoot ?? repoLabel}
          className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md bg-foreground/5 px-2 py-1 text-[11.5px] font-medium leading-none text-foreground transition-colors hover:bg-foreground/10 disabled:cursor-default disabled:opacity-70"
        >
          <HugeiconsIcon
            icon={FolderGitTwoIcon}
            size={12}
            strokeWidth={1.9}
            className="shrink-0 text-muted-foreground"
          />
          {displayRepoRoot ? (
            <>
              <span className="max-w-22 truncate">
                {basename(displayRepoRoot)}
              </span>
              <span className="text-muted-foreground/60">/</span>
            </>
          ) : null}
          <span className="max-w-24 truncate">{repoLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 gap-0 rounded-xl p-0"
        onOpenAutoFocus={(event) => {
          // let the search input take focus instead of the first row
          event.preventDefault();
        }}
      >
        {displayRepoRoot ? (
          <div className="border-b border-border/50 px-2.5 py-2">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85">
              Repository
            </div>
            <div
              className="truncate pt-0.5 text-[11px] text-muted-foreground"
              title={displayRepoRoot}
            >
              {displayRepoRoot}
            </div>
            {repositoryTarget.mode === "fixed" ? (
              <button
                type="button"
                onClick={() => {
                  onFollowRepositoryContext();
                  setOpen(false);
                }}
                className="mt-1.5 cursor-pointer text-[11.5px] text-foreground/90 underline-offset-2 hover:underline"
              >
                Follow Active Context
              </button>
            ) : null}
          </div>
        ) : null}
        <Command shouldFilter={false} className="rounded-none bg-transparent">
          <CommandInput
            ref={inputRef}
            placeholder="Search branches"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-[min(60vh,320px)] py-1">
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-muted-foreground">
                <Spinner className="size-3" />
                Loading branches…
              </div>
            ) : error ? (
              <div className="px-3 py-3 text-[11px] leading-snug text-destructive">
                {error}
              </div>
            ) : pending ? (
              <div className="px-3 py-3 text-[11px] text-muted-foreground">
                Loading repository…
              </div>
            ) : branches.length === 0 ? (
              <div className="px-3 py-3 text-[11px] text-muted-foreground">
                No branches found.
              </div>
            ) : matchCount === 0 ? (
              <CommandEmpty className="px-3 py-3 text-left text-[11px] text-muted-foreground">
                No branch matches "{query.trim()}".
              </CommandEmpty>
            ) : (
              <>
                {groups.local.length > 0 ? (
                  <CommandGroup heading="Local Branches">
                    {groups.local.map((entry) => (
                      <BranchRow
                        key={`local:${entry.name}`}
                        entry={entry}
                        nowMs={nowMs}
                        onSelect={() => handleSelect(entry)}
                      />
                    ))}
                  </CommandGroup>
                ) : null}
                {groups.worktree.length > 0 ? (
                  <CommandGroup heading="Worktrees">
                    {groups.worktree.map((entry) => (
                      <BranchRow
                        key={`worktree:${entry.worktreePath ?? entry.name}`}
                        entry={entry}
                        nowMs={nowMs}
                        onSelect={() => handleSelect(entry)}
                      />
                    ))}
                  </CommandGroup>
                ) : null}
                {groups.remote.length > 0 ? (
                  <CommandGroup heading="Remote Branches">
                    {groups.remote.map((entry) => (
                      <BranchRow
                        key={`remote:${entry.name}`}
                        entry={entry}
                        nowMs={nowMs}
                        onSelect={() => handleSelect(entry)}
                      />
                    ))}
                  </CommandGroup>
                ) : null}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
