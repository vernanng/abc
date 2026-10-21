import { Fragment, h, render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { filterJobs, isActiveJob, relativeAge, statusTone } from "../../src/console-data.js";

interface Job {
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
interface Msg { role: string; text: string }
interface Stats {
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
interface GraphCommit {
  row: number;
  lane: number;
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  isMerge: boolean;
}

const issueUrl = (repo: string, n: number): string => `https://github.com/${repo}/issues/${n}`;
const prUrl = (repo: string, n: number): string => `https://github.com/${repo}/pull/${n}`;
const commitUrl = (repo: string, sha: string): string => `https://github.com/${repo}/commit/${sha}`;

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json() as Promise<T>;
};

const toneClass = (status: string): string => `badge badge-${statusTone(status)}`;

function StatusBadge({ status }: { status: string }) {
  return <span class={toneClass(status)}>{status}</span>;
}

function Stats({ stats }: { stats: Stats | undefined }) {
  if (stats === undefined) return <p class="muted">Loading statistics…</p>;
  const cards: Array<[string, number | string, string]> = [
    ["Jobs", stats.jobs, "queued"],
    ["Active", stats.activeJobs, "active"],
    ["Open PRs", stats.openPrs, "active"],
    ["Awaiting approval", stats.awaitingApproval, "active"],
    ["Merged", stats.merged, "good"],
    ["CI failures", stats.ciFailures, "bad"],
    ["Triage", stats.triage, "muted"],
    ["Reviewers", stats.reviewers, "muted"],
  ];
  return (
    <div class="cards">
      {cards.map(([label, value, tone]) => (
        <div class={`card card-${tone}`} key={label}>
          <div class="card-value">{value}</div>
          <div class="muted">{label}</div>
        </div>
      ))}
    </div>
  );
}

function GitGraph({ repo, commits }: { repo: string; commits: GraphCommit[] }) {
  if (commits.length === 0) return <p class="muted">No commits loaded (GitHub unavailable or empty branch).</p>;
  return (
    <table class="graph">
      <tbody>
        {commits.map((commit) => (
          <tr key={commit.sha}>
            <td class="sha">
              <a href={commitUrl(repo, commit.sha)} target="_blank" rel="noreferrer">
                {commit.shortSha}
              </a>
            </td>
            <td class="lane">
              {Array.from({ length: commit.lane }).map((_, i) => (
                <span class="lane-gap" key={i} />
              ))}
              <span class={`node ${commit.isMerge ? "merge" : ""}`} />
            </td>
            <td>{commit.message}</td>
            <td class="muted">{commit.author}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Job statuses surface as filter tabs; "all" plus any status present in the
// journal. Ordering is fixed so tabs do not jump around as data changes.
const TAB_ORDER = ["all", "working", "pr-open", "merged", "parked", "failed", "no-changes", "pending", "closed", "resolved"];

function JobsTable({
  repo,
  jobs,
  who,
  onSelect,
}: {
  repo: string;
  jobs: Job[];
  who: string;
  onSelect: (delivery: string) => void;
}) {
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const now = Date.now();
  const tabs = TAB_ORDER.filter((tab) => tab === "all" || jobs.some((job) => job.status === tab));
  const visible = filterJobs(jobs, status, query);
  return (
    <>
      <div class="toolbar">
        <div class="tabs">
          {tabs.map((tab) => {
            const count = tab === "all" ? jobs.length : jobs.filter((job) => job.status === tab).length;
            return (
              <button key={tab} class={`tab ${status === tab ? "on" : ""}`} onClick={() => setStatus(tab)}>
                {tab} <span class="muted">{count}</span>
              </button>
            );
          })}
        </div>
        <input
          class="search"
          type="search"
          placeholder="Filter by title, branch, issue or author…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
      </div>
      <table class="jobs">
        <thead>
          <tr>
            <th>Issue</th>
            <th>Title</th>
            <th>Status</th>
            <th>Branch</th>
            <th>PR</th>
            <th>Age</th>
          </tr>
        </thead>
        <tbody>
          <tr class={who === "triage" ? "sel" : ""} onClick={() => onSelect("triage")}>
            <td>—</td>
            <td>triage conversation <span class="muted">(Phase B root)</span></td>
            <td><span class="badge badge-muted">root</span></td>
            <td class="muted">—</td>
            <td class="muted">—</td>
            <td class="muted">—</td>
          </tr>
          {visible.map((job) => (
            <tr key={job.delivery} class={who === job.delivery ? "sel" : ""} onClick={() => onSelect(job.delivery)}>
              <td>
                <a href={issueUrl(repo, job.issueNumber)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                  #{job.issueNumber}
                </a>
              </td>
              <td>
                {job.title}
                {job.kind === "cifail" && <span class="tag">ci-fix</span>}
              </td>
              <td>
                <StatusBadge status={job.status} />
                {job.approvalBy !== undefined && <span class="muted"> · @{job.approvalBy}</span>}
              </td>
              <td class="muted">{job.branch ?? "—"}</td>
              <td>
                {job.prNumber !== undefined ? (
                  <a href={prUrl(repo, job.prNumber)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                    PR #{job.prNumber}
                  </a>
                ) : (
                  <span class="muted">—</span>
                )}
              </td>
              <td class="muted">{relativeAge(job.createdAt, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(jobs.length === 0 || visible.length === 0) && (
        <p class="muted">{jobs.length === 0 ? "No jobs yet. File an instruction above." : "No jobs match this filter."}</p>
      )}
    </>
  );
}

function App() {
  const [login, setLogin] = useState<string | undefined>();
  const [repo, setRepo] = useState<string>("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [stats, setStats] = useState<Stats | undefined>();
  const [commits, setCommits] = useState<GraphCommit[]>([]);
  const [who, setWho] = useState<string>("triage");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [steer, setSteer] = useState("");
  const [note, setNote] = useState("");
  const wsRef = useRef<WebSocket | undefined>(undefined);

  const loadState = async (): Promise<void> => {
    const [state, statistics, graph] = await Promise.all([
      api<{ jobs: Job[] }>("/api/state"),
      api<Stats>("/api/stats").catch(() => undefined),
      api<{ commits: GraphCommit[] }>("/api/gitgraph?branch=main").catch(() => ({ commits: [] })),
    ]);
    setJobs(state.jobs);
    setStats(statistics);
    setCommits(graph.commits);
  };
  const loadTranscript = async (target: string): Promise<void> => {
    const data = await api<{ messages: Msg[] }>(`/api/transcript?who=${encodeURIComponent(target)}`);
    setMsgs(data.messages);
  };
  useEffect(() => {
    void api<{ login: string; repo?: string }>("/api/me")
      .then((me) => { setLogin(me.login); if (me.repo) setRepo(me.repo); })
      .catch(() => setLogin(undefined));
  }, []);
  useEffect(() => {
    if (login === undefined) return;
    void loadState();
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    wsRef.current = ws;
    ws.onmessage = () => {
      void loadState();
      void loadTranscript(who);
    };
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login]);
  useEffect(() => {
    if (login !== undefined) void loadTranscript(who);
  }, [who, login]);

  const selected = useMemo(() => jobs.find((job) => job.delivery === who), [jobs, who]);
  const running = selected !== undefined && isActiveJob(selected.status);

  if (login === undefined) {
    return (
      <main class="signin">
        <h1>abc agent console</h1>
        <p class="muted">Collaborators only. Approvals happen on GitHub PRs, never here.</p>
        <a href="/auth/login"><button class="primary">Sign in with GitHub</button></a>
      </main>
    );
  }
  return (
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="dot" /> abc <span class="muted">console</span>
        </div>
        <nav>
          <a href="#overview">Statistics</a>
          <a href="#instruct">New instruction</a>
          <a href="#graph">Git graph</a>
          <a href="#jobs">Jobs</a>
          <a href="#transcript">Transcript</a>
        </nav>
        <div class="sidebar-foot">
          <div><strong>{login}</strong></div>
          <div><a href={`https://github.com/${repo}/issues`} target="_blank" rel="noreferrer">open issues</a></div>
          <div><a href={`https://github.com/${repo}/pulls`} target="_blank" rel="noreferrer">open PRs</a></div>
          <div><a href="/?demo=1">demo</a> · <a href="/auth/logout">log out</a></div>
        </div>
      </aside>
      <main class="content">
        <header class="top">
          <h1>abc agent console</h1>
          <span class="muted">{repo}</span>
        </header>

        <section id="overview">
          <h2>Statistics</h2>
          <Stats stats={stats} />
        </section>

        <section id="instruct">
          <h2>New instruction</h2>
          <p class="muted">One issue, one job. The agent works it in its own worktree; you approve the intent on the PR.</p>
          <input placeholder="Issue title" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
          <textarea rows={4} placeholder="What should the agent do?" value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} />
          <div class="row">
            <button
              class="primary"
              disabled={!title || !body}
              onClick={() =>
                void api<{ issueNumber: number }>("/api/instruct", {
                  method: "POST",
                  body: JSON.stringify({ title, body }),
                }).then((result) => {
                  setNote(`Created issue #${result.issueNumber} (one issue, one job).`);
                  setTitle(""); setBody(""); void loadState();
                }).catch((error: Error) => setNote(String(error)))
              }
            >
              File instruction
            </button>
            <span class="muted">{note}</span>
          </div>
        </section>

        <section id="graph">
          <h2>Git graph — main</h2>
          <GitGraph repo={repo} commits={commits} />
        </section>

        <section id="jobs">
          <h2>Jobs</h2>
          <JobsTable repo={repo} jobs={jobs} who={who} onSelect={setWho} />
        </section>

        {selected !== undefined && (
          <section id="steer">
            <h2>Steer / abort job #{selected.issueNumber}</h2>
            <div class="row">
              <input
                placeholder={running ? "Steering instruction (delivered to the running agent)" : "Follow-up instruction (opens a new job)"}
                value={steer}
                onInput={(e) => setSteer((e.target as HTMLInputElement).value)}
              />
              <button
                disabled={!steer}
                onClick={() =>
                  void api<{ mode: string }>("/api/steer", { method: "POST", body: JSON.stringify({ delivery: selected.delivery, text: steer }) })
                    .then((result) => { setSteer(""); setNote(result.mode === "steered" ? "Steer delivered to the running agent." : "Follow-up job submitted."); void loadState(); })
                    .catch((error: Error) => setNote(String(error)))
                }
              >
                {running ? "Steer" : "Follow up"}
              </button>
              <button
                class="danger"
                disabled={!running}
                onClick={() =>
                  void api("/api/abort", { method: "POST", body: JSON.stringify({ delivery: selected.delivery }) })
                    .then(() => setNote("Abort sent."))
                    .catch((error: Error) => setNote(String(error)))
                }
              >
                Abort
              </button>
              <button onClick={() => setWho("triage")}>Clear</button>
            </div>
          </section>
        )}

        <section id="transcript">
          <h2>Transcript {who === "triage" ? "(triage)" : selected ? `(#${selected.issueNumber} worker)` : ""}</h2>
          {msgs.map((msg, i) => (
            <div key={i} class={`msg ${msg.role}`}>
              <span class="muted">{msg.role}</span>
              <br />
              {msg.text}
            </div>
          ))}
          {msgs.length === 0 && <p class="muted">No transcript yet for this conversation.</p>}
        </section>
      </main>
    </div>
  );
}

render(<App />, document.getElementById("app") as HTMLElement);
