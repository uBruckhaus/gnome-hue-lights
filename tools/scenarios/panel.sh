# Helpers of this test shell only: their path is inside the test's data folder.
helpers() { pgrep -fc "$EXT/scripts/hue-lights.py"; }
sleep 32
echo "--- commands the mock bridge got"
cat "$MOCK_LOG"
grep -q 'grouped_light .*"on": {"on": true}' "$MOCK_LOG" && echo "room switch: ok" || { echo "FAIL: room switch sent nothing"; FAILED=1; }
grep -q '"dimming": {"brightness": 60.0}' "$MOCK_LOG" && echo "room slider: ok" || { echo "FAIL: slider sent no 60 %"; FAILED=1; }
[ "$(grep -c '"on": {"on": false}' "$MOCK_LOG")" -ge 4 ] && echo "all off: ok" || { echo "FAIL: all off did not reach every room"; FAILED=1; }
echo "--- disable / enable (like locking and unlocking)"
gnome-extensions disable $UUID; sleep 1
if [ "$(helpers)" = 0 ]; then echo "helper stopped with the extension"; else echo "FAIL: helper still running after disable"; FAILED=1; fi
gnome-extensions enable $UUID; sleep 3
gnome-extensions info $UUID | grep State
[ "$(helpers)" = 1 ] && echo "one helper running" || { echo "FAIL: $(helpers) helpers running"; FAILED=1; }
