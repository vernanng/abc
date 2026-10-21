// Pure derived data for the web console (SPEC Phase A): statistics over the
// durable journal and git-graph lane layout. Kept out of service.ts so the
// console check can verify it without opening storage or starting the server.

// Minimal shape of a journal record the console cares about. service.ts's
// DeliveryRecord structurally satisfies this.
export interface JournalRecord {
  delivery: string;
  kind?: "triage" | "job" | "review" | "cifail";
  issueNumber: number;
  title: string;
  login: string;
  posted: boolean;
  jobStatus?: string;
  prNumber?: number;
  approvalBy?: string;
  branch?: string;
  detectedAt?: number;
}

export interface ConsoleJob {
  delivery: string;
  kind: string;
  issueNumber: number;
  title: string;
  status: string;
  prNumber?: number;
  approvalBy?: string;
  branch?: string;
  login?: string;
  createdAt?: number;
}

export function consoleJobs(records: JournalRecord[]): ConsoleJob[] {
  return records
    .filter((record) => record.kind === "job" || record.kind === "cifail")
    .map((record) => ({
      delivery: record.delivery,
      kind: record.kind ?? "job",
      issueNumber: record.issueNumber,
      title: record.title,
      status: record.jobStatus ?? (record.posted ? "done" : "pending"),
      prNumber: record.prNumber,
      approvalBy: record.approvalBy,
      branch: record.branch,
      login: record.login,
      createdAt: record.detectedAt,
    }))
    .reverse(); // newest first
}

export interface ConsoleStats {
  jobs: number;
  byStatus: Record<string, number>;
  openPrs: number;
  merged: number;
  awaitingApproval: number;
  issues: number;
  triage: number;
  reviewers: number;
  ciFailures: number;
  activeJobs: number;
}

export function consoleStats(records: JournalRecord[]): ConsoleStats {
  const jobs = consoleJobs(records);
  const byStatus: Record<string, number> = {};
  for (const job of jobs) byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
  const count = (status: string): number => byStatus[status] ?? 0;
  return {
    jobs: jobs.length,
    byStatus,
    openPrs: jobs.filter((job) => job.prNumber !== undefined && job.status !== "merged" && job.status !== "closed").length,
    merged: count("merged"),
    awaitingApproval: count("pr-open"),
    issues: jobs.filter((job) => job.issueNumber > 0).length,
    triage: records.filter((record) => record.kind === undefined || record.kind === "triage").length,
    reviewers: records.filter((record) => record.kind === "review").length,
    ciFailures: records.filter((record) => record.kind === "cifail").length,
    activeJobs: jobs.filter((job) => job.status === "working" || job.status === "pr-open").length,
  };
}

export interface CommitInput { sha: string; shortSha: string; message: string; author: string; parents: string[] }
export interface GraphCommit { row: number; lane: number; sha: string; shortSha: string; message: string; author: string; isMerge: boolean }

// Lay out commits as rows for the git graph: newest at row 0, one `lane` per
// commit (0 = first-parent trunk, +1 for each side branch that opens).
export function layOutGraph(commits: CommitInput[]): GraphCommit[] {
  const laneOf = new Map<string, number>();
  let nextLane = 1;
  return commits.map((commit, row) => {
    let lane = laneOf.get(commit.sha);
    if (lane === undefined) {
      lane = 0; // first commit seen is the trunk tip
      laneOf.set(commit.sha, lane);
    }
    commit.parents.forEach((parent, index) => {
      // First parent continues the lane; extra parents (merges) open a lane.
      const parentLane = index === 0 ? lane : nextLane++;
      if (!laneOf.has(parent)) laneOf.set(parent, parentLane);
    });
    return { row, lane, sha: commit.sha, shortSha: commit.shortSha, message: commit.message, author: commit.author, isMerge: commit.parents.length > 1 };
  });
}
