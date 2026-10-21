import { Fragment, h, render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

interface Job {
  delivery: string;
  kind: string;
  issueNumber: number;
  title: string;
  status: string;
  prNumber?: number;
  approvalBy?: string;
}
interface Msg { role: string; text: string }

interface Stats {
  total: number;
  byStatus: Record<string, number>;
  byKind: Record<string, number>;
  withPr: number;
  approved: number;
  merged: number;
  failed: number;
  running: number;
  approvalRate: number;
  spendUsd: number;
}
interface CommitNode { sha: string; subject: string; refs: string[]; lane: number }
interface BranchLine { name: string; lane: number; agent: boolean }
interface GraphJob { delivery: string; issueNumber: number; branch?: string; prNumber?: number; jobStatus?: string }
interface Graph { branches: BranchLine[]; commits: CommitNode[]; lanes: number; jobs: GraphJob[] }

const LANE_COLORS = ["#58a6ff", "#3fb950", "#d29922", "#a371f7", "#f778ba", "#8b949e"];

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json() as Promise<T>;
};

const money = (usd: number): string => `$${usd.toFixed(4)}`;
const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;

function StatsPanel({ stats }: { stats: Stats | undefined }) {
  if (stats === undefined) return <p class="muted">Loading statistics…</p>;
  return (
    <div class="stats">
      <div class="stat"><span class="stat-num">{stats.total}</span><span class="muted">jobs</span></div>
      <div class="stat"><span class="stat-num">{stats.running}</span><span class="muted">running</span></div>
      <div class="stat"><span class="stat-num">{stats.merged}</span><span class="muted">merged</span></div>
      <div class="stat"><span class="stat-num">{stats.failed}</span><span class="muted">failed/parked</span></div>
      <div class="stat"><span class="stat-num">{stats.withPr}</span><span class="muted">PRs opened</span></div>
      <div class="stat"><span class="stat-num">{pct(stats.approvalRate)}</span><span class="muted">approved</span></div>
      <div class="stat"><span class="stat-num">{money(stats.spendUsd)}</span><span class="muted">spend</span></div>
      <div class="statusbar">
        {Object.entries(stats.byStatus).sort((a, b) => b[1] - a[1]).map(([status, count]) => (
          <span key={status} class={`pill st-${status.replace(/[^a-z0-9]/gi, "-")}`}>{status} {count}</span>
        ))}
      </div>
    </div>
  );
}

function GitGraph({ graph }: { graph: Graph | undefined }) {
  if (graph === undefined) return <p class="muted">Loading git graph…</p>;
  if (graph.commits.length === 0) return <p class="muted">No commits yet.</p>;
  return (
    <div class="graph">
      <div class="graph-legend muted">
        {graph.branches.map((branch) => (
          <span key={branch.name} class="legend-item">
            <span class="dot" style={{ background: LANE_COLORS[branch.lane % LANE_COLORS.length] }} />
            {branch.name}{branch.agent ? " (agent)" : ""}
          </span>
        ))}
      </div>
      <ul class="commits">
        {graph.commits.map((commit) => (
          <li key={commit.sha} class="commit">
            <span
              class="node"
              style={{
                background: LANE_COLORS[commit.lane % LANE_COLORS.length],
                marginLeft: `${commit.lane * 16}px`,
              }}
            />
            <code class="sha">{commit.sha.slice(0, 7)}</code>
            <span class="subject">{commit.subject}</span>
            {commit.refs.map((ref) => (
              <span key={ref} class={`ref ${/agent\//.test(ref) ? "ref-agent" : ""}`}>{ref}</span>
            ))}
          </li>
        ))}
      </ul>
      {graph.jobs.length > 0 && (
        <p class="muted">
          {graph.jobs.map((job) => (
            <span key={job.delivery} class="jobref">
              #{job.issueNumber} {job.branch ?? job.delivery}
              {job.prNumber !== undefined ? ` → PR #${job.prNumber}` : ""} ({job.jobStatus ?? "?"}){"  "}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function App() {
  const [login, setLogin] = useState<string | undefined>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [who, setWho] = useState<string>("triage");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [steer, setSteer] = useState("");
  const [note, setNote] = useState("");
  const [view, setView] = useState<"conversation" | "insights">("conversation");
  const [stats, setStats] = useState<Stats | undefined>(undefined);
  const [graph, setGraph] = useState<Graph | undefined>(undefined);
  const wsRef = useRef<WebSocket | undefined>(undefined);

  const loadState = async (): Promise<void> => {
    const state = await api<{ jobs: Job[] }>("/api/state");
    setJobs(state.jobs);
  };
  const loadTranscript = async (target: string): Promise<void> => {
    const data = await api<{ messages: Msg[] }>(`/api/transcript?who=${encodeURIComponent(target)}`);
    setMsgs(data.messages);
  };
  const loadInsights = async (): Promise<void> => {
    const [s, g] = await Promise.all([
      api<Stats>("/api/stats"),
      api<Graph>("/api/graph"),
    ]);
    setStats(s);
    setGraph(g);
  };
  useEffect(() => {
    void api<{ login: string }>("/api/me")
      .then((me) => setLogin(me.login))
      .catch(() => setLogin(undefined));
  }, []);
  useEffect(() => {
    if (login === undefined) return;
    void loadState();
    void loadInsights();
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    wsRef.current = ws;
    ws.onmessage = () => {
      void loadState();
      void loadTranscript(who);
      void loadInsights();
    };
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login]);
  useEffect(() => {
    if (login !== undefined) void loadTranscript(who);
  }, [who, login]);

  if (login === undefined) {
    return (
      <main>
        <h1>abc agent console</h1>
        <p class="muted">Collaborators only. Approvals happen on GitHub PRs, never here.</p>
        <a href="/auth/login"><button>Sign in with GitHub</button></a>
      </main>
    );
  }
  const selected = jobs.find((job) => job.delivery === who);
  const steerable = selected !== undefined && selected.status === "working";
  return (
    <main>
      <h1>abc agent console</h1>
      <p class="muted">
        Signed in as <strong>{login}</strong> · <a href="/auth/logout">log out</a> ·{" "}
        <a href="/?demo=1">simulation demo</a>
      </p>
      <nav class="tabs">
        <button class={view === "conversation" ? "active" : ""} onClick={() => setView("conversation")}>Conversation</button>
        <button class={view === "insights" ? "active" : ""} onClick={() => { setView("insights"); void loadInsights(); }}>Statistics &amp; git graph</button>
      </nav>
      {view === "insights" && (
        <>
          <h2>Statistics</h2>
          <StatsPanel stats={stats} />
          <h2>Git graph</h2>
          <GitGraph graph={graph} />
        </>
      )}
      {view === "conversation" && (
        <>
          <h2>New instruction</h2>
          <input placeholder="Issue title" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
          <textarea rows={4} placeholder="What should the agent do?" value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} />
          <div class="row">
            <button
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
          <h2>Jobs</h2>
          <div
            class={`job ${who === "triage" ? "sel" : ""}`}
            onClick={() => setWho("triage")}
          >
            triage conversation <span class="muted">(Phase B root)</span>
          </div>
          {jobs.map((job) => (
            <div key={job.delivery} class={`job ${who === job.delivery ? "sel" : ""}`} onClick={() => setWho(job.delivery)}>
              #{job.issueNumber} {job.title} — <strong>{job.status}</strong>
              {job.prNumber !== undefined && (
                <span>
                  {" "}· <a href={`https://github.com/vernanng/abc/pull/${job.prNumber}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>PR #{job.prNumber}</a>
                </span>
              )}
              {job.approvalBy !== undefined && <span class="muted"> · approved by {job.approvalBy}</span>}
            </div>
          ))}
          {selected !== undefined && (
            <>
              <h2>Steer / abort job #{selected.issueNumber}</h2>
              <p class="muted">
                {steerable
                  ? "Job is running — steering lands after the current tool round."
                  : "Job is not running; a steer files a follow-up instruction."}
              </p>
              <div class="row">
                <input placeholder="Steering instruction" value={steer} onInput={(e) => setSteer((e.target as HTMLInputElement).value)} />
                <button
                  onClick={() =>
                    void api("/api/steer", { method: "POST", body: JSON.stringify({ delivery: selected.delivery, text: steer }) })
                      .then(() => { setSteer(""); setNote("Steer submitted."); })
                      .catch((error: Error) => setNote(String(error)))
                  }
                >
                  Steer
                </button>
                <button
                  onClick={() =>
                    void api("/api/abort", { method: "POST", body: JSON.stringify({ delivery: selected.delivery }) })
                      .then(() => setNote("Abort sent."))
                      .catch((error: Error) => setNote(String(error)))
                  }
                >
                  Abort
                </button>
              </div>
            </>
          )}
          <h2>Transcript {who === "triage" ? "(triage)" : selected ? `(#${selected.issueNumber} worker)` : ""}</h2>
          {msgs.map((msg, i) => (
            <div key={i} class={`msg ${msg.role}`}>
              <span class="muted">{msg.role}</span>
              <br />
              {msg.text}
            </div>
          ))}
          {msgs.length === 0 && <p class="muted">No transcript yet for this conversation.</p>}
        </>
      )}
    </main>
  );
}

render(<App />, document.getElementById("app") as HTMLElement);
