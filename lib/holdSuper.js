// Hold Super to jump: held past HOLD_MS with nothing else touched, it opens
// the canvas with everything on show; letting go enters the window under the
// pointer. A tap stays GNOME's (the overview, or the canvas with
// replace-overview), and Super+key or Super+scroll shortcuts are left alone.
//
// Keys going to an app never reach the stage, and mutter keeps Super's
// release for itself (it becomes the `overlay-key` signal, which only comes
// if no other key was pressed meanwhile). So Super is found by polling the
// modifier state, other input during the wait by the idle monitor, and
// `overlay-key` tells a plain hold from a shortcut once Super is up.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const HOLD_MS = 450;
const POLL_MS = 50;
// Input this much after Super went down means a shortcut or a movement, not a plain hold.
const ACTIVITY_SLACK_MS = 20;
// After Super is up, how long to wait for `overlay-key` before calling it a shortcut.
const OVERLAY_WAIT_MS = 150;
// The overview key fires as Super is released: this long to swallow it.
const AFTERGLOW_MS = 600;
const SUPER_MODS = Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK;
const OTHER_MODS = Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK |
    Clutter.ModifierType.SHIFT_MASK;
const CANCELLING = [Clutter.EventType.KEY_PRESS, Clutter.EventType.SCROLL, Clutter.EventType.BUTTON_PRESS,
    Clutter.EventType.TOUCHPAD_PINCH, Clutter.EventType.TOUCHPAD_SWIPE];

export class HoldSuper {
    /**
     * @param {Gio.Settings} settings
     * @param {Controller} controller
     */
    constructor(settings, controller) {
        this._settings = settings;
        this._controller = controller;
        // null, 'pending' (waiting out HOLD_MS), 'active' (canvas up) or
        // 'released' (Super up, waiting to hear whether it was a shortcut).
        this._state = null;
        // False from a cancelled hold until Super comes up, so it does not restart.
        this._armed = true;
        this._cancelled = false;
        this._swallow = false;
        this._since = 0;
        this._pointer = [0, 0];
        this._poll = 0;
        this._waiting = 0;
        this._afterglow = 0;
    }

    enable() {
        global.stage.connectObject('captured-event', (stage, event) => this._onEvent(event), this);
        global.display.connectObject('overlay-key', () => this._onOverlayKey(), this);
        this._settings.connectObject('changed::hold-super', () => this._sync(), this);
        this._sync();
    }

    disable() {
        global.stage.disconnectObject(this);
        global.display.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._stopPoll();
        this._stopWaiting();
        if (this._afterglow)
            GLib.source_remove(this._afterglow);
        this._afterglow = 0;
        this._state = null;
        this._swallow = false;
    }

    /** The overview key is about to toggle after a hold: the caller skips it, once. */
    consumeToggle() {
        const swallow = this._swallow;
        this._swallow = false;
        return swallow;
    }

    _sync() {
        this._stopPoll();
        if (this._settings.get_boolean('hold-super'))
            this._poll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => this._tick());
    }

    _stopPoll() {
        if (this._poll)
            GLib.source_remove(this._poll);
        this._poll = 0;
    }

    _stopWaiting() {
        if (this._waiting)
            GLib.source_remove(this._waiting);
        this._waiting = 0;
    }

    _now() {
        return GLib.get_monotonic_time() / 1000;
    }

    _tick() {
        const [, , mods] = global.get_pointer();
        const superDown = (mods & SUPER_MODS) !== 0;
        const others = (mods & OTHER_MODS) !== 0;
        if (!superDown)
            this._armed = true;
        if (this._state === null) {
            if (superDown && this._armed && !others && !Main.overview.visible && !Main.sessionMode.isLocked) {
                this._state = 'pending';
                this._since = this._now();
                this._pointer = global.get_pointer().slice(0, 2);
                this._cancelled = false;
            }
        } else if (this._state === 'pending') {
            if (!superDown)
                this._state = null; // a tap: GNOME's
            else if (others)
                this._abandon();
            else if (this._now() - this._since >= HOLD_MS)
                this._fire();
        } else if (this._state === 'active') {
            if (others)
                this._cancelled = true;
            if (!superDown)
                this._superUp();
        }
        return GLib.SOURCE_CONTINUE;
    }

    _abandon() {
        this._state = null;
        this._armed = false;
    }

    _fire() {
        const elapsed = this._now() - this._since;
        const idle = global.backend.get_core_idle_monitor().get_idletime();
        // A key was pressed since Super went down: a shortcut. (Pointer
        // movement also counts as activity, but pointing is what a hold is for.)
        const [x, y] = global.get_pointer();
        const moved = x !== this._pointer[0] || y !== this._pointer[1];
        if (idle < elapsed - ACTIVITY_SLACK_MS && !moved) {
            this._abandon();
            return;
        }
        const c = this._controller;
        if (c.mode !== 'canvas')
            c.fitAll();
        if (c.mode !== 'canvas') {
            this._abandon();
            return;
        }
        this._state = 'active';
        this._swallow = true;
    }

    _onEvent(event) {
        // The canvas holds the stage, so keys and gestures reach it: any of
        // them with Super down makes this a shortcut (Super+scroll zooms).
        if (CANCELLING.includes(event.type())) {
            if (this._state === 'pending')
                this._abandon();
            else if (this._state === 'active')
                this._cancelled = true;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _superUp() {
        // `overlay-key` follows at once for a plain hold; none means a shortcut.
        this._state = 'released';
        this._waiting = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OVERLAY_WAIT_MS, () => {
            this._waiting = 0;
            this._state = null;
            this._swallow = false;
            if (this._controller.mode === 'canvas' && !this._cancelled)
                this._controller.leaveCanvas();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onOverlayKey() {
        if (this._state !== 'active' && this._state !== 'released')
            return;
        this._stopWaiting();
        this._state = null;
        if (this._afterglow)
            GLib.source_remove(this._afterglow);
        this._afterglow = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AFTERGLOW_MS, () => {
            this._afterglow = 0;
            this._swallow = false;
            return GLib.SOURCE_REMOVE;
        });
        const c = this._controller;
        if (this._cancelled || c.mode !== 'canvas')
            return;
        const [x, y] = global.get_pointer();
        const rec = c.recordAt(x, y);
        if (rec)
            c.enterCentered(rec);
        else
            c.leaveCanvas();
    }
}
