sleep 30
echo "--- commands the mock bridge got"
cat "$MOCK_LOG"
grep -q 'POST /api .*gnome_hue_lights#' "$MOCK_LOG" && echo "pair request: ok" || { echo "FAIL: no pair request"; FAILED=1; }
CFG=$XDG_CONFIG_HOME/hue-lights/config.json
if [ -f "$CFG" ] && [ "$(stat -c %a "$CFG")" = 600 ] && [ "$(stat -c %a "$(dirname "$CFG")")" = 700 ]; then
    echo "config written privately: ok"
else
    echo "FAIL: config missing or not private"; FAILED=1
fi
