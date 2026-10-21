// GitHub App client: JWT auth, cached installation token, webhook signature
// verification, collaborator check, issue comments. Node built-ins only.
import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export interface GitHubAppConfig {
  appId: string;
  privateKeyPath: string;
  webhookSecret: string;
  repo: string; // owner/name
}

interface TokenCache { token: string; expiresAt: number }

export class GitHubApp {
  private readonly owner: string;
  private readonly name: string;
  private readonly pem: string;
  private installationId: number | undefined;
  private cached: TokenCache | undefined;

  constructor(private readonly config: GitHubAppConfig) {
    const [owner, name] = config.repo.split("/");
    if (!owner || !name) throw new Error(`REPO must be owner/name, got: ${config.repo}`);
    this.owner = owner;
    this.name = name;
    this.pem = readFileSync(config.privateKeyPath, "utf8");
  }

  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature?.startsWith("sha256=")) return false;
    const expected = "sha256=" + createHmac("sha256", this.config.webhookSecret).update(rawBody).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private jwt(): string {
    const b64 = (value: string): string => Buffer.from(value).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned =
      `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.` +
      b64(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.config.appId }));
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.pem, "base64url");
    return `${unsigned}.${signature}`;
  }

  private async api<T>(path: string, init: { method?: string; token: string; body?: unknown }): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${init.token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} -> ${response.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async installationToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - Date.now() > 5 * 60_000) return this.cached.token;
    const jwt = this.jwt();
    if (this.installationId === undefined) {
      const installation = await this.api<{ id: number }>(
        `/repos/${this.owner}/${this.name}/installation`,
        { token: jwt },
      );
      this.installationId = installation.id;
    }
    const created = await this.api<{ token: string; expires_at: string }>(
      `/app/installations/${this.installationId}/access_tokens`,
      { method: "POST", token: jwt },
    );
    this.cached = { token: created.token, expiresAt: Date.parse(created.expires_at) };
    return created.token;
  }

  async isCollaborator(login: string): Promise<boolean> {
    const token = await this.installationToken();
    const response = await fetch(
      `https://api.github.com/repos/${this.owner}/${this.name}/collaborators/${encodeURIComponent(login)}`,
      { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` } },
    );
    return response.status === 204;
  }

  async findCommentWithMarker(issueNumber: number, marker: string): Promise<boolean> {
    const token = await this.installationToken();
    const comments = await this.api<Array<{ body?: string }>>(
      `/repos/${this.owner}/${this.name}/issues/${issueNumber}/comments?per_page=100`,
      { token },
    );
    return comments.some((comment) => comment.body?.includes(marker));
  }

  async postComment(issueNumber: number, body: string): Promise<void> {
    const token = await this.installationToken();
    await this.api(`/repos/${this.owner}/${this.name}/issues/${issueNumber}/comments`, {
      method: "POST",
      token,
      body: { body },
    });
  }

  // Phase C: pull requests. The installation token is non-admin, so branch
  // protection (1 approval, CODEOWNERS) binds every merge attempted here.
  async createPull(title: string, head: string, base: string, body: string): Promise<{ number: number; html_url: string }> {
    const token = await this.installationToken();
    return this.api(`/repos/${this.owner}/${this.name}/pulls`, {
      method: "POST",
      token,
      body: { title, head, base, body },
    });
  }

  async findOpenPull(headBranch: string): Promise<number | undefined> {
    const token = await this.installationToken();
    const pulls = await this.api<Array<{ number: number }>>(
      `/repos/${this.owner}/${this.name}/pulls?state=open&head=${encodeURIComponent(`${this.owner}:${headBranch}`)}`,
      { token },
    );
    return pulls[0]?.number;
  }

  async listReviews(pullNumber: number): Promise<Array<{ login: string; state: string; association: string }>> {
    const token = await this.installationToken();
    const reviews = await this.api<Array<{ user?: { login?: string }; state?: string; author_association?: string }>>(
      `/repos/${this.owner}/${this.name}/pulls/${pullNumber}/reviews?per_page=100`,
      { token },
    );
    return reviews.map((review) => ({
      login: review.user?.login ?? "",
      state: review.state ?? "",
      association: review.author_association ?? "",
    }));
  }

  async createIssue(title: string, body: string): Promise<number> {
    const token = await this.installationToken();
    const issue = await this.api<{ number: number }>(`/repos/${this.owner}/${this.name}/issues`, {
      method: "POST",
      token,
      body: { title, body },
    });
    return issue.number;
  }

  async getPull(pullNumber: number): Promise<{ state: string; merged: boolean; mergeable: boolean | null }> {
    const token = await this.installationToken();
    const pull = await this.api<{ state?: string; merged_at?: string | null; mergeable?: boolean | null }>(
      `/repos/${this.owner}/${this.name}/pulls/${pullNumber}`,
      { token },
    );
    return { state: pull.state ?? "", merged: pull.merged_at != null, mergeable: pull.mergeable ?? null };
  }

  // Completed/failed workflow runs on main, newest first (post-merge gate).
  async listMainRuns(): Promise<Array<{ headSha: string; status: string; conclusion: string | null; url: string }>> {
    const token = await this.installationToken();
    const result = await this.api<{
      workflow_runs?: Array<{ head_sha: string; status: string; conclusion: string | null; html_url: string }>;
    }>(`/repos/${this.owner}/${this.name}/actions/runs?branch=main&per_page=10`, { token });
    return (result.workflow_runs ?? []).map((run) => ({
      headSha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
    }));
  }

  // Recent commits on a branch, newest first, with parent SHAs so the console
  // can render a commit graph without shelling out to git (SPEC Phase A).
  async listCommits(branch: string, perPage = 30): Promise<Array<{ sha: string; shortSha: string; message: string; author: string; date: string; parents: string[] }>> {
    const token = await this.installationToken();
    const commits = await this.api<Array<{ sha: string; commit: { message: string; author?: { name?: string; date?: string } }; author?: { login?: string }; parents?: Array<{ sha: string }> }>>(
      `/repos/${this.owner}/${this.name}/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}`,
      { token },
    );
    return commits.map((commit) => ({
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 7),
      message: (commit.commit.message ?? "").split("\n")[0] ?? "",
      author: commit.author?.login ?? commit.commit.author?.name ?? "unknown",
      date: commit.commit.author?.date ?? "",
      parents: (commit.parents ?? []).map((parent) => parent.sha),
    }));
  }

  async mergePull(pullNumber: number): Promise<void> {
    const token = await this.installationToken();
    await this.api(`/repos/${this.owner}/${this.name}/pulls/${pullNumber}/merge`, {
      method: "PUT",
      token,
      body: { merge_method: "squash" },
    });
  }
}
