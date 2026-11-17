#!/usr/bin/env bash
# Removes the Dhvani service, binary and menu entry. Keeps ~/.config/dhvani (your pairing code).
set -euo pipefail
systemctl --user disable --now dhvani.service 2>/dev/null || true
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/dhvani.service" \
      "$HOME/.local/bin/dhvani" \
      "${XDG_DATA_HOME:-$HOME/.local/share}/applications/dhvani.desktop"
systemctl --user daemon-reload
echo "Dhvani removed."
