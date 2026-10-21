#!/usr/bin/env bash
# CD deploy step: runs on the VPS as the harness user (via scripts/abc-deploy)
# after the CI-passed commit is checked out. The running service is only
# restarted after a fully successful build, so a bad merge never takes the
# bot down; a restart mid-job is safe - jobs resume from the journal.
set -euo pipefail
cd /home/harness/abc
npm ci --no-audit --no-fund
npm run build
npm run console:build
sudo -n /usr/bin/systemctl restart abc-harness
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8971/health >/dev/null; then
    echo "deployed $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 1
done
echo "deploy: service did not become healthy" >&2
exit 1
