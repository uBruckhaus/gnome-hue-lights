# Not paired. Discovery is the real, read-only mDNS browse; pairing is only ever started
# against the mock bridge's address, which answers "link button not pressed" twice.
cat >> "$EXT/extension.js" <<'JS'
import Shell from 'gi://Shell';
const _origEnable = HueLightsExtension.prototype.enable;
HueLightsExtension.prototype.enable = function () {
    _origEnable.call(this);
    if (globalThis._hlTestStarted)
        return;
    globalThis._hlTestStarted = true;
    const shot = (name, then) => {
        const file = Gio.File.new_for_path(`${GLib.getenv('HL_SHOT_DIR')}/${name}.png`);
        const stream = file.replace(null, false, 0, null);
        new Shell.Screenshot().screenshot(false, stream, (s, r) => {
            s.screenshot_finish(r); stream.close(null);
            console.log(`[Hue Lights] screenshot ${name} written`);
            then?.();
        });
    };
    const later = (ms, fn) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { fn(); return GLib.SOURCE_REMOVE; });
    later(9000, () => {
        Main.overview.hide();
        const ind = this._indicator;
        ind.menu.open(false);
        later(9000, () => shot('pairing', () => {
            console.log(`[Hue Lights] phase ${ind._stats.phase}, candidates ${(ind._stats.candidates || []).length}`);
            ind._panel._ipEntry.text = GLib.getenv('MOCK_IP');
            ind._panel._pairManual();                                      // the manual Pair button
            later(1500, () => shot('pairing-wait', () => {
                later(7000, () => shot('paired', () => console.log(`[Hue Lights] phase ${ind._stats.phase}, ${ind._stats.light_count} lights`)));
            }));
        }));
    });
};
JS
export HL_SHOT_DIR="${HL_SHOT_DIR:-$ROOT/dist/screenshots}"; mkdir -p "$HL_SHOT_DIR"
