#!/usr/bin/env bash
# Push the current committed code (git HEAD) from this Mac to the Oracle server and restart the site.
# Usage:  bash deploy/server/deploy.sh <server-ip>
set -euo pipefail
IP="${1:?usage: deploy.sh <server-ip>}"
KEY="$HOME/.ssh/oracle_legion"
cd "$(dirname "$0")/../.."
git archive --format=tar HEAD | ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "ubuntu@$IP" \
  'sudo tar -x -C /opt/legion/app && sudo chown -R legion:legion /opt/legion/app && sudo systemctl restart legion && sleep 3 && systemctl is-active legion'
