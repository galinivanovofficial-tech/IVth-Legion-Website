#!/usr/bin/env bash
# One-time setup of a free Ubuntu 24.04 server (Google Cloud e2-micro or Oracle Always Free) for the IVth Legion site.
# Usage (as the default 'ubuntu' user):  bash setup-server.sh <public-hostname>
# Installs Node 24 + Caddy (automatic HTTPS), opens ports 80/443, and runs the app as a systemd service.
set -euo pipefail
HOST="${1:?usage: setup-server.sh <public-hostname>}"
APP=/opt/legion/app
DATA=/var/lib/legion

# Small VMs (e2-micro = 1 GB RAM): add 2 GB of swap so installs and the app never run out of memory
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

sudo apt-get update -y
sudo apt-get install -y git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

# Node.js 24 (NodeSource, arm64 + x64)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# Caddy (reverse proxy with automatic Let's Encrypt HTTPS)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo apt-get update -y && sudo apt-get install -y caddy

# Oracle's Ubuntu images only allow SSH in iptables: open HTTP/HTTPS and persist the rules
for p in 80 443; do
  sudo iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp -m state --state NEW --dport $p -j ACCEPT
done
sudo netfilter-persistent save

# App user, code and data directories
id legion >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir /opt/legion --shell /usr/sbin/nologin legion
sudo mkdir -p "$APP" "$DATA" && sudo chown -R legion:legion /opt/legion "$DATA"
[ -f /etc/legion.env ] || printf 'NODE_ENV=production\nPORT=3000\nDATA_DIR=%s\nBASE_URL=https://%s\n' "$DATA" "$HOST" | sudo tee /etc/legion.env >/dev/null
sudo chmod 600 /etc/legion.env

sudo tee /etc/systemd/system/legion.service >/dev/null <<UNIT
[Unit]
Description=IVth Legion website
After=network-online.target
Wants=network-online.target

[Service]
User=legion
WorkingDirectory=$APP
EnvironmentFile=/etc/legion.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$HOST {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
CADDY

sudo systemctl daemon-reload
sudo systemctl enable legion caddy
sudo systemctl restart caddy
echo "Server ready. Upload the app to $APP, then: sudo systemctl restart legion"
