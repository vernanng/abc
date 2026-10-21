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

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json() as Promise<T>;
};

function App() {
  const [login, setLogin] = useState<string | undefined>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [who, setWho] = useState<string>("triage");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [steer, setSteer] = useState("");
  const [note, setNote] = useState("");
  const wsRef = useRef<WebSocket | undefined>(undefined);

  const loadState = async (): Promise<void> => {
    const state = await api<{ jobs: Job[] }>("/api/state");
    setJobs(state.jobs);
  };
  const loadTranscript = async (target: string): Promise<void> => {
    const data = await api<{ messages: Msg[] }>(`/api/transcript?who=${encodeURIComponent(target)}`);
    setMsgs(data.messages);
  };
  useEffect(() => {
    void api<{ login: string }>("/api/me")
      .then((me) => setLogin(me.login))
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
  return (
    <main>
      <h1>abc agent console</h1>
      <p class="muted">
        Signed in as <strong>{login}</strong> · <a href="/auth/logout">log out</a> ·{" "}
        <a href="/?demo=1">simulation demo</a>
      </p>
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
    </main>
  );
}

render(<App />, document.getElementById("app") as HTMLElement);
