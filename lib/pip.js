// Picture in picture: a window becomes a small live tile pinned to a corner
// of the screen, over the canvas and every other window, wherever the canvas
// goes. The tile is the real window, its actor scaled down and moved (so it
// keeps drawing and a click in it reaches the app); on the canvas, where the
// overlay covers the windows, a clone stands in for it. A slim bar on top
// drags the tile to the nearest corner (a fling goes where it is heading), a
// grip on its corner resizes it, and the home button sends the window back
// to its place on the canvas.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Geo from './geometry.js';

const BAR_H = 26;
const IDLE_OPACITY = 60;
const GRIP = 18;
const SNAP_MS = 240;
const DRAG_SLOP = 4;
// Pointer samples older than this don't count towards a fling's speed.
const FLING_WINDOW_MS = 90;

const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const now = () => GLib.get_monotonic_time() / 1000;

class Tile {
    constructor(pip, win, saved, corner) {
        this._pip = pip;
        this.win = win;
        this.saved = saved; // the window's place on the canvas
        this.corner = corner;
        this._timer = 0;
        this._drag = null;

        const f = win.get_frame_rect();
        this.scale = Geo.pipScaleFor(f.width, f.height, pip.area());

        this.actor = win.get_compositor_private();
        this.clone = new Clutter.Clone({source: this.actor, reactive: true, visible: false});
        this.frame = new St.Widget({style_class: 'skylight-pip-frame', reactive: false});
        this.bar = new St.BoxLayout({style_class: 'skylight-pip-bar', reactive: true, opacity: IDLE_OPACITY});
        this.home = new St.Button({
            style_class: 'skylight-pip-button',
            child: new St.Icon({icon_name: 'go-home-symbolic', icon_size: 14}),
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        this.bar.add_child(this.home);
        this.grip = new St.Widget({style_class: 'skylight-pip-grip', reactive: true, opacity: IDLE_OPACITY});
        // Faint until pointed at (not fully clear: a clear actor can't be hit).
        for (const a of [this.bar, this.grip]) {
            a.connect('enter-event', () => a.ease({opacity: 255, duration: 120}));
            a.connect('leave-event', () => a.ease({opacity: IDLE_OPACITY, duration: 200}));
        }

        const layer = Main.layoutManager.uiGroup;
        for (const a of [this.clone, this.frame, this.bar, this.grip])
            layer.insert_child_above(a, pip.overlay());
        for (const a of [this.clone, this.bar, this.grip])
            this._pip.view().chromeActors.add(a);

        this.home.connect('clicked', () => pip.restore(win));
        this.clone.connect('button-release-event', () => {
            pip.restore(win, true);
            return Clutter.EVENT_STOP;
        });
        this.bar.connect('button-press-event', (a, e) => this._press(e, 'move', this.bar));
        this.grip.connect('button-press-event', (a, e) => this._press(e, 'resize', this.grip));
        win.connectObject(
            'size-changed', () => this.layout(),
            'unmanaged', () => pip.forget(win),
            this);

        const pos = Geo.pipCorners(pip.area(), ...this.size())[corner];
        this.place(pos[0], pos[1]);
    }

    /** The tile's size on screen. */
    size() {
        const f = this.win.get_frame_rect();
        return [Math.round(f.width * this.scale), Math.round(f.height * this.scale)];
    }

    /** Put the tile's top-left at (x, y) on screen. */
    place(x, y) {
        this.x = x;
        this.y = y;
        this.layout();
    }

    layout() {
        const f = this.win.get_frame_rect();
        const a = this.actor;
        const [w, h] = this.size();
        a.set_pivot_point((f.x - a.x) / a.width, (f.y - a.y) / a.height);
        a.set_scale(this.scale, this.scale);
        a.translation_x = this.x - f.x;
        a.translation_y = this.y - f.y;
        // The clone draws the actor untransformed, from the actor's own corner.
        this.clone.set_pivot_point(0, 0);
        this.clone.set_scale(this.scale, this.scale);
        this.clone.set_position(this.x - (f.x - a.x) * this.scale, this.y - (f.y - a.y) * this.scale);
        this.frame.set_position(this.x - 1, this.y - 1);
        this.frame.set_size(w + 2, h + 2);
        this.bar.set_position(this.x, this.y);
        this.bar.set_size(w, BAR_H);
        this.grip.set_position(this.x + w - GRIP, this.y + h - GRIP);
        this.grip.set_size(GRIP, GRIP);
        this.syncOverlay();
    }

    /** The clone stands in only while the canvas covers the real windows. */
    syncOverlay() {
        this.clone.visible = this._pip.overlay().visible;
    }

    _press(event, kind, handle) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._stopTimer();
        const [px, py] = event.get_coords();
        this._drag = {kind, px, py, x: this.x, y: this.y, scale: this.scale, moved: false,
            samples: [[now(), px, py]], grab: global.stage.grab(handle), handle};
        // The grab sends every event to the handle, ahead of the canvas's own handling.
        handle.connectObject('captured-event', (a, e) => this._onDrag(e), this);
        return Clutter.EVENT_STOP;
    }

    _onDrag(event) {
        const d = this._drag;
        const type = event.type();
        if (type === Clutter.EventType.MOTION) {
            const [px, py] = event.get_coords();
            const dx = px - d.px, dy = py - d.py;
            if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP)
                return Clutter.EVENT_STOP;
            d.moved = true;
            d.samples.push([now(), px, py]);
            if (d.kind === 'move') {
                this.place(d.x + dx, d.y + dy);
            } else {
                const f = this.win.get_frame_rect();
                this.scale = Geo.pipResizedScale(d.scale, f.width, f.height, dx, dy);
                const [w, h] = this.size();
                const pos = Geo.pipCorners(this._pip.area(), w, h)[this.corner];
                this.place(pos[0], pos[1]);
            }
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE) {
            this._endDrag();
            if (d.moved && d.kind === 'move')
                this._drop(d);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        const d = this._drag;
        if (!d)
            return;
        d.handle.disconnectObject(this);
        d.grab.dismiss();
        this._drag = null;
    }

    /** Let go: settle into the corner the drop or fling points at. */
    _drop(d) {
        const t = now();
        const recent = d.samples.filter(s => t - s[0] <= FLING_WINDOW_MS);
        // Held still before letting go: no fling.
        let vx = 0, vy = 0;
        if (recent.length > 1) {
            const first = recent[0], last = recent[recent.length - 1];
            const dt = Math.max(last[0] - first[0], 1);
            vx = (last[1] - first[1]) / dt;
            vy = (last[2] - first[2]) / dt;
        }
        const [w, h] = this.size();
        this.corner = Geo.nearestPipCorner(this._pip.area(), w, h, this.x, this.y, vx, vy,
            this._pip.cornersTaken(this));
        this.snap();
    }

    /** Glide to the corner. */
    snap() {
        const [w, h] = this.size();
        const [tx, ty] = Geo.pipCorners(this._pip.area(), w, h)[this.corner];
        const x0 = this.x, y0 = this.y, t0 = now();
        this._stopTimer();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            const k = Math.min((now() - t0) / SNAP_MS, 1);
            const e = easeOutCubic(k);
            this.place(x0 + (tx - x0) * e, y0 + (ty - y0) * e);
            if (k < 1)
                return GLib.SOURCE_CONTINUE;
            this._timer = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopTimer() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }

    /** Back to a plain window; the caller gives it its place. */
    destroy() {
        this._stopTimer();
        this._endDrag();
        this.win.disconnectObject(this);
        const a = this.actor;
        a.set_scale(1, 1);
        a.set_pivot_point(0, 0);
        a.translation_x = 0;
        a.translation_y = 0;
        for (const x of [this.clone, this.frame, this.bar, this.grip]) {
            this._pip.view().chromeActors.delete(x);
            x.destroy();
        }
    }
}

export class Pip {
    /** @param {Controller} controller */
    constructor(controller) {
        this._c = controller;
        this._tiles = new Map();
    }

    enable() {
        this._c.view.actor.connectObject('notify::visible', () => {
            for (const t of this._tiles.values())
                t.syncOverlay();
        }, this);
        Main.layoutManager.connectObject('monitors-changed', () => this.relayout(), this);
    }

    disable() {
        this._c.view.actor.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        for (const win of [...this._tiles.keys()])
            this.restore(win);
    }

    area() {
        return this._c.viewport();
    }

    view() {
        return this._c.view;
    }

    overlay() {
        return this._c.view.actor;
    }

    has(win) {
        return this._tiles.has(win);
    }

    cornersTaken(except) {
        return [...this._tiles.values()].filter(t => t !== except).map(t => t.corner);
    }

    /** `saved`: the window's rect on the canvas, where the home button sends it back. */
    add(win, saved) {
        const taken = this.cornersTaken(null);
        const corner = ['br', 'bl', 'tr', 'tl'].find(c => !taken.includes(c)) ?? 'br';
        win.stick();
        win.make_above();
        this._tiles.set(win, new Tile(this, win, saved, corner));
    }

    /** The window is gone: drop its tile. */
    forget(win) {
        this._tiles.get(win)?.destroy();
        this._tiles.delete(win);
    }

    /** Back onto the canvas, and into the window with `enter`. */
    restore(win, enter = false) {
        const tile = this._tiles.get(win);
        if (!tile)
            return;
        this._tiles.delete(win);
        const saved = tile.saved;
        tile.destroy();
        win.unmake_above();
        win.unstick();
        this._c.adoptWindow(win, saved, enter);
    }

    relayout() {
        for (const t of this._tiles.values()) {
            const [w, h] = t.size();
            const [x, y] = Geo.pipCorners(this.area(), w, h)[t.corner];
            t.place(x, y);
        }
    }
}
