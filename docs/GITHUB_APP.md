# GitHub App setup — Phase B

Create this manually in GitHub; it cannot be created with the repository token.
Target installation: **only `vernanng/abc`**.

## 1. Create the app

Open: GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.

- **Name:** `vernanng-abc-agent` (change only if GitHub says it is taken)
- **Homepage URL:** `https://github.com/vernanng/abc`
- **Webhook active:** unchecked for now; the Mac proof has no public webhook URL yet
- **Webhook URL:** `https://example.com/webhook` as a temporary placeholder
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
4. Move it outside the repo, for example `~/.config/abc/github-app.pem`, then run `chmod 600 ~/.config/abc/github-app.pem`.
5. In local `.env`, set:
   - `GITHUB_APP_ID=<numeric App ID from GitHub>`
   - `GITHUB_PRIVATE_KEY_PATH=/Users/vernantjoa/.config/abc/github-app.pem`
   - keep the generated `WEBHOOK_SECRET` unchanged.

Never commit `.env` or the `.pem` file; both are ignored by git.

## 5. Later, before live webhooks

The App webhook stays inactive until the harness has a reachable HTTPS endpoint
(Mac proof via a tunnel, VPS later). Then set the real `/webhook` URL, paste the
same secret if GitHub asks again, and activate webhooks.
