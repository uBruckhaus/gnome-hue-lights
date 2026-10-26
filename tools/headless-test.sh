#!/bin/bash
# Runs the extension in a throwaway headless GNOME Shell with its own D-Bus, dconf, data
# and config folders and prints the extension's log. The bridge is tools/mock-bridge.py on
# this PC's LAN address (the helper only accepts private, non-loopback addresses) and a
# high port: no test ever talks to a real Hue bridge or switches a real light.
# Usage: [MONITOR=WxH] tools/headless-test.sh [scenario]   (scenarios in tools/scenarios/)
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=hue-lights@ubruckhaus.github.io
if [ -z "${HL_INNER:-}" ]; then
    # The private bus (and the dconf service it starts) must see the temporary folders.
    T=$(mktemp -d)
    mkdir -p "$T/config" "$T/data" "$T/cache" "$T/state"
    export HL_INNER=1 T XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_CACHE_HOME=$T/cache XDG_STATE_HOME=$T/state
    dbus-run-session -- "$0" "$@" 2> >(grep -v -e dbus-daemon -e fusermount >&2)
    status=$?
    rm -rf "$T"
    exit $status
fi
EXT=$XDG_DATA_HOME/gnome-shell/extensions/$UUID
"$ROOT/tools/build.sh" >/dev/null && mkdir -p "$EXT" && unzip -q "$ROOT/dist/$UUID.shell-extension.zip" -d "$EXT" \
    || { echo "build failed" >&2; exit 1; }
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['$UUID']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version "$(gnome-shell --version | awk '{print $3}')"
[ "$(gsettings get org.gnome.shell enabled-extensions)" = "['$UUID']" ] || { echo "isolated dconf not working" >&2; exit 1; }

# The mock bridge: a certificate whose CN is the made-up bridge id, a free port.
MOCK_IP=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1)
[ -n "$MOCK_IP" ] || { echo "no LAN address for the mock bridge" >&2; exit 1; }
MOCK_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("", 0)); print(s.getsockname()[1])')
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=C42996FFFEC9B46D \
    -keyout "$T/mock-key.pem" -out "$T/mock-cert.pem" 2>/dev/null
MOCK_FP=$(openssl x509 -in "$T/mock-cert.pem" -outform der | sha256sum | cut -d' ' -f1)
MOCK_LOG=$T/mock-commands.log
: > "$MOCK_LOG"
python3 -I "$ROOT/tools/mock-bridge.py" --ip "$MOCK_IP" --port "$MOCK_PORT" \
    --cert "$T/mock-cert.pem" --key "$T/mock-key.pem" --log "$MOCK_LOG" &
MOCK_PID=$!
export HUE_LIGHTS_BRIDGE_PORT=$MOCK_PORT MOCK_IP
# Writes the helper's config as if paired with the mock bridge.
pair_with_mock() {
    mkdir -p -m 700 "$XDG_CONFIG_HOME/hue-lights"
    printf '{"ip":"%s","bridge_id":"C42996FFFEC9B46D","fingerprint":"%s","app_key":"mock-app-key-1234567890","name":"Mock Hue Bridge","model":"BSB002"}' \
        "$MOCK_IP" "$MOCK_FP" > "$XDG_CONFIG_HOME/hue-lights/config.json"
    chmod 600 "$XDG_CONFIG_HOME/hue-lights/config.json"
}

SCENARIO=${1:-panel}
FAILED=0
[ -f "$ROOT/tools/scenarios/$SCENARIO.pre.sh" ] && . "$ROOT/tools/scenarios/$SCENARIO.pre.sh"

gnome-shell --headless --wayland --no-x11 --virtual-monitor ${MONITOR:-1920x1080} \
    --wayland-display hl-test >"$T/shell.log" 2>&1 &
SHELL_PID=$!
# The test shell and the mock go even when a scenario fails part-way.
trap 'kill $SHELL_PID $MOCK_PID 2>/dev/null' EXIT
sleep 8
export WAYLAND_DISPLAY=hl-test
# No X fallback: an app that loses the test shell must not open in the real session.
unset DISPLAY
. "$ROOT/tools/scenarios/$SCENARIO.sh"
kill $SHELL_PID 2>/dev/null; sleep 1
[ -n "${KEEP_LOG:-}" ] && cp "$T/shell.log" "$KEEP_LOG"
grep -v -e Gtk-WARNING -e "^$" "$T/shell.log" | grep -i -e "hue lights\|hue-lights\|js\|error\|exception" | head -${LINES_MAX:-80}
# GNOME Shell's own shutdown fails to remove its crash guard file; that one is not ours.
grep -A1 -e "JS ERROR" -e "St-CRITICAL" "$T/shell.log" | grep -v -e "gnome-shell-disable-extensions" -e "extensionSystem.js" -e "^--$" \
    | grep -q . && { echo "FAIL: errors in the shell log"; FAILED=1; }
exit $FAILED
