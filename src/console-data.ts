// Pure, dependency-free helpers that shape the numbers and git graph the web
// console renders. Kept out of service.ts so they can be unit-checked in CI
// without a running harness (see src/console.check.ts).

export interface JournalLike {
  delivery: string;
  kind?: "triage" | "job" | "review" | "cifail";
  issueNumber: number;
  title: string;
  prNumber?: number;
  jobStatus?: string;
  posted?: boolean;
  approvalBy?: string;
}

export interface Stats {
  total: number;
  byStatus: Record<string, number>;
  byKind: Record<string, number>;
  withPr: number;
  approved: number;
  merged: number;
  failed: number;
  running: number;
  approvalRate: number; // approved / total jobs, 0 when no jobs
}

const RUNNING_STATUSES = new Set(["working", "pending"]);
const TERMINAL_BAD = new Set(["failed", "parked", "no-changes", "closed"]);

export function computeStats(records: readonly JournalLike[]): Stats {
  const jobs = records.filter((record) => record.kind === "job" || record.kind === "cifail");
  const byStatus: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  let withPr = 0;
  let approved = 0;
  let merged = 0;
  let failed = 0;
  let running = 0;
  for (const record of jobs) {
    const status = record.jobStatus ?? (record.posted ? "done" : "pending");
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const kind = record.kind ?? "triage";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (record.prNumber !== undefined) withPr += 1;
    if (record.approvalBy !== undefined) approved += 1;
    if (status === "merged") merged += 1;
    if (TERMINAL_BAD.has(status)) failed += 1;
    if (RUNNING_STATUSES.has(status)) running += 1;
  }
  return {
    total: jobs.length,
    byStatus,
    byKind,
    withPr,
    approved,
    merged,
    failed,
    running,
    approvalRate: jobs.length === 0 ? 0 : approved / jobs.length,
  };
}

export interface CommitNode {
  sha: string;
  subject: string;
  refs: string[];
  /** Column/lane index this commit sits in, for rendering the graph. */
  lane: number;
}

export interface BranchLine {
  name: string;
  sha: string;
  /** Lane index of the branch tip, matching its commit node. */
  lane: number;
  /** True for branches tied to a job (agent/<jobId> or ui-*). */
  agent: boolean;
}

export interface GitGraph {
  branches: BranchLine[];
  commits: CommitNode[];
  lanes: number;
}

export interface RawCommit {
  sha: string;
  subject: string;
  branches: string[]; // branch names pointing at / containing this commit
}

// Assign a display lane per branch tip, then tint commit dots by the branches
// that carry them. Newest-first input; commits keep their input order.
export function buildGitGraph(raw: readonly RawCommit[], maxCommits = 40): GitGraph {
  const laneOfBranch = new Map<string, number>();
  const branchNames = new Set<string>();
  for (const commit of raw) for (const branch of commit.branches) branchNames.add(branch);
  const sortedBranches = [...branchNames].sort();
  sortedBranches.forEach((name, index) => laneOfBranch.set(name, index % 6));

  const seen = new Set<string>();
  const commits: CommitNode[] = [];
  for (const commit of raw.slice(0, maxCommits)) {
    if (seen.has(commit.sha)) continue;
    seen.add(commit.sha);
    const lane = commit.branches.length > 0 ? (laneOfBranch.get(commit.branches[0]) ?? 0) : 5;
    commits.push({ sha: commit.sha, subject: commit.subject, refs: [...commit.branches], lane });
  }
  return {
    branches: sortedBranches.map((name) => ({ name, sha: "", lane: laneOfBranch.get(name) ?? 0, agent: /agent\//.test(name) })),
    commits,
    lanes: Math.min(sortedBranches.length, 6) || 1,
  };
}

// Parse `git log --pretty=format:%H%x09%s%x09%D --all` output into RawCommits.
export function parseGitLog(output: string): RawCommit[] {
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [sha = "", subject = "", decoration = ""] = line.split("\t");
      const branches = decoration
        .split(",")
        .map((ref) => ref.trim())
        .filter((ref) => ref.startsWith("HEAD -> ") || (!ref.includes("-> ") && ref !== "HEAD" && ref.length > 0))
        .map((ref) => (ref.startsWith("HEAD -> ") ? ref.slice("HEAD -> ".length) : ref))
        .filter((ref) => !/^(tag:|origin\/)/.test(ref));
      return { sha, subject, branches };
    });
}
