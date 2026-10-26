# Paired with the mock bridge. Test-only patch of the copied extension: screenshots of the
# bar and the panel, a room expanded, then the controls used the way a click would.
pair_with_mock
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
    const card = name => [...this._indicator._panel._cards.values()].find(c => c._room.name === name);
    later(9000, () => {
        Main.overview.hide();
        later(4000, () => {
            const ind = this._indicator;
            console.log(`[Hue Lights] phase ${ind._stats.phase}, ${ind._stats.on_count} of ${ind._stats.light_count} on, rooms ${(ind._stats.rooms || []).map(r => r.name).join('/')}`);
            shot('bar-on', () => {
                ind.menu.open(false);
                later(2500, () => shot('panel', () => {
                    ind._panel.toggleExpanded(card('Living room')._room);
                    ind._panel.toggleExpanded(card('Bedroom')._room);
                    ind._panel.toggleExpanded(card('Other lights')._room);
                    later(500, () => {
                        const sc = card("Living room")._scenes.get_first_child();
                        console.log(`[Hue Lights] scenes visible ${sc.visible} mapped ${sc.mapped} size ${sc.width}x${sc.height} children ${sc.get_n_children()} first ${sc.get_first_child()?.width}x${sc.get_first_child()?.height} label ${sc.get_first_child()?.label}`);
                    });
                    later(1500, () => shot('panel-expanded', () => {
                        card('Kitchen')._switch.actor.emit('clicked', 1);          // kitchen on
                        card('Bedroom')._bri.slider.value = 0.6;                     // bedroom 60 %
                        const plug = [...card('Other lights')._lightRows.values()][0];
                        console.log(`[Hue Lights] plug row slider visible ${plug._bri.slider.visible}`);
                        later(3500, () => shot('panel-after-controls', () => {
                            ind.menu.close(false);
                            ind._allOff();                                           // what the right click does
                            later(3000, () => shot('bar-off', () => {
                                console.log(`[Hue Lights] after all off: ${ind._stats.on_count} on`);
                            }));
                        }));
                    }));
                }));
            });
        });
    });
};
JS
export HL_SHOT_DIR="${HL_SHOT_DIR:-$ROOT/dist/screenshots}"; mkdir -p "$HL_SHOT_DIR"
