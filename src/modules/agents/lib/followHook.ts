/** Agreement between the stored preference and the hook found in the file. */
export type FollowHookStatus = "ok" | "missing" | "stale";

export type FollowHookState = {
  /** What the toggle shows. */
  checked: boolean;
  status: FollowHookStatus;
};

/**
 * The file wins whenever we managed to read it, so the toggle never claims a
 * hook that is not there: the user can edit the JSON by hand and writes fail.
 */
export function reconcileFollowHook(
  preferred: boolean,
  installed: boolean | null,
): FollowHookState {
  if (installed === null) return { checked: preferred, status: "ok" };
  if (installed === preferred) return { checked: installed, status: "ok" };
  return { checked: installed, status: installed ? "stale" : "missing" };
}
