# GitHub App setup — Phase B

Create this manually in GitHub; it cannot be created with the repository token.
Target installation: **only `vernanng/abc`**.

**Status: done and live.** App `vernanng-abc-agent` is installed on `vernanng/abc` only; the webhook is active and points at the VPS (see §5 for current values). This doc is kept as the setup record / rebuild runbook.

## 1. Create the app

Open: GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.

- **Name:** `vernanng-abc-agent` (change only if GitHub says it is taken)
- **Homepage URL:** `https://github.com/vernanng/abc`
- **Webhook active:** checked (live)
- **Webhook URL:** `https://piagentdev.tail2a29a7.ts.net/webhook` (Tailscale Funnel on the VPS)
- **Webhook secret:** copy `WEBHOOK_SECRET` from the local `.env` file. Do not commit or paste it elsewhere.

## 2. Repository permissions

| Permission | Access | Why |
|---|---:|---|
| Metadata | Read-only | Mandatory for every GitHub App |
| Contents | Read & write | Draft branches, commits, squash merge |
| Issues | Read & write | Read instructions and post agent comments |
| Pull requests | Read & write | Open PRs, comment, merge after approval |
| Checks | Read-only | Observe PR/main check results |
| Actions | Read-only | Observe workflow failures |
| Workflows | Read & write | Required by GitHub before an app token may add/update workflow files |

No organization or account permissions.

## 3. Subscribe to events

- Issues
- Issue comment
- Pull request
- Pull request review
- Pull request review comment
- Check run
- Workflow run

`Pull request review` is required so the harness can observe the human intent approval.

## 4. Install and generate credentials

1. Set **Where can this GitHub App be installed?** to **Only on this account**.
2. Create the app, then install it on **only `vernanng/abc`**.
3. Generate a private key and download the `.pem` file.
4. Move it outside the repo and `chmod 600` it. On the VPS (live): `/home/harness/.config/abc/github-app.pem`, owned by `harness`. A copy remains on the Mac at `/Users/vernantjoa/.config/abc/github-app.pem` for local runs.
5. In `.env`, set:
   - `GITHUB_APP_ID=<numeric App ID from GitHub>`
   - `GITHUB_PRIVATE_KEY_PATH=<absolute path to the .pem on that host>`
   - keep the generated `WEBHOOK_SECRET` unchanged.

Never commit `.env` or the `.pem` file; both are ignored by git.

## 5. Live endpoints (2026-10-22)

- **GitHub App webhook:** `https://piagentdev.tail2a29a7.ts.net/webhook`, active. To re-point it (host move), PATCH the App's hook config with an App JWT, then verify a genuine delivery is triaged (unsigned POSTs must return 401).
- **OAuth App** (separate from the GitHub App; console login): Homepage URL `https://piagentdev.tail2a29a7.ts.net`, Authorization callback URL `https://piagentdev.tail2a29a7.ts.net/auth/callback`. Its client ID/secret live in `.env` as `GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET`.
- Cutover lesson: on a fresh Tailscale node, restart `tailscaled` after `tailscale funnel --bg 8971`, or the public DNS record never publishes — GitHub then reports 502 "failed to connect to host" while tailnet-local checks misleadingly pass.
