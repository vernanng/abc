// Self-check for worktree directory naming: npm run check:worktree
// Regression guard for the bug where auto-revert worktrees were created at
// `revert-<sha>` but cleaned up / resolved at `revert/<sha>` (and `<sha>`),
// leaking worktrees and breaking conflict resolution on revert PRs.
import assert from "node:assert";
import { worktreeDirName } from "./worktree.js";

// Agent job branches: the `agent/` prefix is dropped, the rest is the job id.
assert.equal(worktreeDirName("agent/issue-42-4e5332da"), "issue-42-4e5332da");
assert.equal(worktreeDirName("agent/revert-1"), "revert-1");

// Revert branches: "revert/<sha>" -> "revert-<sha>" (a single directory name).
assert.equal(worktreeDirName("revert/ee2c52af"), "revert-ee2c52af");

// Invariant every caller relies on: a branch maps to ONE flat directory name,
// so create / remove / resolve all agree and `git worktree add` never targets
// a path where the branch is already checked out.
for (const branch of ["agent/issue-1-abcd1234", "revert/abcd1234", "agent/a/b"]) {
  const dir = worktreeDirName(branch);
  assert.ok(!dir.includes("/"), `worktree dir name must not contain '/': ${branch} -> ${dir}`);
  assert.equal(dir, worktreeDirName(branch), "must be deterministic");
}

// Distinct branches must not collide on the same directory.
assert.notEqual(worktreeDirName("agent/x"), worktreeDirName("revert/x"));

console.log("worktree checks passed");
