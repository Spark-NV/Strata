#!/bin/sh
# Installs the root step that frees and compacts RAM before Strata starts. Run once: sudo sh install.sh
# Undo: sudo rm /usr/local/sbin/strata-compact-memory.sh /etc/systemd/system/strata-compact-memory.service \
#        /etc/polkit-1/rules.d/50-strata-compact-memory.rules && sudo systemctl daemon-reload
# and remove the ExecStartPre line from ~/.config/systemd/user/qwen-orca-iq4xs.service.
set -e
cd "$(dirname "$0")"
install -o root -g root -m 0755 strata-compact-memory.sh /usr/local/sbin/strata-compact-memory.sh
install -o root -g root -m 0644 strata-compact-memory.service /etc/systemd/system/strata-compact-memory.service
install -o root -g root -m 0644 50-strata-compact-memory.rules /etc/polkit-1/rules.d/50-strata-compact-memory.rules
systemctl daemon-reload
echo "installed"
