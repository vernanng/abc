// Self-check for the console's pure data helpers: npm run check:console
import assert from "node:assert";
import { buildGitGraph, computeStats, parseGitLog } from "./console-data.js";

// --- computeStats --------------------------------------------------------
const empty = computeStats([]);
assert.equal(empty.total, 0);
assert.equal(empty.approvalRate, 0);

const records = [
  { delivery: "ui-1", kind: "job" as const, issueNumber: 1, title: "a", prNumber: 10, approvalBy: "alice", jobStatus: "merged" },
  { delivery: "ui-2", kind: "job" as const, issueNumber: 2, title: "b", jobStatus: "working" },
  { delivery: "ui-3", kind: "job" as const, issueNumber: 3, title: "c", jobStatus: "failed", prNumber: 11 },
  { delivery: "t-9", kind: "triage" as const, issueNumber: 9, title: "ignore me", posted: true },
];
const stats = computeStats(records);
assert.equal(stats.total, 3, "triage records are not jobs");
assert.equal(stats.merged, 1);
assert.equal(stats.running, 1);
assert.equal(stats.failed, 1);
assert.equal(stats.withPr, 2);
assert.equal(stats.approved, 1);
assert.equal(Math.round(stats.approvalRate * 100), 33);
assert.equal(stats.byStatus.merged, 1);
assert.equal(stats.byKind.job, 3);

// --- parseGitLog ---------------------------------------------------------
const log = [
  "abc123\tAdd feature\tHEAD -> main, origin/main",
  "def456\tJob work\tagent/ui-26",
  "999999\tTagged release\ttag: v1.0.0",
].join("\n");
const parsed = parseGitLog(log);
assert.equal(parsed.length, 3);
assert.deepEqual(parsed[0].branches, ["main"], "HEAD -> prefix stripped, origin/ dropped");
assert.deepEqual(parsed[1].branches, ["agent/ui-26"]);
assert.deepEqual(parsed[2].branches, [], "tags and origin refs ignored");

// --- buildGitGraph -------------------------------------------------------
const graph = buildGitGraph(parsed);
assert.equal(graph.commits.length, 3);
assert.ok(graph.branches.some((branch) => branch.name === "agent/ui-26" && branch.agent));
assert.ok(graph.branches.every((branch) => branch.lane >= 0 && branch.lane < 6));
assert.ok(graph.lanes >= 1);

// Dedupes repeated SHAs and honors the maxCommits cap.
const dupes = buildGitGraph([parsed[0], parsed[0], parsed[1]], 1);
assert.equal(dupes.commits.length, 1);

console.log("console checks passed");
