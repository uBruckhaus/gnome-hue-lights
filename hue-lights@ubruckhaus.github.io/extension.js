// Hue Lights for GNOME: Philips Hue rooms, zones, lights and scenes from the top bar.
// Lit bulb in green while any light is on, dim bulb when all are off or no bridge is
// paired. Left click opens the panel; right click switches every light off.
//
// All bridge traffic goes through scripts/hue-lights.py, which gets JSON commands on
// stdin and streams JSON snapshots on stdout (every 2 s while the panel is open, every
// 20 s while it is closed). It talks only to the bridge on the LAN, over pinned HTTPS.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const RESTART_DELAY = 5;          // seconds before a helper that exited starts again
const SEND_EVERY = 150;           // ms between brightness commands while a slider is dragged
const SCENE_LIMIT = 6;            // scenes shown before "+N more"
const SCENE_ROW_WIDTH = 390;      // a card's inner width before it has been laid out
const LIT = '#33d17a';            // the bar bulb while any light is on (GNOME green)
const WARM = '#ffd27a';           // a light's colour when the bridge gives none
const DIM = 150;                  // opacity of secondary text

const HEX_RE = /^#[0-9a-f]{6}$/i;

// Colours come from the bridge: only "#rrggbb" ever reaches a style string.
function safeColor(color, fallback = WARM) {
    return HEX_RE.test(String(color ?? '')) ? color : fallback;
}

function rgb(color) {
    const c = safeColor(color);
    return [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
}

function rgba(color, alpha) {
    const [r, g, b] = rgb(color);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Dark or light glyph on top of a light colour, whichever reads better.
function onTint(color) {
    const [r, g, b] = rgb(color);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#1a1a1a' : '#ffffff';
}

function plural(n, one, many) {
    return n === 1 ? one : many.replace('{0}', n);
}

function roomKey(room) {
    return room.id || room.kind;
}

// Room type (Hue archetype) to an icon. Many rooms keep the Hue app's default
// archetype, so the name wins when it is telling.
const ROOM_ICONS = [
    [/schlaf|bed|kinder|gäste|guest|nursery/, 'weather-clear-night-symbolic'],
    [/küche|kueche|kitchen|ess|dining/, 'emoji-food-symbolic'],
    [/bad|bath|wc|toilet|dusche|shower/, 'weather-showers-symbolic'],
    [/büro|buero|office|arbeit|studio/, 'computer-symbolic'],
    [/flur|diele|treppe|hall|stair|eingang/, 'go-home-symbolic'],
    [/garage|carport/, 'emoji-travel-symbolic'],
    [/garten|terrasse|balkon|garden|terrace|balcony|patio|außen|outdoor/, 'emoji-nature-symbolic'],
    [/wohn|living|lounge|tv/, 'tv-symbolic'],
];
const ARCHETYPE_ICONS = {
    living_room: 'tv-symbolic', lounge: 'tv-symbolic', tv: 'tv-symbolic',
    kitchen: 'emoji-food-symbolic', dining: 'emoji-food-symbolic',
    bedroom: 'weather-clear-night-symbolic', kids_bedroom: 'weather-clear-night-symbolic',
    guest_room: 'weather-clear-night-symbolic', nursery: 'weather-clear-night-symbolic',
    bathroom: 'weather-showers-symbolic', toilet: 'weather-showers-symbolic',
    office: 'computer-symbolic', computer: 'computer-symbolic', studio: 'computer-symbolic',
    hallway: 'go-home-symbolic', staircase: 'go-home-symbolic', top_floor: 'go-home-symbolic',
    upstairs: 'go-home-symbolic', downstairs: 'go-home-symbolic',
    garage: 'emoji-travel-symbolic', carport: 'emoji-travel-symbolic', driveway: 'emoji-travel-symbolic',
    garden: 'emoji-nature-symbolic', terrace: 'emoji-nature-symbolic', balcony: 'emoji-nature-symbolic',
    porch: 'emoji-nature-symbolic', barbecue: 'emoji-nature-symbolic', pool: 'emoji-nature-symbolic',
    front_door: 'emoji-nature-symbolic',
};

function roomIcon(room) {
    if (room.kind === 'zone')
        return 'view-grid-symbolic';
    if (room.kind === 'other')
        return null;   // the extension's own bulb
    const name = String(room.name || '').toLowerCase();
    for (const [pattern, icon] of ROOM_ICONS) {
        if (pattern.test(name))
            return icon;
    }
    return ARCHETYPE_ICONS[room.archetype] ?? 'user-home-symbolic';
}

function roomStatus(room) {
    const parts = [];
    const total = room.lights.length;
    if (room.kind === 'zone')
        parts.push('Zone');
    parts.push(room.on ? `${room.on_count} of ${total} on` : plural(total, 'Off · 1 light', 'Off · {0} lights'));
    const unreachable = room.lights.filter(light => light.reachable === false).length;
    if (unreachable)
        parts.push(`${unreachable} unreachable`);
    return parts.join(' · ');
}

// ---------------------------------------------------------------------------------- helper

class Helper {
    constructor(script, onSnapshot, onStart) {
        this._script = script;
        this._onSnapshot = onSnapshot;
        this._onStart = onStart;
        this._stopped = false;
        this._queue = [];
        this._writing = false;
    }

    start() {
        this._cancellable = new Gio.Cancellable();
        const python = GLib.find_program_in_path('python3');
        try {
            if (!python)
                throw new Error('python3 not found');
            this._proc = Gio.Subprocess.new([python, '-I', this._script],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.error(`[Hue Lights] helper did not start: ${e.message}`);
            this._restartLater();
            return;
        }
        this._stdin = this._proc.get_stdin_pipe();
        this._queue = [];
        this._writing = false;
        const stream = new Gio.DataInputStream({base_stream: this._proc.get_stdout_pipe(), close_base_stream: true});
        this._readLine(stream, this._cancellable);
        const proc = this._proc;
        proc.wait_async(this._cancellable, (p, result) => {
            try {
                p.wait_finish(result);
            } catch {
                return;     // cancelled: stop() was called
            }
            if (this._proc === proc) {
                this._proc = null;
                this._stdin = null;
            }
            this._restartLater();
        });
        this._onStart?.();
    }

    _readLine(stream, cancellable) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (s, result) => {
            let line;
            try {
                [line] = s.read_line_finish_utf8(result);
            } catch {
                return;     // cancelled or the pipe closed
            }
            if (line === null)
                return;
            try {
                const data = JSON.parse(line);
                if (data && typeof data === 'object')
                    this._onSnapshot(data);
            } catch {
                // a partial line while the helper exits
            }
            this._readLine(s, cancellable);
        });
    }

    // One JSON command per line; writes are queued so only one is outstanding at a time.
    send(command) {
        if (!this._stdin)
            return;
        this._queue.push(new GLib.Bytes(new TextEncoder().encode(`${JSON.stringify(command)}\n`)));
        this._flush();
    }

    _flush() {
        if (this._writing || !this._stdin || !this._queue.length)
            return;
        this._writing = true;
        const stdin = this._stdin;
        stdin.write_bytes_async(this._queue[0], GLib.PRIORITY_DEFAULT, this._cancellable, (s, result) => {
            this._writing = false;
            let written = 0;
            try {
                written = s.write_bytes_finish(result);
            } catch {
                this._queue = [];   // the helper is gone; it restarts with a fresh queue
                return;
            }
            const head = this._queue[0];
            if (head && written < head.get_size())
                this._queue[0] = head.slice(written, head.get_size());
            else
                this._queue.shift();
            if (this._stdin === stdin)
                this._flush();
        });
    }

    _restartLater() {
        if (this._stopped || this._restartId)
            return;
        this._restartId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RESTART_DELAY, () => {
            this._restartId = 0;
            if (!this._stopped)
                this.start();
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        this._stopped = true;
        if (this._restartId)
            GLib.source_remove(this._restartId);
        this._restartId = 0;
        this._cancellable?.cancel();
        this._proc?.force_exit();
        this._proc = null;
        this._stdin = null;
        this._queue = [];
    }
}

// ---------------------------------------------------------------------------------- widgets

function label(text = '', styleClass = '', props = {}) {
    const actor = new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

function wrapping(actor) {
    actor.clutter_text.line_wrap = true;
    actor.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return actor;
}

function dimmed(actor) {
    actor.opacity = DIM;
    return actor;
}

function hbox(props = {}) {
    return new St.BoxLayout({x_expand: true, ...props});
}

function vbox(props = {}) {
    return new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, ...props});
}

function button(text, onClick, styleClass = 'hue-button') {
    const actor = new St.Button({label: text, style_class: `button ${styleClass}`, can_focus: true,
        y_align: Clutter.ActorAlign.CENTER});
    actor.connect('clicked', () => onClick());
    return actor;
}

// A GNOME switch the user can click (PopupMenu.Switch itself is not reactive).
class ToggleButton {
    constructor(onToggle, small = false) {
        this._switch = new PopupMenu.Switch(false);
        if (small)
            this._switch.add_style_class_name('hue-switch-small');
        this.actor = new St.Button({child: this._switch, can_focus: true, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'hue-switch-button'});
        this.actor.connect('clicked', () => onToggle(this._switch.state));
    }

    set state(on) {
        this._switch.state = on;
    }
}

// The shell slider changes its value on the mouse wheel; inside the scrolling room list
// that would dim (or switch on) lights while scrolling, so the wheel scrolls the list.
const ListSlider = GObject.registerClass(
class HueListSlider extends Slider.Slider {
    vfunc_scroll_event() {
        return Clutter.EVENT_PROPAGATE;
    }
});

// Brightness 1..100 % in steps of 5 (1 at the bottom), sent while dragging at most every
// SEND_EVERY ms and once more when the drag ends. Snapshots never move a slider that is
// being dragged.
class Brightness {
    constructor(onChange, styleClass) {
        this._onChange = onChange;
        this.slider = new ListSlider(0);
        this.slider.add_style_class_name(styleClass);
        this.slider.x_expand = true;
        this.slider.accessible_name = 'Brightness';
        this._dragging = false;
        this.slider.connect('drag-begin', () => (this._dragging = true));
        this.slider.connect('drag-end', () => {
            this._dragging = false;
            this._sendNow();
        });
        this.slider.connect('notify::value', () => {
            if (this._setting)
                return;
            this.onLive?.(this.percent);
            if (!this._dragging)
                this._sendNow();
            else if (!this._timer)
                this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEND_EVERY, () => {
                    this._timer = 0;
                    this._sendNow();
                    return GLib.SOURCE_REMOVE;
                });
        });
        this.slider.connect('destroy', () => {
            if (this._timer)
                GLib.source_remove(this._timer);
            this._timer = 0;
        });
    }

    get percent() {
        return Math.max(1, Math.round(this.slider.value * 100 / 5) * 5);
    }

    get busy() {
        return this._dragging || !!this._timer;
    }

    _sendNow() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        const percent = this.percent;
        if (percent !== this._sent) {
            this._sent = percent;
            this._onChange(percent);
        }
    }

    set(percent, color) {
        if (!this.busy) {
            this._setting = true;
            this.slider.value = Math.max(0, Math.min(1, Number(percent || 0) / 100));
            this._setting = false;
            this._sent = this.percent;
        }
        this.slider.style = `-barlevel-active-background-color: ${safeColor(color)};`;
    }
}

// ---------------------------------------------------------------------------------- room card

class RoomCard {
    constructor(panel, room, bulbIcon) {
        this._panel = panel;
        this._bulbIcon = bulbIcon;
        this._allScenes = false;
        this.actor = vbox({style_class: 'hue-room'});

        // Header: badge, name and status, chevron (all one button that expands), switch.
        const head = hbox({style_class: 'hue-room-head'});
        this._expander = new St.Button({x_expand: true, can_focus: true, style_class: 'hue-expander'});
        const expanderBox = hbox();
        this._badge = new St.Bin({style_class: 'hue-badge', y_align: Clutter.ActorAlign.CENTER});
        this._badgeIcon = new St.Icon({style_class: 'hue-badge-icon'});
        this._badge.child = this._badgeIcon;
        const names = vbox({y_align: Clutter.ActorAlign.CENTER});
        this._name = label('', 'hue-room-name');
        this._status = dimmed(label('', 'hue-caption'));
        names.add_child(this._name);
        names.add_child(this._status);
        this._chevron = new St.Icon({icon_name: 'pan-end-symbolic', style_class: 'hue-chevron', y_align: Clutter.ActorAlign.CENTER});
        expanderBox.add_child(this._badge);
        expanderBox.add_child(names);
        expanderBox.add_child(this._chevron);
        this._expander.child = expanderBox;
        this._expander.connect('clicked', () => panel.toggleExpanded(this._room));
        this._switch = new ToggleButton(on => panel.setRoom(this._room, {on: !on}));
        head.add_child(this._expander);
        head.add_child(this._switch.actor);
        this.actor.add_child(head);

        // Brightness, only while the room is on.
        this._briRow = hbox({style_class: 'hue-bri-row'});
        this._bri = new Brightness(bri => panel.setRoom(this._room, {bri}), 'hue-slider');
        this._briLabel = label('', 'hue-caption hue-pct');
        this._bri.onLive = percent => (this._briLabel.text = `${percent}%`);
        this._briRow.add_child(this._bri.slider);
        this._briRow.add_child(this._briLabel);
        this.actor.add_child(this._briRow);

        // Expanded: single lights, then the room's scenes.
        this._details = vbox({style_class: 'hue-details'});
        this._lights = vbox({style_class: 'hue-lights'});
        this._scenes = vbox({style_class: 'hue-scenes'});
        this._details.add_child(this._lights);
        this._details.add_child(this._scenes);
        this.actor.add_child(this._details);
        this._lightRows = new Map();
        this.update(room);
    }

    update(room) {
        this._room = room;
        const lit = room.on === true;
        const tint = lit ? safeColor(room.color) : null;
        const open = this._panel.isExpanded(room);
        this.actor.style = lit
            ? `background-color: ${rgba(tint, 0.12)}; border-color: ${rgba(tint, 0.4)};`
            : '';
        this.actor.set_style_pseudo_class(lit ? 'lit' : null);
        this._badge.style = lit ? `background-color: ${tint};` : '';
        const icon = roomIcon(room);
        if (icon)
            this._badgeIcon.icon_name = icon;
        else
            this._badgeIcon.gicon = this._bulbIcon;
        this._badgeIcon.style = lit ? `color: ${onTint(tint)};` : '';
        this._badgeIcon.opacity = lit ? 255 : DIM;
        this._name.text = room.kind === 'other' ? 'Other lights' : room.name;
        this._name.opacity = lit ? 255 : 200;
        this._status.text = roomStatus(room);
        this._chevron.icon_name = open ? 'pan-down-symbolic' : 'pan-end-symbolic';
        this._expander.accessible_name = `${this._name.text}, ${this._status.text}, ${open ? 'collapse' : 'expand'}`;
        this._switch.state = lit;
        this._switch.actor.accessible_name = `${this._name.text} ${lit ? 'on' : 'off'}`;

        this._briRow.visible = lit;
        this._bri.set(Math.max(1, room.bri), tint);
        if (!this._bri.busy)
            this._briLabel.text = `${Math.round(Math.max(1, room.bri))}%`;

        this._details.visible = open;
        if (open) {
            this._updateLights(room.lights);
            this._updateScenes(room.scenes);
        }
    }

    _updateLights(lights) {
        const ids = lights.map(light => light.id).join(',');
        if (ids !== this._lightIds) {
            this._lightIds = ids;
            this._lights.destroy_all_children();
            this._lightRows.clear();
            for (const light of lights) {
                const row = new LightRow(this._panel);
                this._lightRows.set(light.id, row);
                this._lights.add_child(row.actor);
            }
        }
        for (const light of lights)
            this._lightRows.get(light.id)?.update(light);
    }

    _updateScenes(scenes) {
        // The first SCENE_LIMIT scenes by name, plus an active one that would be hidden.
        const shown = this._allScenes ? scenes
            : scenes.filter((scene, index) => index < SCENE_LIMIT || scene.active);
        const key = `${this._allScenes}|${scenes.map(s => `${s.id}:${s.name}:${s.active}`).join(',')}`;
        this._scenes.visible = scenes.length > 0;
        if (key === this._sceneKey)
            return;
        this._sceneKey = key;
        this._scenes.destroy_all_children();
        const pills = shown.map(scene => {
            const pill = button(scene.name || '', () => this._panel.send({cmd: 'scene', id: scene.id}),
                scene.active ? 'hue-scene hue-scene-active' : 'hue-scene');
            pill.accessible_name = `Recall scene ${scene.name}${scene.active ? ' (active)' : ''}`;
            return pill;
        });
        if (scenes.length > SCENE_LIMIT) {
            pills.push(button(this._allScenes ? 'less' : `+${scenes.length - shown.length} more`, () => {
                this._allScenes = !this._allScenes;
                this._updateScenes(this._room.scenes);
            }, 'hue-scene hue-scene-more'));
        }
        this._wrap(pills);
    }

    // Pills in rows as wide as the card: a pill starts a new row when it would not fit.
    // (Clutter.FlowLayout gives St.Buttons no height.) A pill is measured once it is in
    // its row: the menu lives on the stage, so a widget in it has a theme to measure with.
    _wrap(pills) {
        const width = Math.max(200, this.actor.has_allocation() ? this.actor.allocation.get_width() - 24 : SCENE_ROW_WIDTH);
        const newRow = () => {
            const row = hbox({style_class: 'hue-scene-row', x_expand: false});
            this._scenes.add_child(row);
            return row;
        };
        let row = newRow(), used = 0;
        for (const pill of pills) {
            row.add_child(pill);
            const [, natural] = pill.get_preferred_width(-1);
            if (used > 0 && used + natural > width) {
                row.remove_child(pill);
                row = newRow();
                row.add_child(pill);
                used = 0;
            }
            used += natural + 6;
        }
    }
}

class LightRow {
    constructor(panel) {
        this.actor = hbox({style_class: 'hue-light'});
        this._swatch = new St.Widget({style_class: 'hue-swatch', y_align: Clutter.ActorAlign.CENTER});
        this._name = label('', 'hue-caption hue-light-name', {x_expand: true});
        this._bri = new Brightness(bri => panel.send({cmd: 'light', id: this._light.id, bri}), 'hue-slider-small');
        this._bri.slider.x_expand = false;
        this._switch = new ToggleButton(on => panel.send({cmd: 'light', id: this._light.id, on: !on}), true);
        this.actor.add_child(this._swatch);
        this.actor.add_child(this._name);
        this.actor.add_child(this._bri.slider);
        this.actor.add_child(this._switch.actor);
    }

    update(light) {
        this._light = light;
        const on = light.on === true;
        const reachable = light.reachable !== false;
        const color = safeColor(light.color);
        this._swatch.style = on ? `background-color: ${color}; border-color: ${color};` : '';
        this._swatch.opacity = reachable ? 255 : 100;
        this._name.text = light.name + (reachable ? '' : ' · unreachable');
        this._name.opacity = on && reachable ? 255 : DIM;
        this._bri.slider.visible = light.dimmable === true;
        this._bri.set(on ? Math.max(1, light.bri) : 1, on ? color : '#808080');
        this._bri.slider.opacity = on ? 255 : 115;
        this._switch.state = on;
        this._switch.actor.accessible_name = `${light.name} ${on ? 'on' : 'off'}`;
    }
}

// ---------------------------------------------------------------------------------- panel

class HuePanel {
    constructor(indicator, bulbOn, bulbOff) {
        this._indicator = indicator;
        this._bulbOn = bulbOn;
        this._bulbOff = bulbOff;
        this._expanded = new Map();
        this._cards = new Map();
        this._stats = {};
        const menu = indicator.menu;

        // Header: bulb, title, bridge, "n of m on".
        const head = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const hero = hbox({style_class: 'hue-hero'});
        this._heroIcon = new St.Icon({gicon: bulbOff, style_class: 'hue-hero-icon', y_align: Clutter.ActorAlign.CENTER});
        const heroText = vbox({y_align: Clutter.ActorAlign.CENTER});
        heroText.add_child(label('Hue Lights', 'hue-title'));
        this._heroMeta = dimmed(label('', 'hue-caption'));
        heroText.add_child(this._heroMeta);
        this._pill = label('', 'hue-pill', {y_align: Clutter.ActorAlign.CENTER});
        hero.add_child(this._heroIcon);
        hero.add_child(heroText);
        hero.add_child(this._pill);
        head.add_child(hero);
        menu.addMenuItem(head);

        this._errorItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._error = wrapping(label('', 'hue-caption hue-error', {x_expand: true}));
        this._errorItem.add_child(this._error);
        menu.addMenuItem(this._errorItem);

        this._buildPairing(menu);

        // Rooms and zones, scrolling when there are many.
        this._roomsSep = new PopupMenu.PopupSeparatorMenuItem();
        menu.addMenuItem(this._roomsSep);
        this._roomsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'hue-rooms-item'});
        this._roomsBox = vbox({style_class: 'hue-rooms'});
        this._emptyLabel = dimmed(label('', 'hue-caption'));
        this._roomsBox.add_child(this._emptyLabel);
        this._scroll = new St.ScrollView({
            style_class: 'hue-scroll', x_expand: true, overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._scroll.child = this._roomsBox;
        this._roomsItem.add_child(this._scroll);
        menu.addMenuItem(this._roomsItem);

        // Actions and the bridge.
        this._actionsSep = new PopupMenu.PopupSeparatorMenuItem();
        menu.addMenuItem(this._actionsSep);
        this._allOffItem = menu.addAction('All off', () => this.send({cmd: 'all_off'}), 'system-shutdown-symbolic');
        this._refreshItem = menu.addAction('Refresh', () => this.send({cmd: 'refresh'}), 'view-refresh-symbolic');
        this._bridgeItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const bridgeRow = hbox({style_class: 'hue-bridge-row'});
        bridgeRow.add_child(dimmed(label('Bridge', 'hue-caption hue-bridge-label')));
        this._bridgeText = label('', 'hue-caption', {x_expand: true});
        bridgeRow.add_child(this._bridgeText);
        this._unpair = button('Unpair', () => this._onUnpair(), 'hue-button');
        this._unpair.accessible_name = 'Unpair: forget this bridge and its app key on this PC';
        bridgeRow.add_child(this._unpair);
        this._bridgeItem.add_child(bridgeRow);
        menu.addMenuItem(this._bridgeItem);

        menu.connect('open-state-changed', (_menu, open) => {
            this.send({cmd: open ? 'open' : 'closed'});
            if (open) {
                const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
                const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                this._scroll.style = `max-height: ${Math.max(220, Math.min(560, Math.round(workArea.height / scale) - 300))}px;`;
                this.update(this._stats);
            } else {
                this._setConfirm(false);
            }
        });
    }

    _buildPairing(menu) {
        this._pairSep = new PopupMenu.PopupSeparatorMenuItem('Pair a Hue bridge');
        menu.addMenuItem(this._pairSep);
        this._pairItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = vbox({style_class: 'hue-pairing'});
        this._pairText = wrapping(label('', 'hue-caption', {x_expand: true}));
        this._candidates = vbox({style_class: 'hue-candidates'});
        this._notFound = wrapping(dimmed(label('', 'hue-caption', {x_expand: true})));
        const manual = hbox({style_class: 'hue-manual'});
        this._ipEntry = new St.Entry({style_class: 'hue-entry', hint_text: 'Bridge IP, e.g. 192.168.178.106',
            can_focus: true, x_expand: true});
        this._ipEntry.clutter_text.max_length = 64;
        this._ipEntry.clutter_text.connect('activate', () => this._pairManual());
        this._ipEntry.clutter_text.connect('text-changed', () => this._updatePairButton());
        this._manualPair = button('Pair', () => this._pairManual());
        manual.add_child(this._ipEntry);
        manual.add_child(this._manualPair);
        this._manualRow = manual;
        const actions = hbox({style_class: 'hue-pair-actions'});
        this._searchAgain = button('Search again', () => this.send({cmd: 'discover'}));
        this._cancelPair = button('Cancel', () => this.send({cmd: 'cancel_pair'}));
        actions.add_child(this._searchAgain);
        actions.add_child(this._cancelPair);
        for (const actor of [this._pairText, this._candidates, this._notFound, manual, actions])
            box.add_child(actor);
        this._pairItem.add_child(box);
        menu.addMenuItem(this._pairItem);
        this._updatePairButton();
    }

    _pairManual() {
        const ip = this._ipEntry.text.trim();
        if (ip)
            this.send({cmd: 'pair', ip});
    }

    _updatePairButton() {
        const ok = this._ipEntry.text.trim() !== '';
        this._manualPair.reactive = ok;
        this._manualPair.opacity = ok ? 255 : 120;
    }

    _onUnpair() {
        if (!this._confirm) {
            this._setConfirm(true);
            return;
        }
        this._setConfirm(false);
        this.send({cmd: 'unpair'});
    }

    _setConfirm(on) {
        this._confirm = on;
        this._unpair.label = on ? 'Really unpair?' : 'Unpair';
        if (on)
            this._unpair.add_style_class_name('hue-danger');
        else
            this._unpair.remove_style_class_name('hue-danger');
    }

    send(command) {
        this._indicator.send(command);
    }

    isExpanded(room) {
        return this._expanded.get(roomKey(room)) === true;
    }

    toggleExpanded(room) {
        this._expanded.set(roomKey(room), !this.isExpanded(room));
        this._cards.get(roomKey(room))?.update(room);
    }

    // Rooms with a grouped light are switched with one bridge command; "Other lights" per light.
    setRoom(room, fields) {
        if (room.grouped_light) {
            this.send({cmd: 'group', id: room.grouped_light, ...fields});
            return;
        }
        for (const light of room.lights)
            this.send({cmd: 'light', id: light.id, ...fields});
    }

    update(stats) {
        this._stats = stats;
        const phase = String(stats.phase || 'connecting');
        const paired = ['ok', 'error', 'connecting'].includes(phase);
        const bridge = stats.bridge || {};
        const onCount = Number(stats.on_count || 0);
        const rooms = Array.isArray(stats.rooms) ? stats.rooms : [];

        this._heroIcon.gicon = onCount > 0 ? this._bulbOn : this._bulbOff;
        this._heroIcon.opacity = onCount > 0 ? 255 : DIM;
        this._heroIcon.style_class = `hue-hero-icon${onCount > 0 ? ' hue-accent' : ''}`;
        this._heroMeta.text = paired
            ? (bridge.name || 'Hue Bridge') + (bridge.ip ? ` · ${bridge.ip}` : '')
            : 'No bridge paired';
        this._pill.text = phase === 'ok' ? `${onCount} of ${Number(stats.light_count || 0)} on` : '';
        this._pill.visible = this._pill.text !== '';
        this._error.text = String(stats.error || '');
        this._errorItem.visible = this._error.text !== '';

        this._updatePairing(stats, phase, paired);

        for (const actor of [this._roomsSep, this._roomsItem, this._actionsSep, this._allOffItem, this._refreshItem, this._bridgeItem])
            actor.visible = paired;
        if (!paired)
            return;
        this._allOffItem.setSensitive(onCount > 0);
        this._bridgeText.text = (bridge.name || 'Hue Bridge') + (bridge.ip ? ` · ${bridge.ip}` : '');
        this._emptyLabel.text = phase === 'ok' ? 'No lights on this bridge yet.' : 'Connecting to the bridge …';
        this._emptyLabel.visible = rooms.length === 0;
        this._updateRooms(rooms);
    }

    _updatePairing(stats, phase, paired) {
        this._pairSep.visible = this._pairItem.visible = !paired;
        if (paired)
            return;
        const pairing = phase === 'pairing';
        this._pairText.text = pairing
            ? `Press the round link button on top of the bridge now. Waiting ${Number(stats.pair_remaining || 0)} s for ${stats.pair_ip} …`
            : 'Click Pair, then press the round link button on top of the bridge within 30 seconds.';
        this._pairText.opacity = pairing ? 255 : DIM;
        const candidates = pairing ? [] : (Array.isArray(stats.candidates) ? stats.candidates : []);
        const key = candidates.map(c => `${c.ip}|${c.name}`).join(',');
        if (key !== this._candidateKey) {
            this._candidateKey = key;
            this._candidates.destroy_all_children();
            for (const candidate of candidates) {
                const row = hbox({style_class: 'hue-candidate'});
                row.add_child(label(`${candidate.name || 'Hue Bridge'}  ·  ${candidate.ip}`, 'hue-body', {x_expand: true}));
                row.add_child(button('Pair', () => this.send({cmd: 'pair', ip: candidate.ip})));
                this._candidates.add_child(row);
            }
        }
        this._candidates.visible = candidates.length > 0;
        this._notFound.visible = !pairing && candidates.length === 0;
        this._notFound.text = stats.discovering
            ? 'Searching the network for Hue bridges …'
            : 'No bridge found automatically. Enter its IP address:';
        this._manualRow.visible = !pairing;
        this._searchAgain.visible = !pairing;
        const discovering = stats.discovering === true;
        this._searchAgain.reactive = !discovering;
        this._searchAgain.opacity = discovering ? 120 : 255;
        this._cancelPair.visible = pairing;
    }

    _updateRooms(rooms) {
        const keys = rooms.map(roomKey);
        if (keys.join(',') !== this._roomKeys) {
            this._roomKeys = keys.join(',');
            for (const [key, card] of this._cards) {
                if (!keys.includes(key)) {
                    card.actor.destroy();
                    this._cards.delete(key);
                }
            }
            rooms.forEach((room, index) => {
                let card = this._cards.get(roomKey(room));
                if (!card) {
                    card = new RoomCard(this, room, this._bulbOn);
                    this._cards.set(roomKey(room), card);
                    this._roomsBox.add_child(card.actor);
                }
                this._roomsBox.set_child_at_index(card.actor, index + 1);   // after the empty label
            });
        }
        for (const room of rooms)
            this._cards.get(roomKey(room))?.update(room);
    }
}

// ---------------------------------------------------------------------------------- indicator

const Indicator = GObject.registerClass(
class HueLightsIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Hue Lights', false);
        this._extension = extension;
        this._stats = {};
        this.add_style_class_name('hue-lights-button');

        // Only the left button opens the menu; the right one switches every light off.
        this._clickGesture.set_required_button(Clutter.BUTTON_PRIMARY);
        const rightClick = new Clutter.ClickGesture({required_button: Clutter.BUTTON_SECONDARY});
        rightClick.set_recognize_on_press(true);
        rightClick.connect('recognize', () => this._allOff());
        this.add_action(rightClick);

        const icons = extension.dir.get_child('icons');
        this._bulbOn = Gio.FileIcon.new(icons.get_child('hue-bulb-on-symbolic.svg'));
        this._bulbOff = Gio.FileIcon.new(icons.get_child('hue-bulb-off-symbolic.svg'));
        this._icon = new St.Icon({gicon: this._bulbOff, style_class: 'system-status-icon hue-bar-icon'});
        this.add_child(this._icon);

        this._panel = new HuePanel(this, this._bulbOn, this._bulbOff);
        this._render();
    }

    send(command) {
        this._extension.send(command);
    }

    _allOff() {
        if (Number(this._stats.on_count || 0) > 0)
            this.send({cmd: 'all_off'});
    }

    setStats(stats) {
        this._stats = stats;
        this._render();
        if (this.menu.isOpen)
            this._panel.update(stats);
    }

    // What the Omarchy widget's tooltip said: for screen readers here.
    _summary() {
        const stats = this._stats;
        if (stats.phase === 'unpaired' || stats.phase === 'pairing')
            return 'Hue Lights. No bridge paired yet: click to pair';
        if (stats.phase === 'error')
            return `Hue Lights. ${stats.error || 'Bridge not reachable'}`;
        const lines = [`Hue Lights, ${Number(stats.on_count || 0)} of ${Number(stats.light_count || 0)} on`];
        for (const room of Array.isArray(stats.rooms) ? stats.rooms : []) {
            if (room.kind === 'room' || room.kind === 'other') {
                lines.push(`${room.kind === 'other' ? 'Other lights' : room.name} ${room.on ? `on, ${Math.round(room.bri)}%` : 'off'}`);
            }
        }
        if (Number(stats.on_count || 0) > 0)
            lines.push('Right click: all off');
        return lines.join('. ');
    }

    _render() {
        const anyOn = Number(this._stats.on_count || 0) > 0;
        this._icon.gicon = anyOn ? this._bulbOn : this._bulbOff;
        this._icon.style = anyOn ? `color: ${LIT};` : '';
        this._icon.opacity = anyOn ? 255 : DIM;
        this.accessible_name = this._summary();
    }

    onHelperStarted() {
        if (this.menu.isOpen)
            this.send({cmd: 'open'});
    }
});

// ---------------------------------------------------------------------------------- extension

export default class HueLightsExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        const script = this.dir.get_child('scripts').get_child('hue-lights.py').get_path();
        this._helper = new Helper(script, stats => this._indicator?.setStats(stats),
            () => this._indicator?.onHelperStarted());
        this._helper.start();
    }

    disable() {
        this._helper?.stop();
        this._helper = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    send(command) {
        this._helper?.send(command);
    }
}
