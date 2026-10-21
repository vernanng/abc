// Self-check for the console's derived data (SPEC Phase A): statistics over
// the durable journal and the git-graph lane layout. Both are pure, so they
// can be verified without GitHub or a running service. npm run check:console
import assert from "node:assert";
import { consoleJobs, consoleStats, layOutGraph, type JournalRecord } from "./console-data.js";

const records: JournalRecord[] = [
  { delivery: "triage-1", issueNumber: 1, title: "t", login: "a", posted: true },
  { delivery: "job-2", kind: "job", issueNumber: 2, title: "one", login: "a", posted: true, jobStatus: "merged", prNumber: 7, approvalBy: "a", branch: "agent/2" },
  { delivery: "job-3", kind: "job", issueNumber: 3, title: "two", login: "a", posted: false, jobStatus: "working", branch: "agent/3" },
  { delivery: "job-4", kind: "job", issueNumber: 4, title: "three", login: "a", posted: true, jobStatus: "pr-open", prNumber: 8 },
  { delivery: "cifail-x", kind: "cifail", issueNumber: 9, title: "ci", login: "abc-agent-system", posted: false },
  { delivery: "review-9", kind: "review", issueNumber: 8, title: "", login: "a", posted: true, prNumber: 8 },
];

const jobs = consoleJobs(records);
// Newest first: cifail and job-4 come after job-3, job-2; triage is excluded.
assert.equal(jobs.length, 4);
assert.equal(jobs[0]?.kind, "cifail");
assert.ok(jobs.every((job) => job.kind !== "triage"));
// Status falls back to "pending" when unposted and no jobStatus set.
assert.equal(jobs[0]?.status, "pending");
assert.equal(jobs.find((job) => job.delivery === "job-2")?.status, "merged");

const stats = consoleStats(records);
assert.equal(stats.jobs, 4);
assert.equal(stats.merged, 1);
assert.equal(stats.awaitingApproval, 1);
assert.equal(stats.openPrs, 1); // only PR #8 (pr-open); #7 is merged
assert.equal(stats.ciFailures, 1);
assert.equal(stats.triage, 1);
assert.equal(stats.reviewers, 1);
assert.equal(stats.activeJobs, 2); // working + pr-open
assert.equal(stats.byStatus.merged, 1);
assert.equal(stats.byStatus.pending, 1);

// Linear history stays on one lane (trunk = 0).
const linear = layOutGraph([
  { sha: "c3", shortSha: "c3", message: "three", author: "a", parents: ["c2"] },
  { sha: "c2", shortSha: "c2", message: "two", author: "a", parents: ["c1"] },
  { sha: "c1", shortSha: "c1", message: "one", author: "a", parents: [] },
]);
assert.deepEqual(linear.map((commit) => commit.lane), [0, 0, 0]);
assert.ok(linear.every((commit) => !commit.isMerge));

// A merge opens a side lane; the side branch commit keeps it.
const merged = layOutGraph([
  { sha: "m", shortSha: "m", message: "merge", author: "a", parents: ["b", "s"] },
  { sha: "b", shortSha: "b", message: "trunk", author: "a", parents: ["r"] },
  { sha: "s", shortSha: "s", message: "side", author: "a", parents: ["r"] },
  { sha: "r", shortSha: "r", message: "root", author: "a", parents: [] },
]);
assert.equal(merged[0]?.isMerge, true);
assert.equal(merged[0]?.lane, 0);
assert.equal(merged[1]?.lane, 0); // first parent continues trunk
assert.ok((merged[2]?.lane ?? 0) > 0); // side branch gets its own lane
assert.equal(merged[3]?.lane, 0); // shared root stays on trunk

console.log("console checks passed");
