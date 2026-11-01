// Pointer, touchpad and keyboard handling. In live mode only gestures that
// start on the empty desktop (or carry Super, or use three fingers) are
// taken; on the canvas everything is.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Geo from './geometry.js';
import {resizeCursor} from './compat.js';

const DRAG_SLOP = 3; // px before a press on a window becomes a drag
const SNAP_DISTANCE = 8; // screen px within which alignment guides catch
const SNAP_MS = 160; // settling onto the grid
const SCROLL_PX = 10; // px per smooth-scroll unit (mutter divides by 10)
const WHEEL_ZOOM = 1.12; // per wheel notch
const VELOCITY_WINDOW_MS = 100;
const TAP_MS = 300; // a four-finger tap: hold begins and ends within this
const RESIZE_SETTLE_MS = 1500;
const SPREAD_SCALE = 1.3; // a four-finger spread this far shows the desktop
const THREE_FINGER_PX = 40; // up or down this far, and mostly so, before a three-finger swipe counts

const now = () => GLib.get_monotonic_time() / 1000;

export class CanvasInput {
    /**
     * @param {Controller} controller
     * @param {Gio.Settings} settings
     */
    constructor(controller, settings) {
        this._c = controller;
        this._settings = settings;
        this.hovered = null;
        this._drag = null;
        this._pinch = null;
        this._spread = null; // {done}: a four-finger spread under way
        this._scrolling = false;
        this._velocity = [];
        this._hold = null;
        this._emptyClick = null; // {t, x, y}: the first click of a double-click
        this._scrollTimeout = 0;
        this._wheelTimeout = 0;
        this._fourFingers = false; // a four-finger swipe we took is under way
        this._three = null; // {dx, dy, done}: a three-finger swipe under way
        this._titleClick = null; // {frame, t}: the first click of a double-click on a frame's name
        // Ahead of every handler: from 51, GNOME's own gestures take any
        // swipe of three fingers or more. No stage given: with one, mutter
        // looks up the stage of events that have none (devices plugged in).
        this._filterId = Clutter.Event.add_filter(null, event => this._filterEvent(event));
        // Shutting down, the shell won't call disable() but still sends
        // events, and GJS refuses to run JS for them.
        global.connectObject('shutdown', () => this._removeFilter(), this);
    }

    destroy() {
        global.disconnectObject(this);
        this._removeFilter();
        this.reset();
    }

    _removeFilter() {
        if (this._filterId)
            Clutter.Event.remove_filter(this._filterId);
        this._filterId = 0;
    }

    /**
     * A four-finger swipe pans the canvas from anywhere, over windows too
     * (Sunlight's four-finger drag); at 1:1 it hands back to the windows
     * where it stops. Three fingers stay GNOME's: the overview, the dash,
     * workspaces.
     */
    _filterEvent(event) {
        if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE)
            return Clutter.EVENT_PROPAGATE;
        const phase = event.get_gesture_phase();
        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            const c = this._c;
            this._fourFingers = event.get_touchpad_gesture_finger_count() === 4 &&
                this._settings.get_boolean('four-finger-pan') &&
                !Main.sessionMode.isLocked && !Main.overview.visible && !c.userGrabbing &&
                Main.modalCount === (c.mode === 'canvas' ? 1 : 0);
            if (this._fourFingers && c.mode !== 'canvas')
                c.enterCanvas();
        }
        if (!this._fourFingers)
            return Clutter.EVENT_PROPAGATE;
        if (phase === Clutter.TouchpadGesturePhase.END || phase === Clutter.TouchpadGesturePhase.CANCEL)
            this._fourFingers = false;
        // The canvas went away mid-swipe (a workspace switch…): the rest of
        // it is still ours, or GNOME would start a gesture halfway through.
        if (this._c.mode !== 'canvas')
            return Clutter.EVENT_STOP;
        return this._onSwipe(event);
    }

    /** A gesture is under way: the canvas must not settle back to 1:1 yet. */
    get busy() {
        return this._drag !== null || this._pinch !== null || this._scrolling;
    }

    reset() {
        if (this._scrollTimeout)
            GLib.Source.remove(this._scrollTimeout);
        if (this._wheelTimeout)
            GLib.Source.remove(this._wheelTimeout);
        this._scrollTimeout = 0;
        this._wheelTimeout = 0;
        this._drag = null;
        this._pinch = null;
        this._scrolling = false;
        this._velocity = [];
        this.hovered = null;
        this._c.view?.setGuides?.([]);
    }

    /** A window went away: drop anything that refers to it. */
    forget(rec) {
        if (this.hovered === rec)
            this.hovered = null;
        if (this._drag?.rec === rec)
            this._drag = null;
    }

    /** While a window is resized from its edges, the rect and corner its size is kept against. */
    resizeAnchor(rec) {
        const d = this._drag;
        return d?.kind === 'resize' && d.rec === rec ? d.anchorTo : null;
    }

    clearHover() {
        this.hovered = null;
        this._c.view.setHovered(null);
    }

    // -----------------------------------------------------------------------
    // Live mode

    _isDesktopEvent(event) {
        const [x, y] = event.get_coords();
        const vp = this._c.viewport();
        if (x < vp.x || y < vp.y || x >= vp.x + vp.w || y >= vp.y + vp.h)
            return false;
        const actor = global.stage.get_event_actor(event);
        if (!actor || actor === global.stage)
            return true;
        for (let a = actor; a; a = a.get_parent()) {
            if (a instanceof Meta.WindowActor || a === this._c.liveMinimap)
                return false;
            if (a === global.window_group)
                return true;
        }
        return false;
    }

    /** Four fingers that land together and lift within TAP_MS: see everything, and back. */
    _onHold(event) {
        const phase = event.get_gesture_phase();
        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            this._hold = event.get_touchpad_gesture_finger_count() === 4 ? {start: now()} : null;
        } else if (phase === Clutter.TouchpadGesturePhase.END && this._hold) {
            const tap = now() - this._hold.start <= TAP_MS;
            this._hold = null;
            if (tap) {
                this._c.toggleCanvas();
                return Clutter.EVENT_STOP;
            }
        } else {
            this._hold = null;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    onStageEvent(event) {
        const type = event.type();
        // On the canvas the stage is our own modal grab (count 1), so the
        // view actor's captured-event only sees events targeted inside it; a
        // pinch targeted elsewhere (a window actor) would never reach it.
        const ownGrabPinch = (type === Clutter.EventType.TOUCHPAD_PINCH ||
            (type === Clutter.EventType.TOUCHPAD_SWIPE && event.get_touchpad_gesture_finger_count() === 3)) &&
            this._c.mode === 'canvas' && Main.modalCount === 1;
        if (Main.sessionMode.isLocked || Main.overview.visible || this._c.userGrabbing ||
            (Main.modalCount > 0 && !ownGrabPinch))
            return Clutter.EVENT_PROPAGATE;
        if (this._c.mode !== 'live' && !ownGrabPinch)
            return Clutter.EVENT_PROPAGATE;

        if (type === Clutter.EventType.TOUCHPAD_HOLD)
            return this._onHold(event);

        if (type === Clutter.EventType.TOUCHPAD_PINCH) {
            const phase = event.get_gesture_phase();
            const fingers = event.get_touchpad_gesture_finger_count();
            // Super held: zoom from anywhere, as Super + wheel does.
            const superHeld = (event.get_state() &
                (Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK)) !== 0;
            // Thumb and three fingers spreading: Show Desktop, not a zoom.
            if ((fingers === 4 || this._spread) && this._settings.get_boolean('four-finger-spread'))
                return this._onSpread(event);
            const ours = this._pinch !== null || superHeld ||
                fingers >= this._settings.get_int('pinch-fingers') ||
                (fingers === 2 && (this._c.mode === 'canvas' || this._isDesktopEvent(event)));
            // Take the whole gesture (BEGIN→UPDATE→END), not only BEGIN: otherwise
            // UPDATEs propagate to GNOME and the zoom jumps or only goes one way.
            if (!ours)
                return Clutter.EVENT_PROPAGATE;
            if (phase === Clutter.TouchpadGesturePhase.BEGIN && this._c.mode !== 'canvas')
                this._c.enterCanvas();
            return this._handle(event);
        }

        if (type === Clutter.EventType.TOUCHPAD_SWIPE &&
            event.get_touchpad_gesture_finger_count() === 3 && this._settings.get_boolean('replace-overview'))
            return this._onThreeFingers(event);

        if (type === Clutter.EventType.SCROLL) {
            const mods = event.get_state();
            const superHeld = (mods & (Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK)) !== 0;
            if (superHeld || this._isDesktopEvent(event)) {
                if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
                    return Clutter.EVENT_STOP;
                this._c.enterCanvas();
                return this._handle(event, {forceZoom: superHeld});
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.BUTTON_PRESS) {
            const button = event.get_button();
            if ((button === Clutter.BUTTON_PRIMARY || button === Clutter.BUTTON_MIDDLE) &&
                this._isDesktopEvent(event)) {
                this._c.enterCanvas();
                return this._handle(event);
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // -----------------------------------------------------------------------
    // Canvas mode

    onCanvasEvent(event) {
        // A key the input method hands back to a text field (the Open Here…
        // bar) after it has gone: not typed on the canvas.
        const type = event.type();
        // Crossing events can't be stopped (51 warns if you try).
        if ((event.get_flags() & Clutter.EventFlags.FLAG_INPUT_METHOD) ||
            type === Clutter.EventType.ENTER || type === Clutter.EventType.LEAVE)
            return Clutter.EVENT_PROPAGATE;
        // Keys in GNOME's results under the spotlight are theirs (Return
        // activates the row, Tab/arrows move); only Esc is ours.
        if ((type === Clutter.EventType.KEY_PRESS || type === Clutter.EventType.KEY_RELEASE) &&
            this._c.view.gnomeResultsFocused) {
            if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
                this._c.cancelFinder();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        const isStart = type === Clutter.EventType.BUTTON_PRESS ||
            type === Clutter.EventType.SCROLL ||
            type === Clutter.EventType.TOUCHPAD_PINCH ||
            type === Clutter.EventType.TOUCHPAD_SWIPE;

        if (this._c.mode !== 'canvas') {
            // The overlay is gliding or fading out: let a new gesture grab it.
            if (!isStart || Main.sessionMode.isLocked)
                return Clutter.EVENT_STOP;
            this._c.enterCanvas();
        }

        if (type === Clutter.EventType.TOUCHPAD_HOLD)
            return this._onHold(event);

        // The minimap and menus handle their own events.
        if (!this._drag && type !== Clutter.EventType.KEY_PRESS && type !== Clutter.EventType.KEY_RELEASE) {
            const [x, y] = event.get_coords();
            if (this._c.view.isOverChrome(x, y)) {
                if (this.hovered) {
                    this.clearHover();
                    this._c.syncView();
                }
                this._c.setCursor('default');
                return Clutter.EVENT_PROPAGATE;
            }
        }
        return this._handle(event);
    }

    _handle(event, opts = {}) {
        switch (event.type()) {
        case Clutter.EventType.BUTTON_PRESS:
            return this._onPress(event);
        case Clutter.EventType.MOTION:
            return this._onMotion(event);
        case Clutter.EventType.BUTTON_RELEASE:
            return this._onRelease(event);
        case Clutter.EventType.SCROLL:
            return this._onScroll(event, opts);
        case Clutter.EventType.TOUCHPAD_PINCH:
            return this._onPinch(event);
        case Clutter.EventType.TOUCHPAD_SWIPE:
            return this._onSwipe(event);
        case Clutter.EventType.KEY_PRESS:
            return this._onKey(event);
        case Clutter.EventType.KEY_RELEASE:
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _onPress(event) {
        const c = this._c;
        const button = event.get_button();
        const [sx, sy] = event.get_coords();
        const mods = event.get_state();

        if (c.menuOpen) {
            c.closeMenu();
            return Clutter.EVENT_STOP;
        }
        // A click on the canvas ends a search (a click on a match still goes
        // into it) or a frame's renaming.
        if (c.view.searchFocused)
            c.cancelFinder();
        c.view.endFrameEdit(true);
        if (button === Clutter.BUTTON_PRIMARY && c.doubleClick())
            return Clutter.EVENT_STOP;
        c.stopMotion();

        // Frames' names are drawn over the windows, so they come first.
        const frameHit = c.view.frameAt(sx, sy);
        if (button === Clutter.BUTTON_SECONDARY) {
            this.clearHover();
            if (frameHit?.part === 'title')
                c.openFrameMenu(frameHit.frame, sx, sy);
            else
                c.openMenu(c.recordAt(sx, sy), sx, sy);
            return Clutter.EVENT_STOP;
        }
        if (button === Clutter.BUTTON_PRIMARY && frameHit?.part === 'title') {
            const t = now(), last = this._titleClick;
            this._titleClick = {frame: frameHit.frame, t};
            if (last?.frame === frameHit.frame && t - last.t <= c.doubleClickMs) {
                this._titleClick = null;
                c.goToFrame(frameHit.frame);
            } else {
                this._drag = {kind: 'frame-press', frame: frameHit.frame, sx, sy};
            }
            return Clutter.EVENT_STOP;
        }

        if (button === Clutter.BUTTON_PRIMARY) {
            const hovered = this.hovered;
            const hit = hovered ? c.view.pillHit(hovered.win, sx, sy) : null;
            if (hit === 'close') {
                c.closeOnCanvas(hovered);
                return Clutter.EVENT_STOP;
            }
            const rec = c.recordAt(sx, sy);
            if (rec) {
                this._drag = {
                    kind: 'press', rec, sx, sy,
                    edges: c.resizeEdgesAt(rec, sx, sy),
                    shift: (mods & Clutter.ModifierType.SHIFT_MASK) !== 0,
                };
                return Clutter.EVENT_STOP;
            }
            if (frameHit) {
                this._drag = {kind: 'frame-resize', frame: frameHit.frame, edges: frameHit.edges, sx, sy, start: {...frameHit.frame}};
                return Clutter.EVENT_STOP;
            }
        }
        if (button === Clutter.BUTTON_PRIMARY || button === Clutter.BUTTON_MIDDLE) {
            this._drag = {kind: 'pan', x0: sx, y0: sy, lastX: sx, lastY: sy};
            this._velocity = [];
            c.setCursor('move');
        }
        return Clutter.EVENT_STOP;
    }

    _beginWindowMove(d) {
        const c = this._c;
        d.kind = 'move';
        d.startX = d.rec.x;
        d.startY = d.rec.y;
        // Shift carries the whole snapped group along.
        const items = c.visibleRecords().map(r => ({id: r, ...r.rect}));
        const base = d.shift ? Geo.clusterOf(d.rec, items, c.gridSize || 16) : [d.rec];
        // A window's sheets and dialogs go where it goes.
        const group = [...new Set(base.flatMap(r => [r, ...c.dialogsOf(r)]))];
        d.groupStart = new Map(group.map(r => [r, {x: r.x, y: r.y}]));
        d.undo = c.snapshot(group);
        for (const r of group)
            c.view.raise(r.win);
        c.setCursor('move');
    }

    _beginResize(d) {
        d.kind = 'resize';
        d.start = d.rec.rect;
        d.anchorTo = {rect: d.start, anchor: Geo.resizeAnchor(d.edges)};
        d.undo = this._c.snapshot([d.rec]);
        d.rec.anchorTo = null;
        this._c.view.raise(d.rec.win);
    }

    _onMotion(event) {
        const c = this._c;
        const [sx, sy] = event.get_coords();
        const d = this._drag;
        if (!d) {
            this._updateHover(sx, sy);
            return Clutter.EVENT_STOP;
        }

        if (d.kind === 'press') {
            if (Math.hypot(sx - d.sx, sy - d.sy) <= DRAG_SLOP)
                return Clutter.EVENT_STOP;
            if (d.edges)
                this._beginResize(d);
            else
                this._beginWindowMove(d);
        } else if (d.kind === 'frame-press') {
            if (Math.hypot(sx - d.sx, sy - d.sy) <= DRAG_SLOP)
                return Clutter.EVENT_STOP;
            // A frame carries the windows inside it.
            d.kind = 'frame-move';
            d.start = {x: d.frame.x, y: d.frame.y};
            d.members = new Map(c.frameMembers(d.frame).map(r => [r, {x: r.x, y: r.y}]));
            d.undo = [...c.snapshot([...d.members.keys()]), {frame: d.frame, ...d.start}];
            c.setCursor('move');
        }

        const zoom = c.camera.zoom;
        const free = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (d.kind === 'move') {
            let x = d.startX + (sx - d.sx) / zoom;
            let y = d.startY + (sy - d.sy) / zoom;
            let guides = [];
            d.snappedX = d.snappedY = false;
            if (!free && !c.stripMode && this._settings.get_boolean('snapping')) {
                const others = c.visibleRecords().filter(r => !d.groupStart.has(r)).map(r => r.rect);
                const a = Geo.align({x, y, w: d.rec.w, h: d.rec.h}, others,
                    {threshold: SNAP_DISTANCE / zoom, gap: c.gridSize || 16});
                x = a.x;
                y = a.y;
                d.snappedX = a.snappedX;
                d.snappedY = a.snappedY;
                guides = a.guides;
            }
            d.free = free;
            const dx = x - d.startX, dy = y - d.startY;
            for (const [r, start] of d.groupStart) {
                r.x = start.x + dx;
                r.y = start.y + dy;
            }
            c.view.setGuides(guides.map(g => this._guideToScreen(g)));
            c.syncView();
        } else if (d.kind === 'resize') {
            const r = Geo.resizeRect(d.start, d.edges, (sx - d.sx) / zoom, (sy - d.sy) / zoom);
            d.anchorTo = {rect: r, anchor: Geo.resizeAnchor(d.edges)};
            d.current = r;
            d.free = free;
            c.resizeReal(d.rec, r.w, r.h);
            const placed = Geo.placeAnchored(d.rec.w, d.rec.h, r, d.anchorTo.anchor);
            d.rec.x = placed.x;
            d.rec.y = placed.y;
            c.syncView();
        } else if (d.kind === 'frame-move') {
            const dx = (sx - d.sx) / zoom, dy = (sy - d.sy) / zoom;
            d.frame.x = Math.round(d.start.x + dx);
            d.frame.y = Math.round(d.start.y + dy);
            for (const [r, start] of d.members) {
                r.x = start.x + dx;
                r.y = start.y + dy;
            }
            c.syncView();
        } else if (d.kind === 'frame-resize') {
            c.resizeFrame(d.frame, Geo.resizeRect(d.start, d.edges, (sx - d.sx) / zoom, (sy - d.sy) / zoom));
        } else if (d.kind === 'pan') {
            const dx = d.lastX - sx, dy = d.lastY - sy;
            d.lastX = sx;
            d.lastY = sy;
            this._addVelocitySample(dx, dy);
            c.panBy(dx, dy);
        }
        return Clutter.EVENT_STOP;
    }

    _guideToScreen(g) {
        const cam = this._c.camera, vp = this._c.viewport();
        const [x1, y1] = Geo.canvasToScreen(cam, vp, g.x1, g.y1);
        const [x2, y2] = Geo.canvasToScreen(cam, vp, g.x2, g.y2);
        return {kind: g.kind, x1, y1, x2, y2};
    }

    _onRelease(event) {
        const c = this._c;
        const d = this._drag;
        const button = event.get_button();
        if (!d || (button !== Clutter.BUTTON_PRIMARY && button !== Clutter.BUTTON_MIDDLE))
            return Clutter.EVENT_STOP;
        this._drag = null;
        const [sx, sy] = event.get_coords();

        if (d.kind === 'press') {
            c.clickEnter(d.rec, d.sx, d.sy);
        } else if (d.kind === 'move') {
            c.view.setGuides([]);
            c.pushUndo(d.undo);
            // Let go: it settles onto the grid, except along an axis a guide
            // holds; on the strip, the strip takes it.
            if (c.stripMode) {
                c.stripDropped(d.rec);
            } else if (!d.free && c.gridSize > 0) {
                const g = Geo.gridSnap(d.rec.x, d.rec.y, c.gridSize, d.snappedX, d.snappedY);
                const dx = g.x - d.rec.x, dy = g.y - d.rec.y;
                if (dx || dy) {
                    const to = new Map();
                    for (const r of d.groupStart.keys())
                        to.set(r, {x: r.x + dx, y: r.y + dy});
                    c.animateLayout(to, SNAP_MS);
                }
            }
            c.queueSave();
            this._updateHover(sx, sy);
            c.settle();
        } else if (d.kind === 'resize') {
            c.pushUndo(d.undo);
            const final = d.free ? d.current : Geo.resizeGrid(d.current ?? d.start, d.edges, c.gridSize);
            d.rec.anchorTo = {rect: final, anchor: Geo.resizeAnchor(d.edges), until: now() + RESIZE_SETTLE_MS};
            c.resizeReal(d.rec, final.w, final.h);
            const placed = Geo.placeAnchored(d.rec.w, d.rec.h, final, d.rec.anchorTo.anchor);
            d.rec.x = placed.x;
            d.rec.y = placed.y;
            c.syncView();
            c.queueSave();
            c.settle();
        } else if (d.kind === 'frame-move') {
            c.pushUndo(d.undo);
            c.frameChanged();
            c.setCursor('default');
            c.settle();
        } else if (d.kind === 'frame-resize') {
            c.frameChanged();
            c.setCursor('default');
        } else if (d.kind === 'pan') {
            c.setCursor('default');
            if (button === Clutter.BUTTON_PRIMARY && this._isDoubleClick(sx, sy, d)) {
                c.openHere(c.canvasPoint(sx, sy));
                return Clutter.EVENT_STOP;
            }
            this._coastOrSettle();
        }
        return Clutter.EVENT_STOP;
    }

    /** A click on the empty canvas that is the second of a double-click. */
    _isDoubleClick(sx, sy, d) {
        if (Math.hypot(sx - d.x0, sy - d.y0) > DRAG_SLOP) {
            this._emptyClick = null;
            return false;
        }
        const t = now(), last = this._emptyClick;
        if (last && t - last.t <= this._c.doubleClickMs && Math.hypot(sx - last.x, sy - last.y) <= 2 * DRAG_SLOP) {
            this._emptyClick = null;
            return true;
        }
        this._emptyClick = {t, x: sx, y: sy};
        return false;
    }

    _updateHover(sx, sy) {
        const c = this._c;
        const rec = c.camera.zoom < 0.95 ? c.recordAt(sx, sy) : null;
        if (rec !== this.hovered) {
            this.hovered = rec;
            c.view.setHovered(rec?.win ?? null);
            c.syncView();
        }
        let edges = rec && !c.view.pillHit(rec.win, sx, sy) ? c.resizeEdgesAt(rec, sx, sy) : null;
        if (!rec) {
            const hit = c.view.frameAt(sx, sy);
            edges = hit?.edges ?? null;
            if (hit?.part === 'title') {
                c.setCursor('move');
                return;
            }
        }
        c.setCursor(resizeCursor(edges));
    }

    _onScroll(event, {forceZoom = false} = {}) {
        const c = this._c;
        const [sx, sy] = event.get_coords();
        const mods = event.get_state();
        const zoomMods = Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK |
            Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK;
        const dir = event.get_scroll_direction();

        // Mutter sends every scroll twice: wheels as a real discrete event
        // plus an emulated smooth one, touchpads the other way round.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;

        if (dir !== Clutter.ScrollDirection.SMOOTH) {
            c.stopMotion();
            if (dir === Clutter.ScrollDirection.UP)
                c.zoomTo(c.camera.zoom * WHEEL_ZOOM, sx, sy);
            else if (dir === Clutter.ScrollDirection.DOWN)
                c.zoomTo(c.camera.zoom / WHEEL_ZOOM, sx, sy);
            else
                c.panBy((dir === Clutter.ScrollDirection.RIGHT ? 1 : -1) * 6 * SCROLL_PX, 0);
            this._settleAfterWheel();
            return Clutter.EVENT_STOP;
        }

        const [dx, dy] = event.get_scroll_delta();
        const source = event.get_scroll_source();
        if (forceZoom || (mods & zoomMods) || source === Clutter.ScrollSource.WHEEL) {
            c.stopMotion();
            // Sunlight: exp(−dy × 0.01) per point of scroll.
            if (dy)
                c.zoomTo(c.camera.zoom * Math.exp(-dy * SCROLL_PX * 0.01), sx, sy);
            this._settleAfterWheel();
            return Clutter.EVENT_STOP;
        }

        // Touchpad two-finger scroll pans, with momentum.
        if (!this._scrolling) {
            c.stopMotion();
            this._velocity = [];
        }
        this._scrolling = true;
        const speed = SCROLL_PX * this._settings.get_double('scroll-speed');
        if (dx || dy) {
            this._addVelocitySample(dx * speed, dy * speed);
            c.panBy(dx * speed, dy * speed);
        }
        if (this._scrollTimeout)
            GLib.Source.remove(this._scrollTimeout);
        this._scrollTimeout = 0;
        if (event.get_scroll_finish_flags() !== Clutter.ScrollFinishFlags.NONE) {
            this._scrolling = false;
            this._coastOrSettle();
        } else {
            // Not every device reports the end of a scroll sequence.
            this._scrollTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
                this._scrollTimeout = 0;
                this._scrolling = false;
                this._velocity = [];
                c.settle();
                return GLib.SOURCE_REMOVE;
            });
        }
        return Clutter.EVENT_STOP;
    }

    _settleAfterWheel() {
        this._scrolling = true;
        if (this._wheelTimeout)
            GLib.Source.remove(this._wheelTimeout);
        this._wheelTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
            this._wheelTimeout = 0;
            this._scrolling = false;
            this._c.settle();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onPinch(event) {
        const c = this._c;
        const phase = event.get_gesture_phase();
        const [sx, sy] = event.get_coords();
        // Clutter: 1.0 at BEGIN; fingers apart → scale > 1, together → scale < 1.
        // Content follows the fingers: pinch out (scale↑) zooms in toward 1:1.
        // BEGIN and END report a scale of 0 (UPDATEs run 1.0 → …): never divide by it.
        const scale = Math.max(event.get_gesture_pinch_scale(), 0.01);

        // Like a browser: the zoom is the starting zoom times the finger
        // scale, anchored under the pointer, from the first movement. No
        // dead zone, no panning while pinching, no coasting afterwards.
        // Only BEGIN starts a pinch: re-initialising on a stray UPDATE would
        // rebase startZoom mid-gesture and jump.
        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            c.stopMotion();
            this._pinch = {startZoom: c.camera.zoom};
            return Clutter.EVENT_STOP;
        }
        const p = this._pinch;
        if (!p)
            return Clutter.EVENT_STOP;

        if (phase === Clutter.TouchpadGesturePhase.UPDATE) {
            c.zoomTo(p.startZoom * scale, sx, sy);
        } else if (phase === Clutter.TouchpadGesturePhase.END ||
                   phase === Clutter.TouchpadGesturePhase.CANCEL) {
            this._pinch = null;
            // Pinch out to ~1:1 over a window: enter it.
            const rec = c.recordAt(sx, sy);
            if (phase === Clutter.TouchpadGesturePhase.END &&
                c.camera.zoom >= Geo.HANDOFF_ZOOM && rec)
                c.pinchEnter(rec, sx);
            else
                c.settle();
        }
        return Clutter.EVENT_STOP;
    }

    /** Four fingers spreading (thumb and three fingers): Show Desktop, once per gesture. */
    _onSpread(event) {
        const phase = event.get_gesture_phase();
        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            this._spread = {done: false};
        } else if (phase === Clutter.TouchpadGesturePhase.UPDATE && this._spread) {
            if (!this._spread.done && event.get_gesture_pinch_scale() > SPREAD_SCALE) {
                this._spread.done = true;
                this._c.toggleShowDesktop();
            }
        } else if (phase !== Clutter.TouchpadGesturePhase.UPDATE) {
            this._spread = null;
        }
        return Clutter.EVENT_STOP;
    }

    /**
     * Three fingers up or down, in place of GNOME's overview gesture: from
     * the desktop, up shows the canvas; on the canvas, up shows the app grid
     * (as a second swipe up does in GNOME) and down goes back. Sideways
     * stays GNOME's (workspaces).
     */
    _onThreeFingers(event) {
        const phase = event.get_gesture_phase();
        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            // On the canvas the whole gesture is ours from the first event:
            // leaking the start to GNOME lets its own overview/workspace
            // gesture begin and then be cut off halfway.
            this._three = {dx: 0, dy: 0, done: false, claimed: this._c.mode === 'canvas'};
            return this._three.claimed ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }
        const g = this._three;
        if (!g)
            return Clutter.EVENT_PROPAGATE;
        if (phase === Clutter.TouchpadGesturePhase.UPDATE) {
            const [dx, dy] = event.get_gesture_motion_delta();
            g.dx += dx;
            g.dy += dy;
            if (!g.done && Math.abs(g.dy) > THREE_FINGER_PX && Math.abs(g.dy) > 2 * Math.abs(g.dx)) {
                g.done = true;
                const c = this._c;
                if (c.mode === 'live' && g.dy < 0)
                    c.fitAll();
                else if (c.mode === 'canvas' && g.dy < 0)
                    c.showAppGrid();
                else if (c.mode === 'canvas')
                    c.leaveCanvas();
            }
        } else {
            this._three = null;
        }
        return g.done || g.claimed ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _onSwipe(event) {
        if (this._three || (event.get_touchpad_gesture_finger_count() === 3 &&
            this._settings.get_boolean('replace-overview')))
            return this._onThreeFingers(event);
        const phase = event.get_gesture_phase();
        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            this._c.stopMotion();
            this._velocity = [];
            this._scrolling = true;
        } else if (phase === Clutter.TouchpadGesturePhase.UPDATE) {
            const [dx, dy] = event.get_gesture_motion_delta();
            this._addVelocitySample(-dx, -dy);
            this._c.panBy(-dx, -dy);
        } else {
            this._scrolling = false;
            this._coastOrSettle();
        }
        return Clutter.EVENT_STOP;
    }

    _addVelocitySample(dx, dy) {
        const t = now();
        this._velocity.push({t, dx, dy});
        while (this._velocity.length && t - this._velocity[0].t > VELOCITY_WINDOW_MS)
            this._velocity.shift();
    }

    /** A pan keeps going after the fingers lift, slowing as a scroll does. */
    _coastOrSettle() {
        const s = this._velocity;
        this._velocity = [];
        if (s.length < 2 || now() - s[s.length - 1].t > 50) {
            this._c.settle();
            return;
        }
        const span = Math.max(s[s.length - 1].t - s[0].t, 8);
        let dx = 0, dy = 0;
        for (const v of s.slice(1)) {
            dx += v.dx;
            dy += v.dy;
        }
        this._c.coast(dx / span, dy / span);
    }

    _onKey(event) {
        const c = this._c;
        const sym = event.get_key_symbol();
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;

        // Typing a frame's name: the entry's keys, but Esc keeps the old name.
        if (c.view.editingFrame) {
            if (sym !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            c.view.endFrameEdit(false);
            return Clutter.EVENT_STOP;
        }

        // Typing in the canvas's search: the text is the entry's, the keys
        // that pick from what it found are ours.
        if (c.view.searchFocused) {
            const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
            const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
            switch (sym) {
            case Clutter.KEY_Escape:
                c.cancelFinder();
                break;
            case Clutter.KEY_Return:
            case Clutter.KEY_KP_Enter:
                c.acceptFinder(shift, ctrl);
                break;
            case Clutter.KEY_Up:
            case Clutter.KEY_ISO_Left_Tab:
                c.stepFinder(-1);
                break;
            case Clutter.KEY_Down:
            case Clutter.KEY_Tab:
                c.stepFinder(1);
                break;
            default:
                return Clutter.EVENT_PROPAGATE;
            }
            return Clutter.EVENT_STOP;
        }

        if (ctrl) {
            if (sym === Clutter.KEY_f || sym === Clutter.KEY_F) {
                c.view.focusSearch('', 'windows');
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_z || sym === Clutter.KEY_Z) {
                c.undo();
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_s || sym === Clutter.KEY_S) {
                c.saveLayout();
                return Clutter.EVENT_STOP;
            }
            if (sym >= Clutter.KEY_1 && sym <= Clutter.KEY_9) {
                c.restoreLayout(sym - Clutter.KEY_1);
                return Clutter.EVENT_STOP;
            }
        }

        switch (sym) {
        case Clutter.KEY_Escape:
            if (c.menuOpen)
                c.closeMenu();
            else if (c.appGridOpen)
                c.showAppGrid(); // toggle closed
            else
                c.leaveCanvas();
            break;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter: {
            // Over a window, bring it to the middle and enter it; else the top one.
            const [x, y] = global.get_pointer();
            const rec = this.hovered ?? c.recordAt(x, y) ?? c.topRecord();
            if (rec)
                c.enterCentered(rec);
            else
                c.leaveCanvas();
            break;
        }
        case Clutter.KEY_plus:
        case Clutter.KEY_equal:
        case Clutter.KEY_KP_Add:
            c.zoomIn();
            break;
        case Clutter.KEY_minus:
        case Clutter.KEY_KP_Subtract:
            c.zoomOut();
            break;
        case Clutter.KEY_0:
        case Clutter.KEY_KP_0:
            c.zoomToActual();
            break;
        case Clutter.KEY_Left:
        case Clutter.KEY_Right:
        case Clutter.KEY_Up:
        case Clutter.KEY_Down: {
            const dx = sym === Clutter.KEY_Left ? -1 : sym === Clutter.KEY_Right ? 1 : 0;
            const dy = sym === Clutter.KEY_Up ? -1 : sym === Clutter.KEY_Down ? 1 : 0;
            c.panStep(dx, dy);
            break;
        }
        default: {
            // Typing a letter or digit on the canvas starts a search with it.
            const ch = event.get_key_unicode();
            const mods = Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK |
                Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK;
            if ((event.get_state() & mods) || !/^[\p{L}\p{N}]$/u.test(ch))
                return Clutter.EVENT_PROPAGATE;
            c.view.focusSearch(ch);
        }
        }
        return Clutter.EVENT_STOP;
    }
}
