#!/usr/bin/env bash
# Installs the Dhvani laptop service for the current user (no sudo):
#   ~/.local/bin/dhvani, a systemd user service, and an app-menu entry for the panel.
set -euo pipefail
cd "$(dirname "$0")/laptop"

command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }
command -v pw-cat >/dev/null || { echo "pw-cat (PipeWire) is required" >&2; exit 1; }

bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null
bun test
bun build src/main.ts --compile --outfile dist/dhvani >/dev/null

BIN="$HOME/.local/bin"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$BIN" "$UNIT_DIR" "$APPS"

# Replace the binary atomically so a running service is not corrupted mid-write.
install -m 0755 dist/dhvani "$BIN/dhvani.new"
mv -f "$BIN/dhvani.new" "$BIN/dhvani"

cat > "$UNIT_DIR/dhvani.service" <<UNIT
[Unit]
Description=Dhvani - play phone audio on this laptop
After=pipewire.service pipewire-pulse.service
Wants=pipewire.service

[Service]
ExecStart=$BIN/dhvani
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes

[Install]
WantedBy=default.target
UNIT

cat > "$APPS/dhvani.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Dhvani
Comment=Play your phone's audio on this laptop
Exec=xdg-open http://127.0.0.1:47801
Icon=audio-headphones
Categories=AudioVideo;Audio;
DESK

systemctl --user daemon-reload
systemctl --user enable dhvani.service >/dev/null 2>&1
systemctl --user restart dhvani.service
sleep 1
if systemctl --user is-active --quiet dhvani.service; then
  echo "Dhvani is running. Panel: http://127.0.0.1:47801"
  cfg="${XDG_CONFIG_HOME:-$HOME/.config}/dhvani/config.json"
  echo "Pairing code: $(sed -n 's/.*"code": *"\([0-9]*\)".*/\1/p' "$cfg" 2>/dev/null | head -1)"
else
  echo "Dhvani failed to start:" >&2
  journalctl --user -u dhvani.service -n 20 --no-pager -o cat >&2
  exit 1
fi
