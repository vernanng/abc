// Pure naming for on-disk git worktrees (SPEC: one worktree per conversation /
// branch). Every site that creates a worktree, removes it, or runs conflict
// resolution in it must derive the same directory from the branch name, or the
// relative links break: worktrees leak on disk and `git worktree add` refuses a
// branch that is already checked out in another directory ("already checked
// out at ..."), which makes the sweeper retry that record forever.
//
// Kept in its own module (no service imports, no side effects) so it can be
// verified by `npm run check:worktree` without opening storage or a socket.
export function worktreeDirName(branch: string): string {
  // agent/<jobId> -> <jobId>; revert/<sha> -> revert-<sha>; never a "/".
  return branch.replace(/^agent\//, "").replace(/\//g, "-");
}
