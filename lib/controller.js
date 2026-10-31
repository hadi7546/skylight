// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

// Skylight's brain.
//
// Every managed window has a fixed-size rect on an infinite canvas, and each
// workspace has a camera looking at it. There are three modes:
//
//   live    Camera at 1:1. Real windows sit at canvas − camera and are fully
//           interactive. Windows the camera cannot see are "parked"
//           (minimised without animation) because mutter will not let a
//           window go fully off screen.
//   canvas  The overlay (CanvasView) is up and holds a modal grab. Windows are
//           drawn as clones scaled by the camera; you can pan, zoom, drag,
//           resize and close them. Ends by entering a window at 1:1.
//   glide   A short, non-interactive camera flight at 1:1 (revealing a
//           window, a minimap click). Drawn with the overlay, then committed
//           to the real windows.
//
// Behaviour follows Sunlight (github.com/spacefarm-digital/sunlight), see
// docs/how-it-works.md there.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Geo from './geometry.js';
import {rankByNames} from './appMatch.js';
import * as Strip from './strip.js';
import * as WindowEffects from './windowEffects.js';
import {Backdrop} from './backdrop.js';
import {CanvasInput} from './input.js';
import {CanvasMenu} from './canvasMenu.js';
import {CanvasStore} from './store.js';
import {CanvasView} from './canvasView.js';
import {Frames} from './frames.js';
import {Launcher} from './launcher.js';
import {Minimap} from './minimap.js';
import {setCursor as setActorCursor} from './compat.js';

const SETTLE_ZOOM = 0.97; // a gesture ending above this goes back to 1:1
const SNAP_MS = 160; // settling onto the grid
const ENTER_MS = 420;
const GLIDE_MS = 280;
const ZOOM_STEP = 1.6;
const PAN_COAST = {threshold: 0.12, tau: 420, stop: 0.012}; // px/ms, ms
const ZOOM_COAST = {threshold: 0.0008, tau: 120, stop: 0.00005}; // log-zoom/ms
const TILE_SETTLE_MS = 1500;
const UNDO_LIMIT = 30;
const LAUNCH_WAIT_MS = 8000; // Open Here…: how long a launch has to show its window
const NEW_WINDOW_WAIT_MS = 2000; // a running app asked for a new window, before its last one comes over instead
const SIBLING_WAIT_MS = 1000; // after the first, the app's other new windows go beside it
const WORKSPACE_GAP = 240; // between the workspaces gathered onto one canvas
// Settings that are state, not preferences: changing them changes nothing on screen.
const STATE_KEYS = ['canvas-state', 'layouts', 'launcher-recents', 'one-workspace', 'saved-workspaces', 'frames', 'strip-mode'];
const FRAME_PAD = 48; // a new frame's margin around the windows it's made around

const PRESET_KEYS = {
    'tile-left-half': 'left-half',
    'tile-right-half': 'right-half',
    'tile-top-half': 'top-half',
    'tile-bottom-half': 'bottom-half',
    'tile-top-left': 'top-left',
    'tile-top-right': 'top-right',
    'tile-bottom-left': 'bottom-left',
    'tile-bottom-right': 'bottom-right',
    'tile-left-third': 'left-third',
    'tile-center-third': 'center-third',
    'tile-right-third': 'right-third',
    'tile-left-two-thirds': 'left-two-thirds',
    'tile-right-two-thirds': 'right-two-thirds',
    'tile-full': 'full',
    'tile-center': 'center',
};

const KEYBINDINGS = {
    'toggle-canvas': c => c.toggleCanvas(),
    'zoom-in': c => c.zoomIn(),
    'zoom-out': c => c.zoomOut(),
    'zoom-reset': c => c.zoomToActual(),
    'tidy-windows': c => c.tidy(),
    'open-here': c => c.openHere(),
    'toggle-strip': c => c.toggleStrip(),
    'strip-left': c => c.stripStep('left'),
    'strip-right': c => c.stripStep('right'),
    'strip-up': c => c.stripStep('up'),
    'strip-down': c => c.stripStep('down'),
};
for (const [key, preset] of Object.entries(PRESET_KEYS))
    KEYBINDINGS[key] = c => c.moveResize(preset);

export const PRESET_TITLES = [
    ['left-half', 'Left Half'], ['right-half', 'Right Half'],
    ['top-half', 'Top Half'], ['bottom-half', 'Bottom Half'],
    ['top-left', 'Top Left Quarter'], ['top-right', 'Top Right Quarter'],
    ['bottom-left', 'Bottom Left Quarter'], ['bottom-right', 'Bottom Right Quarter'],
    ['left-third', 'Left Third'], ['center-third', 'Centre Third'], ['right-third', 'Right Third'],
    ['left-two-thirds', 'Left Two-Thirds'], ['right-two-thirds', 'Right Two-Thirds'],
    ['full', 'Full'], ['center', 'Centre'],
];

const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const now = () => GLib.get_monotonic_time() / 1000;

/** Maximised or tiled: mutter won't move it. */
function isMaximized(win) {
    return win.get_maximize_flags() !== 0;
}

function unmaximize(win) {
    if (isMaximized(win))
        win.unmaximize();
}

function appOf(win) {
    return Shell.WindowTracker.get_default().get_window_app(win);
}

function appId(win) {
    const app = appOf(win);
    return app && !app.is_window_backed() ? app.get_id() : win.get_wm_class() ?? '';
}

class WindowRecord {
    constructor(win, x, y) {
        const f = win.get_frame_rect();
        this.win = win;
        this.x = x;
        this.y = y;
        this.w = f.width;
        this.h = f.height;
        this.parked = false; // minimised by us because it is off camera
        this.tile = null; // {preset, area} after Move & Resize
        this.anchorTo = null; // {rect, anchor, until}: keep the app's size against these edges
    }

    get rect() {
        return {x: this.x, y: this.y, w: this.w, h: this.h};
    }

    /** Minimised by the user: it leaves the canvas but keeps its spot. */
    get away() {
        return this.win.minimized && !this.parked;
    }
}

export class Controller {
    constructor(extension) {
        this._extension = extension;
    }

    // -----------------------------------------------------------------------
    // Lifecycle

    enable() {
        this._settings = this._extension.getSettings();
        this._records = new Map();
        this._cams = new Map();
        this._mode = 'live';
        this._anim = null; // camera: ease, spring, kinetic or zoom coast
        this._layoutAnim = null; // window positions
        this._applying = 0;
        this._grab = null;
        this._cursor = 'default';
        this._entering = null;
        this._cameFrom = null;
        this._userGrabOp = false;
        this._undo = [];
        this._timeouts = new Set();
        this._store = new CanvasStore(this._settings);
        this._input = new CanvasInput(this, this._settings);
        this._launcher = new Launcher(this._settings);
        this._frames = new Frames(this._settings);
        this._strip = null; // {origin, saved, cols}: strip mode, cols of records left to right
        this._found = null; // {matches, selected}: the canvas's search
        this._opening = null; // Open Here…: {app (null: any, from GNOME search), spot, enter, known, deadline, placedAt}
        this._dblClickMs = new Gio.Settings({schema_id: 'org.gnome.desktop.peripherals.mouse'})
            .get_int('double-click');

        this._view = new CanvasView(this);
        this._menu = new CanvasMenu(this._view.menuLayer);
        this._view.actor.connectObject(
            'captured-event', (a, e) => this._input.onCanvasEvent(e),
            'destroy', () => this._onViewDestroyed(),
            this);
        this._timeline = new Clutter.Timeline({
            actor: this._view.actor,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connect('new-frame', () => this._tick());

        // Under the windows and over the wallpaper: the live backdrop (grid
        // or colour styles) and the minimap, so at 1:1 both show wherever no
        // window covers them, as the canvas does behind an entered window.
        this._liveLayer = new Clutter.Actor();
        Main.layoutManager._backgroundGroup.add_child(this._liveLayer);
        this._liveBackdrop = new Backdrop(false);
        this._liveLayer.add_child(this._liveBackdrop.actor);
        this._liveMinimap = new Minimap(this);
        this._liveLayer.add_child(this._liveMinimap);
        this._liveMinimap.connectObject('notify::size', () => this._positionLiveMinimap(), this);

        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (this._isManageable(win))
                this._manage(win);
        }
        this._loadMemory();

        global.display.connectObject(
            'grab-op-begin', () => {
                this._userGrabOp = true;
            },
            'grab-op-end', (d, win) => this._onGrabOpEnd(win),
            'workareas-changed', () => this._onLayoutChanged(true),
            'notify::focus-window', () => this._onFocusChanged(),
            'restacked', () => {
                if (this._mode !== 'live')
                    this._view.syncStacking();
            },
            this);
        global.window_manager.connectObject('map', (wm, actor) => this._onMap(actor), this);
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._onWorkspaceSwitched(),
            'workspace-removed', () => this._pruneCameras(),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._onLayoutChanged(), this);
        Main.overview.connectObject(
            'showing', () => {
                this._abortCanvas();
                // Still fading out, or gliding: the overview needs its dash now.
                this._view.returnDash();
                this._updateLiveDecor();
            },
            'hidden', () => {
                if (this._opening?.deadline === Infinity)
                    this._opening.deadline = now() + LAUNCH_WAIT_MS;
                this._updateLiveDecor();
            },
            this);
        Main.sessionMode.connectObject('updated', () => this._onSessionModeChanged(), this);
        global.stage.connectObject('captured-event', (a, e) => this._input.onStageEvent(e), this);
        Shell.WindowTracker.get_default().connectObject('tracked-windows-changed', () => {
            for (const win of this._records.keys())
                this._view.updateTitle(win);
        }, this);

        this._settings.connectObject(
            'changed', (s, key) => {
                if (!STATE_KEYS.includes(key))
                    this._applySettings();
            },
            'changed::strip-mode', () => this._syncStrip(),
            this);

        for (const [name, handler] of Object.entries(KEYBINDINGS)) {
            Main.wm.addKeybinding(name, this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.POPUP | Shell.ActionMode.OVERVIEW,
                () => handler(this));
        }

        this._applySettings();
        this._onLayoutChanged();
        this._syncStrip();
    }

    disable() {
        this._saveMemory();
        this._abortCanvas();
        this._launcher.destroy();
        this._launcher = null;
        this._opening = null;
        this._menu.destroy();
        this._menu = null;
        this._input.destroy();
        this._input = null;
        for (const name of Object.keys(KEYBINDINGS))
            Main.wm.removeKeybinding(name);
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();

        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        global.stage.disconnectObject(this);
        Shell.WindowTracker.get_default().disconnectObject(this);
        this._settings.disconnectObject(this);

        // Give back every window we hid.
        for (const rec of this._records.values()) {
            rec.win.disconnectObject(rec);
            if (rec.parked)
                this._unpark(rec);
        }
        this._records.clear();
        this._cams.clear();

        this._view.actor.disconnectObject(this);
        // A fade still running would finish on the destroyed overlay.
        this._view.actor.remove_all_transitions();
        this._timeline.stop();
        this._timeline = null;
        this._view.destroy();
        this._view = null;
        this._liveMinimap.disconnectObject(this);
        this._liveMinimap = null;
        this._liveBackdrop.destroy();
        this._liveBackdrop = null;
        this._liveLayer.destroy();
        this._liveLayer = null;
        this._store.destroy();
        this._store = null;
        this._settings = null;
    }

    /** GNOME Shell destroys the overlay (with uiGroup) at shutdown, before any disable(). */
    _onViewDestroyed() {
        this._timeline.stop();
        this._anim = null;
        this._layoutAnim = null;
        this._input.reset();
        this._grab = null;
        this._mode = 'live';
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    _cancelLater(id) {
        if (id && this._timeouts.delete(id))
            GLib.source_remove(id);
    }

    _applySettings() {
        const s = this._settings;
        const config = {
            style: s.get_string('background'),
            color: s.get_string('canvas-color'),
            dotColor: s.get_string('dot-color'),
            showDots: s.get_boolean('show-grid'),
            blurOnZoom: s.get_boolean('blur-on-zoom'),
        };
        this._view.backdrop.configure(config);
        this._liveBackdrop.configure(config);
        this._view.setMinimapVisible(s.get_boolean('show-minimap'));
        this._gridSize = s.get_int('grid-size');
        this._tileGap = s.get_int('tile-gap');
        this.syncView();
        this._updateLiveDecor();
    }

    _onSessionModeChanged() {
        if (Main.sessionMode.isLocked)
            this._abortCanvas();
        this._updateLiveDecor();
    }

    // -----------------------------------------------------------------------
    // Geometry helpers

    get _monitor() {
        return Main.layoutManager.primaryMonitor;
    }

    /** The screen rect that shows the canvas at 1:1. */
    viewport() {
        const wa = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        return {x: wa.x, y: wa.y, w: wa.width, h: wa.height};
    }

    /** The work area at the identity camera: page 0 of the canvas. */
    _homeScreen() {
        return this.viewport();
    }

    get _cam() {
        const ws = global.workspace_manager.get_active_workspace();
        let cam = this._cams.get(ws);
        if (!cam) {
            // World coordinates are screen coordinates at the identity camera.
            const vp = this.viewport();
            cam = {cx: vp.x + vp.w / 2, cy: vp.y + vp.h / 2, zoom: 1};
            this._cams.set(ws, cam);
        }
        return cam;
    }

    set _cam(cam) {
        this._cams.set(global.workspace_manager.get_active_workspace(), cam);
    }

    _pruneCameras() {
        const alive = new Set();
        for (let i = 0; i < global.workspace_manager.n_workspaces; i++)
            alive.add(global.workspace_manager.get_workspace_by_index(i));
        for (const ws of this._cams.keys()) {
            if (!alive.has(ws))
                this._cams.delete(ws);
        }
    }

    /** Every window on the active workspace, minimised ones included. */
    _activeRecords() {
        const ws = global.workspace_manager.get_active_workspace();
        return [...this._records.values()].filter(r => r.win.get_workspace() === ws);
    }

    /** The windows drawn on the canvas: not the minimised ones. */
    visibleRecords() {
        return this._activeRecords().filter(r => !r.away);
    }

    recordAt(sx, sy) {
        const [x, y] = Geo.screenToCanvas(this._cam, this.viewport(), sx, sy);
        const recs = this.visibleRecords();
        const wins = global.display.sort_windows_by_stacking(recs.map(r => r.win)).reverse();
        for (const win of wins) {
            const r = this._records.get(win);
            if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)
                return r;
        }
        return null;
    }

    _screenRect(rec) {
        const cam = this._cam;
        const [x, y] = Geo.canvasToScreen(cam, this.viewport(), rec.x, rec.y);
        return {x, y, w: rec.w * cam.zoom, h: rec.h * cam.zoom};
    }

    resizeEdgesAt(rec, sx, sy) {
        if (this._cam.zoom > 0.98)
            return null;
        return Geo.resizeEdges(sx, sy, this._screenRect(rec));
    }

    _focusedRecord() {
        const rec = this._records.get(global.display.focus_window);
        return rec && this._activeRecords().includes(rec) ? rec : null;
    }

    setCursor(kind) {
        if (kind === this._cursor)
            return;
        this._cursor = kind;
        setActorCursor(this._view.actor, kind);
    }

    // -----------------------------------------------------------------------
    // Window management

    _isManageable(win) {
        if (!win || win.is_override_redirect() || win.skip_taskbar)
            return false;
        if (win.is_on_all_workspaces() || !win.get_workspace())
            return false;
        if (win.is_attached_dialog())
            return false;
        const type = win.get_window_type();
        if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG &&
            type !== Meta.WindowType.MODAL_DIALOG && type !== Meta.WindowType.UTILITY)
            return false;
        return win.get_monitor() === Main.layoutManager.primaryIndex;
    }

    _manage(win) {
        const f = win.get_frame_rect();
        const cam = this._cam;
        const vp = this.viewport();
        // At 1:1, canvas = screen − viewport centre + camera centre.
        const rec = new WindowRecord(win,
            f.x - (vp.x + vp.w / 2) + cam.cx,
            f.y - (vp.y + vp.h / 2) + cam.cy);
        this._records.set(win, rec);

        win.connectObject(
            'position-changed', () => this._onWindowGeometry(rec),
            'size-changed', () => this._onWindowGeometry(rec),
            'notify::minimized', () => this._onMinimizedChanged(rec),
            'workspace-changed', () => this._onWindowWorkspaceChanged(),
            'notify::title', () => this._view.updateTitle(win),
            'unmanaged', () => this._unmanage(rec),
            rec);
        return rec;
    }

    _unmanage(rec) {
        rec.win.disconnectObject(rec);
        this._records.delete(rec.win);
        if (this._strip)
            this._layoutStrip(this._strip.cols);
        this._input.forget(rec);
        if (this._entering?.rec === rec)
            this._entering = null;
        if (this._mode !== 'live') {
            this._view.syncRecords(this.visibleRecords());
            this.syncView();
        }
        this._updateLiveDecor();
        this.queueSave();
    }

    _onMap(actor) {
        const win = actor.meta_window;
        if (this._records.has(win) || !this._isManageable(win))
            return;
        const rec = this._manage(win);
        const others = this._activeRecords().filter(r => r !== rec && !r.away);
        const placedByShell = {x: rec.x, y: rec.y};
        // The new window takes focus; that's no reason to move the camera.
        this._ownFocusUntil = now() + 1000;

        // Open Here… picked this app: its window goes to the spot it was
        // opened at. Otherwise a remembered spot, or the middle of the view.
        const here = this._openingSpot(rec);
        const restored = !here && (this._placeFromMemory(rec) || this._placeFromLayout(rec));
        if (here || (!restored && !win.get_transient_for() && this._settings.get_boolean('place-in-free-space'))) {
            // There if that's clear, else the nearest free spot beside the
            // windows in the way, in view if there's room.
            const spot = this._freeSpot(rec, others, here);
            rec.x = spot.x;
            rec.y = spot.y;
        }

        if (win.get_workspace() !== global.workspace_manager.get_active_workspace())
            return;
        if (this._strip && !win.get_transient_for()) {
            // The newest: the top of its app's column, the column first.
            if (this._mode !== 'live') {
                this._view.syncRecords(this.visibleRecords());
                this._playArrival(rec, here);
            }
            this._stripInsert(rec);
            this.queueSave();
            return;
        }
        if (this._mode === 'live') {
            // A launch is absorbed where you're looking: the camera never moves
            // for it. With no free room on screen it stays where GNOME put it.
            // Only a window going back to a remembered spot gets flown to.
            // With no free room fully on screen, Open Here… puts it on the
            // spot over what's there, and a launch stays where GNOME put it.
            const vp = this.viewport();
            if (!restored && Geo.visibleFraction(this._cam, vp, rec.rect) < 0.999) {
                const view = Geo.visibleCanvasRect(this._cam, vp);
                const at = here
                    ? {x: Math.round(here.x - rec.w / 2), y: Math.round(here.y - rec.h / 2)}
                    : placedByShell;
                rec.x = Geo.clamp(at.x, view.x, Math.max(view.x, view.x + view.w - rec.w));
                rec.y = Geo.clamp(at.y, view.y, Math.max(view.y, view.y + view.h - rec.h));
            }
            const onScreen = Geo.placeableOnScreen(Geo.liveRect(this._cam, vp, rec), vp);
            if (onScreen || !restored)
                this._commit();
            else
                this._reveal(rec);
        } else {
            // On the canvas, the camera stays where it is: the window arrives
            // with the chosen open effect (and a ring for Bloom / default).
            this._view.syncRecords(this.visibleRecords());
            this.syncView();
            this._playArrival(rec, here);
        }
        this.queueSave();
    }

    /** Open effect for a window that just landed on the canvas. */
    _playArrival(rec, sourceSpot) {
        const screen = this._screenRect(rec);
        const style = this._windowEffectStyle({source: sourceSpot});
        let geometry = {};
        if (sourceSpot) {
            const [sx, sy] = Geo.canvasToScreen(this._cam, this.viewport(), sourceSpot.x, sourceSpot.y);
            geometry = WindowEffects.geometryFrom(screen, {source: {x: sx, y: sy}});
        }
        this._view.playArrival(rec.win, screen, style, geometry);
        this._view.setMark(null);
    }

    /**
     * Which open/close curve Settings asks for, with Reduce Animation as dissolve.
     * @param {{source?: {x,y}|null, neighbour?: object|null, attached?: boolean}} context
     */
    _windowEffectStyle(context = {}) {
        const reduce = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'})
            .get_boolean('enable-animations') === false;
        return WindowEffects.styleFor(this._settings.get_string('window-effect'), context, reduce);
    }

    /** Where `rec` can go near `target` (canvas point; null for the middle of the view). */
    _freeSpot(rec, others, target = null) {
        const zoom = this._mode === 'canvas' ? this._cam.zoom : 1;
        const view = Geo.visibleCanvasRect({...this._cam, zoom}, this.viewport());
        const gap = Geo.tidySpacing('normal', this._tileGap);
        return Geo.newWindowSpot(rec.w, rec.h, others.map(o => o.rect), view, gap, target);
    }

    _onWindowGeometry(rec) {
        const f = rec.win.get_frame_rect();
        if (this._strip && (f.width !== rec.w || f.height !== rec.h))
            this._queueStripReflow();
        rec.w = f.width;
        rec.h = f.height;

        // After a resize we asked for, the app picks its own size: keep it
        // against the edges that were meant to stay put.
        const a = rec.anchorTo ?? this._input.resizeAnchor(rec);
        if (a && (!a.until || now() < a.until)) {
            const placed = Geo.placeAnchored(rec.w, rec.h, a.rect, a.anchor);
            rec.x = Math.round(placed.x);
            rec.y = Math.round(placed.y);
            if (this._mode === 'live' && !this._applying)
                this._commit();
            else
                this.syncView();
            return;
        }

        if (this._applying || this._mode !== 'live' || rec.parked || rec.win.minimized ||
            rec.win.get_workspace() !== global.workspace_manager.get_active_workspace()) {
            if (this._mode !== 'live')
                this.syncView();
            return;
        }
        // The user or the app moved it: the canvas follows the real window.
        const cam = this._cam;
        const vp = this.viewport();
        rec.x = f.x - (vp.x + vp.w / 2) + cam.cx;
        rec.y = f.y - (vp.y + vp.h / 2) + cam.cy;
        this._updateLiveDecor();
        this.queueSave();
    }

    _onMinimizedChanged(rec) {
        if (this._applying)
            return;
        if (rec.win.minimized) {
            // Minimised by the user: it leaves the canvas but keeps its spot,
            // dashed in the minimap.
            rec.parked = false;
        } else {
            // Something (Alt+Tab, the dock, the minimap) brought it back.
            // Make sure the camera can actually see it.
            rec.parked = false;
            if (this._mode === 'live')
                this._reveal(rec);
        }
        if (this._mode !== 'live') {
            this._view.syncRecords(this.visibleRecords());
            this.syncView();
        }
        this._updateLiveDecor();
    }

    _onWindowWorkspaceChanged() {
        if (this._mode === 'live')
            this._later(0, () => this._commit());
    }

    _onGrabOpEnd(win) {
        this._userGrabOp = false;
        // A window dragged onto another monitor leaves the canvas, and one
        // dragged onto the primary monitor joins it.
        const rec = this._records.get(win);
        const manageable = win && this._isManageable(win);
        if (rec && !manageable)
            this._unmanage(rec);
        else if (!rec && manageable)
            this._manage(win);
        else if (rec && this._strip)
            this.stripDropped(rec);
        this._updateLiveDecor();
    }

    _onFocusChanged() {
        if (!this._settings.get_boolean('follow-focus') || this._mode !== 'live' ||
            now() < (this._ownFocusUntil ?? 0))
            return;
        this._cancelLater(this._focusTimeout);
        // Picked in the overview: the camera moves now, while the overview
        // still covers the screen, so it closes straight onto the window.
        if (Main.overview.visible) {
            const rec = this._focusedRecord();
            if (rec)
                this._reveal(rec);
            return;
        }
        // Wait for the click (if any) to finish so we never move a window out
        // from under a pointer that is about to drag it.
        this._focusTimeout = this._later(220, () => {
            this._focusTimeout = 0;
            const rec = this._focusedRecord();
            const [, , mods] = global.get_pointer();
            if (!rec || this._userGrabOp || this._mode !== 'live' ||
                (mods & Clutter.ModifierType.BUTTON1_MASK))
                return;
            // Mostly on screen already: switching to it moves nothing.
            if (Geo.wellInView(this._cam, this.viewport(), rec.rect))
                return;
            this._reveal(rec);
        });
    }

    _onWorkspaceSwitched() {
        this._abortCanvas();
        if (this._strip)
            this._layoutStrip();
        this._commit();
    }

    /** @param {boolean} workareas - only the work areas changed, maybe not on our monitor */
    _onLayoutChanged(workareas = false) {
        const mon = this._monitor;
        const index = Main.layoutManager.primaryIndex;
        const key = mon ? JSON.stringify([index, mon.x, mon.y, mon.width, mon.height, this.viewport()]) : '';
        // Workspaces coming and going report new work areas too: nothing to redo.
        if (workareas && key === this._layoutKey)
            return;
        this._layoutKey = key;
        this._abortCanvas();
        if (!mon)
            return;
        this._view.setGeometry(index, mon, this.viewport());
        this._liveBackdrop.setGeometry(index, mon);
        this._liveBackdrop.actor.set_position(mon.x, mon.y);
        Main.layoutManager._backgroundGroup.set_child_above_sibling(this._liveLayer, null);
        for (const rec of [...this._records.values()]) {
            if (!this._isManageable(rec.win) && !rec.parked)
                this._unmanage(rec);
        }
        this._commit();
    }

    // -----------------------------------------------------------------------
    // Parking and committing the camera to real windows

    _park(rec) {
        // Mutter gives the focus to another window: that's no reason to move.
        if (rec.win.has_focus())
            this._ownFocusUntil = now() + 1000;
        const actor = rec.win.get_compositor_private();
        if (actor)
            Main.wm.skipNextEffect(actor);
        rec.parked = true;
        this._applying++;
        try {
            rec.win.minimize();
        } finally {
            this._applying--;
        }
    }

    _unpark(rec) {
        const actor = rec.win.get_compositor_private();
        if (actor)
            Main.wm.skipNextEffect(actor);
        rec.parked = false;
        this._applying++;
        try {
            rec.win.unminimize();
        } finally {
            this._applying--;
        }
    }

    /** Move every real window to where the (1:1) camera says it should be. */
    _commit() {
        const cam = this._cam;
        if (cam.zoom !== 1)
            this._cam = {...cam, zoom: 1};
        const vp = this.viewport();
        this._applying++;
        try {
            for (const rec of this._activeRecords()) {
                const win = rec.win;
                if (win.fullscreen || rec.away)
                    continue;
                const s = Geo.liveRect(this._cam, vp, rec);
                let f = win.get_frame_rect();
                if (isMaximized(win) && (Math.abs(f.x - s.x) > 1 || Math.abs(f.y - s.y) > 1)) {
                    this._releaseMaximized(win, s);
                    f = win.get_frame_rect();
                }
                let visible;
                if (isMaximized(win)) {
                    visible = true;
                } else {
                    visible = Geo.placeableOnScreen(s, vp);
                    // Server-side decorated X11 windows must keep their title
                    // bar inside the work area.
                    if (win.decorated && win.get_client_type() === Meta.WindowClientType.X11 && s.y < vp.y)
                        visible = false;
                }
                if (visible) {
                    // user_op=true: otherwise mutter keeps windows that were
                    // once fully on screen fully on screen.
                    if (!isMaximized(win) && (f.x !== s.x || f.y !== s.y)) {
                        win.move_frame(true, s.x, s.y);
                        // Mutter may hold it back (a title bar under the top
                        // bar): the canvas takes where it really went, or
                        // the canvas would draw it somewhere it isn't.
                        const g = win.get_frame_rect();
                        rec.x += g.x - s.x;
                        rec.y += g.y - s.y;
                    }
                    if (rec.parked)
                        this._unpark(rec);
                } else if (!rec.parked) {
                    this._park(rec);
                }
            }
        } finally {
            this._applying--;
        }
        this._updateLiveDecor();
        this.queueSave();
    }

    /**
     * A maximised (or tiled) window the canvas has somewhere else: moved or
     * tidied on the canvas, or the camera went on. Mutter won't move it
     * maximised, so it becomes a plain window of the same size, there:
     * hiding it instead would make going into it jump.
     */
    _releaseMaximized(win, s) {
        const f = win.get_frame_rect();
        const actor = win.get_compositor_private();
        if (actor)
            Main.wm.skipNextEffect(actor);
        unmaximize(win);
        win.move_resize_frame(true, s.x, s.y, f.width, f.height);
    }

    /** Ask the real window for a new size (and, at 1:1, position). */
    resizeReal(rec, w, h) {
        const win = rec.win;
        w = Math.round(w);
        h = Math.round(h);
        this._applying++;
        try {
            unmaximize(win);
            const f = win.get_frame_rect();
            let x = f.x, y = f.y;
            if (this._mode === 'live') {
                const s = Geo.liveRect(this._cam, this.viewport(), rec);
                x = s.x;
                y = s.y;
            }
            win.move_resize_frame(true, x, y, w, h);
        } finally {
            this._applying--;
        }
    }

    _updateLiveDecor() {
        const s = this._settings;
        const locked = Main.sessionMode.isLocked;
        const mon = this._monitor;
        this._liveBackdrop.actor.visible = this._liveBackdrop.active && !locked;
        if (mon && this._liveBackdrop.actor.visible) {
            const [ox, oy] = Geo.screenToCanvas(this._cam, this.viewport(), mon.x, mon.y);
            this._liveBackdrop.update(ox, oy, 1);
        }
        this._liveMinimap.visible = s.get_boolean('show-minimap') &&
            s.get_boolean('minimap-in-live-mode') && this._mode === 'live' &&
            !locked && !Main.overview.visible;
        if (this._liveMinimap.visible) {
            this._liveMinimap.refresh();
            this._positionLiveMinimap();
        }
    }

    _positionLiveMinimap() {
        const vp = this.viewport();
        const [w, h] = this._liveMinimap.get_size();
        const margin = 12;
        this._liveMinimap.set_position(vp.x + vp.w - w - margin, vp.y + vp.h - h - margin);
    }

    // -----------------------------------------------------------------------
    // Remembering the canvas, and named layouts (stored by store.js)

    _windowInfo(rec) {
        return {id: rec, seq: rec.win.get_stable_sequence(), app: appId(rec.win), title: rec.win.get_title() ?? ''};
    }

    _canvasState() {
        const windows = [...this._records.values()].map(r => ({
            seq: r.win.get_stable_sequence(),
            app: appId(r.win),
            title: r.win.get_title() ?? '',
            x: Math.round(r.x),
            y: Math.round(r.y),
        }));
        const cams = {};
        for (const [ws, cam] of this._cams) {
            const i = ws.index();
            if (i >= 0)
                cams[i] = {cx: Math.round(cam.cx), cy: Math.round(cam.cy), zoom: 1};
        }
        return {windows, cams};
    }

    queueSave() {
        this._store.queueSave(() => this._canvasState());
    }

    _saveMemory() {
        this._store.save(this._canvasState());
    }

    _loadMemory() {
        const {cams, matches} = this._store.load([...this._records.values()].map(r => this._windowInfo(r)));
        for (const [i, cam] of Object.entries(cams)) {
            const ws = global.workspace_manager.get_workspace_by_index(Number(i));
            if (ws && Number.isFinite(cam.cx) && Number.isFinite(cam.cy))
                this._cams.set(ws, {cx: cam.cx, cy: cam.cy, zoom: 1});
        }
        for (const [rec, e] of matches) {
            rec.x = e.x;
            rec.y = e.y;
        }
    }

    _placeFromMemory(rec) {
        const e = this._store.takeRemembered(this._windowInfo(rec));
        if (!e)
            return false;
        rec.x = e.x;
        rec.y = e.y;
        return true;
    }

    _placeFromLayout(rec) {
        const e = this._store.takeExpected(this._windowInfo(rec));
        if (!e)
            return false;
        rec.x = e.x;
        rec.y = e.y;
        if (e.w !== rec.w || e.h !== rec.h)
            this.resizeReal(rec, e.w, e.h);
        return true;
    }

    layouts() {
        return this._store.layouts();
    }

    /** Save the canvas as a layout: where every window sits, its size, and the camera. */
    saveLayout() {
        const windows = this._activeRecords().map(r => ({
            app: appId(r.win),
            title: r.win.get_title() ?? '',
            x: Math.round(r.x), y: Math.round(r.y), w: r.w, h: r.h,
        }));
        const layout = this._store.addLayout({...this._cam}, windows);
        this._toast(`Saved ${layout.name}`);
    }

    /**
     * Restore a layout: every window in it glides to its spot at its saved
     * size, and the camera with them. Apps that aren't open are started and
     * their windows take their spots as they appear.
     */
    restoreLayout(index) {
        const layout = this.layouts()[index];
        if (!layout || Main.overview.visible)
            return;
        const recs = this._activeRecords();
        const matches = Geo.matchWindows(layout.windows, recs.map(r => this._windowInfo(r)));
        this.pushUndo(this.snapshot(recs));

        const to = new Map();
        for (const [rec, e] of matches) {
            to.set(rec, {x: e.x, y: e.y});
            if (e.w !== rec.w || e.h !== rec.h)
                this.resizeReal(rec, e.w, e.h);
        }
        const used = new Set(matches.values());
        const missing = layout.windows.filter(e => !used.has(e));
        const appSystem = Shell.AppSystem.get_default();
        for (const e of missing)
            appSystem.lookup_app(e.app)?.open_new_window(-1);
        this._store.expect(missing);

        this.enterCanvas();
        this.animateLayout(to, 480);
        const cam = layout.cam;
        this.flyTo(cam, {
            onDone: () => {
                if (cam.zoom >= 1)
                    this._exitToLive();
            },
        });
        this._toast(layout.name);
    }

    _toast(text) {
        if (this._mode === 'canvas')
            this._view.toast(text);
    }

    // -----------------------------------------------------------------------
    // Undo (Ctrl+Z on the canvas): window moves, resizes, tidy, layouts.

    snapshot(recs) {
        return recs.map(r => ({rec: r, x: r.x, y: r.y, w: r.w, h: r.h}));
    }

    pushUndo(snapshot) {
        this._undo.push(snapshot);
        if (this._undo.length > UNDO_LIMIT)
            this._undo.shift();
    }

    undo() {
        const snapshot = this._undo.pop();
        if (!snapshot)
            return;
        const to = new Map();
        for (const s of snapshot) {
            // A frame moved with its windows goes back at once.
            if (s.frame) {
                s.frame.x = s.x;
                s.frame.y = s.y;
                this._frames.save();
                continue;
            }
            if (!this._records.has(s.rec.win))
                continue;
            s.rec.anchorTo = null;
            if (s.w !== s.rec.w || s.h !== s.rec.h)
                this.resizeReal(s.rec, s.w, s.h);
            to.set(s.rec, {x: s.x, y: s.y});
        }
        if (this._mode === 'live') {
            for (const [rec, p] of to) {
                rec.x = p.x;
                rec.y = p.y;
            }
            this._commit();
        } else {
            this.animateLayout(to, 300);
        }
    }

    // -----------------------------------------------------------------------
    // Modes

    _showOverlay() {
        const actor = this._view.actor;
        actor.remove_all_transitions();
        actor.opacity = 255;
        this._view.setGeometry(Main.layoutManager.primaryIndex, this._monitor, this.viewport());
        this._view.syncRecords(this.visibleRecords());
        this._view.setFrames(this._frames.active());
        this._view.setOverviewChrome(this._settings.get_boolean('replace-overview'));
        this.syncView();
        actor.show();
        this._liveMinimap.hide();
        // Pop the canvas minimap in (Sunlight 0.1.5: only while zoomed out).
        this._view.setMinimapVisible(this._settings.get_boolean('show-minimap'));
    }

    enterCanvas() {
        if (this._mode === 'canvas')
            return;
        if (this._mode === 'live') {
            // Remember where we came from: the same key takes us back there.
            this._cameFrom = {cam: {...this._cam}, win: this._focusedRecord()?.win ?? null};
            this._showOverlay();
        }
        this._mode = 'canvas';
        // As GNOME's overview does: the stage grabbed, so the top bar stays
        // in use, and the overview's keys (Super) work.
        this._grab = Main.pushModal(global.stage, {actionMode: Shell.ActionMode.OVERVIEW});
        this._view.actor.grab_key_focus();
    }

    /** Hand the screen back to the real windows at 1:1. */
    _exitToLive(focusWin = null) {
        this._anim = null;
        this._layoutAnim = null;
        this._input.reset();
        this._entering = null;
        this._menu.close();
        this._timeline.stop();
        this.setCursor('default');
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._mode = 'live';
        this._commit();
        if (focusWin) {
            // Entering a window puts it exactly where it is: don't let
            // follow-focus slide the camera afterwards.
            this._ownFocusUntil = now() + 500;
            Main.activateWindow(focusWin);
        }

        // Real windows are now exactly where their clones are; fade the
        // overlay out to hide the swap. Drawn once more first: the flight's
        // last frame stopped short of where the windows went.
        this._view.sync(this._cam, this.viewport(), this.visibleRecords());
        const actor = this._view.actor;
        actor.ease({
            opacity: 0,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (this._mode === 'live' && this._view) {
                    actor.hide();
                    this._view.returnDash();
                    this._view.clear();
                }
            },
        });
    }

    /** Drop the overlay immediately, without animating (workspace switch, lock…). */
    _abortCanvas() {
        this._launcher.close();
        if (this._mode === 'live')
            return;
        this._anim = null;
        this._layoutAnim = null;
        this._input.reset();
        this._entering = null;
        this._menu.close();
        this._timeline.stop();
        this.setCursor('default');
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._mode = 'live';
        this._cam = {...this._cam, zoom: 1};
        this._view.actor.hide();
        this._view.returnDash();
        this._view.clear();
        this._commit();
    }

    /** A camera flight at 1:1 in live mode, then hand back to the real windows. */
    _glideTo(target, onDone = null) {
        if (this._mode === 'canvas') {
            this.flyTo(target, {onDone});
            return;
        }
        if (this._mode === 'live') {
            this._showOverlay();
            this._mode = 'glide';
        }
        // Short and straight: the overlay blocks input until it lands.
        this.flyTo(target, {
            kind: 'ease',
            duration: GLIDE_MS,
            onDone: () => {
                this._exitToLive();
                onDone?.();
            },
        });
    }

    _reveal(rec, onDone = null) {
        const target = Geo.cameraToReveal({...this._cam, zoom: 1}, this.viewport(), rec.rect, 32);
        if (target && Main.overview.visible) {
            // Nothing would show a flight under the overview: jump, and let
            // its closing animation be the motion.
            this._cam = target;
            this._commit();
            onDone?.();
        } else if (target) {
            this._glideTo(target, onDone);
        } else {
            this._commit();
            onDone?.();
        }
    }

    /** Click: enter the window where it is, growing to 1:1 around the clicked spot. */
    clickEnter(rec, sx, sy) {
        // Maximised and not moved: line the camera up so it stays maximised.
        if (isMaximized(rec.win)) {
            this.enterCentered(rec);
            return;
        }
        const target = Geo.clickEnterCamera(this._cam, this.viewport(), rec.rect, sx, sy);
        this._view.raise(rec.win);
        // The way in lasts at least the double-click interval, so a second
        // click can still turn it into "bring to the middle".
        this._entering = {rec, start: now()};
        this.flyTo(target, {
            kind: 'ease',
            duration: Geo.clamp(this._dblClickMs, ENTER_MS, 600),
            onDone: () => this._exitToLive(rec.win),
        });
    }

    /** Double-click or Return: bring the window to the middle and enter it. */
    enterCentered(rec) {
        this._entering = null;
        this._view.raise(rec.win);
        this.flyTo(Geo.cameraForWindow(rec.rect, this.viewport()), {
            kind: 'ease',
            duration: ENTER_MS,
            onDone: () => this._exitToLive(rec.win),
        });
    }

    /** Pinch in over a window: enter it where it is. */
    pinchEnter(rec, sx) {
        if (isMaximized(rec.win)) {
            this.enterCentered(rec);
            return;
        }
        this.flyTo(Geo.inPlaceCamera(this._cam, this.viewport(), rec.rect, sx), {
            kind: 'ease',
            duration: 220,
            onDone: () => this._exitToLive(rec.win),
        });
    }

    /** Back into the window you came from, as the canvas key does again. */
    leaveCanvas() {
        const vp = this.viewport();
        const from = this._cameFrom;
        const rec = from?.win ? this._records.get(from.win) : null;
        if (rec && !rec.away && Geo.visibleFraction(from.cam, vp, rec.rect) > 0.3) {
            this.flyTo(from.cam, {onDone: () => this._exitToLive(rec.win)});
            return;
        }
        let best = rec && !rec.away ? rec : null;
        if (!best) {
            const cam = this._cam;
            let bestD = Infinity;
            for (const r of this.visibleRecords()) {
                const [x, y] = Geo.center(r.rect);
                const d = Math.hypot(x - cam.cx, y - cam.cy);
                if (d < bestD) {
                    bestD = d;
                    best = r;
                }
            }
        }
        if (best)
            this.flyTo(Geo.cameraForWindow(best.rect, vp), {onDone: () => this._exitToLive(best.win)});
        else
            this.flyTo(from?.cam ?? {...this._cam, zoom: 1}, {onDone: () => this._exitToLive()});
    }

    /** At the end of any gesture: near 1:1 means "back to the real windows". */
    settle() {
        if (this._mode !== 'canvas' || this._input.busy || this._anim || this._layoutAnim || this._menu.isOpen)
            return;
        if (this._cam.zoom >= SETTLE_ZOOM)
            this.flyTo({...this._cam, zoom: 1}, {kind: 'ease', duration: 160, onDone: () => this._exitToLive()});
    }

    // -----------------------------------------------------------------------
    // Animation

    /**
     * Fly the camera. 'spring' (the default) travels along the van Wijk–Nuij
     * path driven by an under-damped spring, as Sunlight's flights do;
     * 'ease' is a straight zoom, for entering a window.
     */
    flyTo(to, {kind = 'spring', duration = ENTER_MS, onDone = null} = {}) {
        const from = {...this._cam};
        if (kind === 'spring') {
            const path = Geo.cameraPath(from, to, this.viewport());
            if (path.length < 1e-4 && Math.abs(from.cx - to.cx) < 0.5 && Math.abs(from.cy - to.cy) < 0.5)
                kind = 'ease';
            else
                this._anim = {kind, path, to, start: now(), onDone};
        }
        if (kind === 'ease')
            this._anim = {kind, from, to, start: now(), duration, onDone};
        this._startTicking();
    }

    animateLayout(to, duration = SNAP_MS) {
        const from = new Map();
        for (const rec of to.keys())
            from.set(rec, {x: rec.x, y: rec.y});
        this._layoutAnim = {start: now(), duration, from, to};
        this._startTicking();
    }

    stopMotion() {
        if (this._anim) {
            this._anim = null;
            this._entering = null;
        }
    }

    _startTicking() {
        this._lastTick = now();
        if (!this._timeline.is_playing())
            this._timeline.start();
    }

    _tick() {
        const t = now();
        const dt = Math.min(t - this._lastTick, 50);
        this._lastTick = t;

        const a = this._anim;
        if (a?.kind === 'ease') {
            const p = Geo.clamp((t - a.start) / a.duration, 0, 1);
            this._cam = Geo.lerpCamera(a.from, a.to, easeOutCubic(p));
            if (p >= 1)
                this._finishFlight(a);
        } else if (a?.kind === 'spring') {
            const {x, v} = Geo.spring((t - a.start) / 1000);
            this._cam = a.path.at(1 - x);
            if (Math.abs(x) < 0.0015 && Math.abs(v) < 0.02)
                this._finishFlight(a);
        } else if (a?.kind === 'kinetic') {
            const cam = this._cam;
            this._cam = {...cam, cx: cam.cx + a.vx * dt / cam.zoom, cy: cam.cy + a.vy * dt / cam.zoom};
            const decay = Math.exp(-dt / PAN_COAST.tau);
            a.vx *= decay;
            a.vy *= decay;
            if (Math.hypot(a.vx, a.vy) < PAN_COAST.stop) {
                this._anim = null;
                this.settle();
            }
        } else if (a?.kind === 'zoom-coast') {
            const cam = this._cam;
            this._cam = Geo.zoomAround(cam, this.viewport(), a.ax, a.ay, cam.zoom * Math.exp(a.v * dt));
            a.v *= Math.exp(-dt / ZOOM_COAST.tau);
            if (Math.abs(a.v) < ZOOM_COAST.stop) {
                this._anim = null;
                this.settle();
            }
        }

        const l = this._layoutAnim;
        if (l) {
            const p = Geo.clamp((t - l.start) / l.duration, 0, 1);
            const e = easeOutCubic(p);
            for (const [rec, from] of l.from) {
                const to = l.to.get(rec);
                rec.x = from.x + (to.x - from.x) * e;
                rec.y = from.y + (to.y - from.y) * e;
            }
            if (p >= 1) {
                this._layoutAnim = null;
                this.queueSave();
                this.settle();
            }
        }

        if (this._mode === 'live')
            return;
        if (!this._anim && !this._layoutAnim)
            this._timeline.stop();
        this.syncView();
    }

    _finishFlight(a) {
        this._cam = {...a.to};
        this._anim = null;
        a.onDone?.();
    }

    syncView() {
        if (this._mode === 'live')
            return;
        this._view.sync(this._cam, this.viewport(), this.visibleRecords());
    }

    // -----------------------------------------------------------------------
    // What input handling (input.js) uses

    get mode() {
        return this._mode;
    }

    get view() {
        return this._view;
    }

    get camera() {
        return this._cam;
    }

    get gridSize() {
        return this._gridSize;
    }

    get doubleClickMs() {
        return this._dblClickMs;
    }

    get menuOpen() {
        return this._menu.isOpen;
    }

    get userGrabbing() {
        return this._userGrabOp;
    }

    get liveMinimap() {
        return this._liveMinimap;
    }

    /** Move the camera by (dx, dy) screen pixels. */
    panBy(dx, dy) {
        const cam = this._cam;
        this._cam = {...cam, cx: cam.cx + dx / cam.zoom, cy: cam.cy + dy / cam.zoom};
        this.syncView();
    }

    zoomTo(zoom, sx, sy) {
        this._cam = Geo.zoomAround(this._cam, this.viewport(), sx, sy, zoom);
        this.syncView();
    }

    _viewportCenter() {
        const vp = this.viewport();
        return [vp.x + vp.w / 2, vp.y + vp.h / 2];
    }

    /** A quarter of the screen in a direction (arrow keys on the canvas). */
    panStep(dx, dy) {
        const vp = this.viewport();
        const cam = this._anim?.to ?? this._cam;
        this.flyTo({
            ...cam,
            cx: cam.cx + dx * 0.25 * vp.w / cam.zoom,
            cy: cam.cy + dy * 0.25 * vp.h / cam.zoom,
        }, {kind: 'ease', duration: 220});
    }

    /** A pan carrying on after the fingers lift, in screen px/ms. */
    coast(vx, vy) {
        if (Math.hypot(vx, vy) > PAN_COAST.threshold) {
            this._anim = {kind: 'kinetic', vx, vy};
            this._startTicking();
        } else {
            this.settle();
        }
    }

    /** A pinch tailing off (log-zoom/ms), never up across the handoff zoom the fingers didn't reach. */
    zoomCoast(v, ax, ay) {
        const zoom = this._cam.zoom;
        const end = zoom * Math.exp(v * ZOOM_COAST.tau);
        if (Math.abs(v) >= ZOOM_COAST.threshold && (zoom >= Geo.HANDOFF_ZOOM || end < Geo.HANDOFF_ZOOM)) {
            this._anim = {kind: 'zoom-coast', v, ax, ay};
            this._startTicking();
        } else {
            this.settle();
        }
    }

    /** A second click while the first is still flying in: to the middle instead. */
    doubleClick() {
        if (!this._entering || now() - this._entering.start >= this._dblClickMs)
            return false;
        this.enterCentered(this._entering.rec);
        return true;
    }

    topRecord() {
        const wins = global.display.sort_windows_by_stacking(this.visibleRecords().map(r => r.win));
        return wins.length ? this._records.get(wins[wins.length - 1]) : null;
    }

    // -----------------------------------------------------------------------
    // Finding windows: the canvas's search

    /** What's typed in the search: the windows it matches stand out, framed by the camera. */
    findWindows(text) {
        // Windows, then frames: each a record or a frame; frames have no `win`.
        const items = [
            ...this.visibleRecords().map(r => ({
                id: r,
                names: [r.win.get_title() ?? '', appOf(r.win)?.get_name() ?? ''],
            })),
            ...this._frames.active().map(f => ({id: f, names: [f.name]})),
        ];
        this._found = text.trim() ? {matches: rankByNames(items, text), selected: 0} : null;
        this._showFound();
        const f = this._found;
        if (f?.matches.length && this._mode === 'canvas') {
            const target = Geo.fitCamera(Geo.union(f.matches.map(m => m.rect ?? m)), this.viewport(), {margin: 96, maxZoom: 0.6});
            this.flyTo(target, {kind: 'ease', duration: 260});
        }
    }

    _showFound() {
        const f = this._found;
        const selected = f?.matches[f.selected];
        const windows = f?.matches.filter(m => m.win);
        this._view.setMatches(f ? new Map(windows.map(r => [r.win, {matches: true, selected: r === selected}])) : null);
        this._view.setFrameMatches(f ? new Set(f.matches.filter(m => !m.win)) : null, selected);
    }

    /** ↑ ↓ in the search: the next match, brought to the middle. */
    stepFinder(delta) {
        const f = this._found;
        if (!f?.matches.length)
            return;
        f.selected = (f.selected + delta + f.matches.length) % f.matches.length;
        this._showFound();
        const m = f.matches[f.selected];
        this.flyTo({...Geo.cameraForWindow(m.rect ?? m, this.viewport()), zoom: this._cam.zoom}, {kind: 'ease', duration: 260});
    }

    /** Return in the search: into the match; with none (or with `apps`), search apps instead. */
    acceptFinder(apps) {
        const text = this._view.search.text;
        const m = apps ? null : this._found?.matches[this._found.selected];
        this._view.endSearch();
        if (m?.win)
            this.enterCentered(m);
        else if (m)
            this.goToFrame(m);
        else if (text.trim())
            this.openHere(null, text);
    }

    cancelFinder() {
        this._view.endSearch();
    }

    // -----------------------------------------------------------------------
    // Strip mode (Sunlight's): every window on one horizontal strip, a
    // column per app, the app used last on the left. See strip.js.

    get stripMode() {
        return this._strip !== null;
    }

    toggleStrip() {
        this._settings.set_boolean('strip-mode', !this._settings.get_boolean('strip-mode'));
    }

    _syncStrip() {
        const on = this._settings.get_boolean('strip-mode');
        if (on && !this._strip) {
            // From a gap in from the top-left of the screen as it is at 1:1;
            // off again, every window goes back where it was.
            const view = Geo.visibleCanvasRect({...this._cam, zoom: 1}, this.viewport());
            const gap = Geo.tidySpacing('normal', this._tileGap);
            this._strip = {
                origin: {x: Math.round(view.x + gap), y: Math.round(view.y + gap)},
                saved: new Map(this._activeRecords().map(r => [r, {x: r.x, y: r.y}])),
                cols: [],
            };
            this._layoutStrip();
        } else if (!on && this._strip) {
            const {saved} = this._strip;
            this._strip = null;
            this._cancelLater(this._stripTimeout);
            const to = new Map([...saved].filter(([r]) => this._records.has(r.win)));
            this._applyLayout(to);
        }
    }

    /**
     * Every window here to its place on the strip: in `cols` (of records)
     * where given, a window not in them by recency.
     */
    _layoutStrip(cols = null) {
        const recs = this._activeRecords().filter(r => !r.win.fullscreen);
        const tabs = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, global.workspace_manager.get_active_workspace());
        const items = recs.map(r => ({
            rect: r.rect,
            app: appId(r.win),
            recency: tabs.includes(r.win) ? tabs.indexOf(r.win) : null,
        }));
        let order = cols?.map(c => c.map(r => recs.indexOf(r)).filter(i => i >= 0)).filter(c => c.length);
        if (!order || order.flat().length !== recs.length)
            order = Strip.columns(items);
        const gap = Geo.tidySpacing('normal', this._tileGap);
        const {rects} = Strip.layout(items, order, this._strip.origin, gap);
        this._strip.cols = order.map(c => c.map(i => recs[i]));
        this._applyLayout(new Map(recs.map((r, i) => [r, {x: rects[i].x, y: rects[i].y}])));
    }

    _applyLayout(to) {
        if (this._mode === 'canvas') {
            this.animateLayout(to, 300);
            return;
        }
        for (const [r, p] of to) {
            r.x = p.x;
            r.y = p.y;
        }
        if (this._mode === 'live')
            this._commit();
    }

    /** A window that just opened: the top of its app's column, and that column first. */
    _stripInsert(rec) {
        const app = appId(rec.win);
        const cols = this._strip.cols.map(c => c.filter(r => r !== rec)).filter(c => c.length);
        const i = cols.findIndex(c => appId(c[0].win) === app);
        const col = i >= 0 ? cols.splice(i, 1)[0] : [];
        this._layoutStrip([[rec, ...col], ...cols]);
    }

    /** A window let go on the strip: its column (or its place in it) where it was dropped. */
    stripDropped(rec) {
        const flat = this._strip.cols.flat();
        const i = flat.indexOf(rec);
        if (i < 0) {
            this._layoutStrip(this._strip.cols);
            return;
        }
        const cols = this._strip.cols.map(c => c.map(r => flat.indexOf(r)));
        const order = Strip.reordered(cols, flat.map(r => r.rect), i);
        this._layoutStrip(order.map(c => c.map(j => flat[j])));
    }

    _queueStripReflow() {
        this._cancelLater(this._stripTimeout);
        this._stripTimeout = this._later(150, () => {
            this._stripTimeout = 0;
            if (this._strip && !this._input.busy)
                this._layoutStrip(this._strip.cols);
        });
    }

    /** Super+Alt+arrows: the next column (its top window) or the next window in the column. */
    stripStep(direction) {
        if (!this._strip || Main.overview.visible)
            return;
        const flat = this._strip.cols.flat();
        const from = (this._mode === 'canvas' ? this._input.hovered : null) ?? this._focusedRecord() ?? flat[0];
        const cols = this._strip.cols.map(c => c.map(r => flat.indexOf(r)));
        const n = Strip.neighbour(flat.indexOf(from), cols, flat.map(r => r.away), direction);
        const rec = n === null ? null : flat[n];
        if (!rec)
            return;
        if (this._mode === 'canvas') {
            this.enterCentered(rec);
        } else {
            this._ownFocusUntil = now() + 1000;
            this._glideTo(Geo.cameraForWindow(rec.rect, this.viewport()), () => Main.activateWindow(rec.win));
        }
    }

    // -----------------------------------------------------------------------
    // Frames

    /**
     * Right-click › New Frame: around the windows in view, or a screen's
     * size at the click; then its name is typed.
     */
    newFrame(sx, sy) {
        const vp = this.viewport();
        const inView = this.visibleRecords().filter(r => Geo.visibleFraction(this._cam, vp, r.rect) > 0.5);
        const at = this.canvasPoint(sx, sy);
        const rect = Geo.frameAround(inView.map(r => r.rect), FRAME_PAD) ??
            {x: at.x - vp.w / 2, y: at.y - vp.h / 2, w: vp.w, h: vp.h};
        const frame = this._frames.add(rect);
        this._view.setFrames(this._frames.active());
        this.syncView();
        this.renameFrame(frame);
    }

    renameFrame(frame) {
        this._view.editFrameName(frame, () => {
            this._frames.save();
            this.syncView();
        });
    }

    deleteFrame(frame) {
        this._frames.remove(frame);
        this._view.setFrames(this._frames.active());
        this.syncView();
    }

    /** The camera on the frame: at 1:1 if it fits, then its windows are real. */
    goToFrame(frame) {
        if (this._mode !== 'canvas')
            return;
        const target = Geo.fitCamera(frame, this.viewport(), {margin: 24, maxZoom: 1});
        this.flyTo(target, {
            onDone: () => {
                if (target.zoom >= 1)
                    this._exitToLive();
            },
        });
    }

    /** The windows a frame carries: their middles inside it, minimised ones too. */
    frameMembers(frame) {
        return this._activeRecords().filter(r => Geo.insideFrame(frame, r.rect));
    }

    /** A frame was moved or resized on the canvas. */
    frameChanged() {
        this._frames.save();
        this.queueSave();
    }

    resizeFrame(frame, rect) {
        this._frames.resize(frame, rect);
        this.syncView();
    }

    // -----------------------------------------------------------------------
    // Open Here…

    /**
     * The launcher bar. The app's window opens at `point` (canvas
     * coordinates): by default under the pointer on empty canvas, else the
     * middle of the view.
     */
    openHere(point = null, text = '') {
        if (Main.overview.visible || Main.sessionMode.isLocked || this._launcher.isOpen || this._mode === 'glide')
            return;
        // A double-click on the desktop: open at 1:1 rather than on a canvas
        // that hasn't zoomed out.
        if (this._mode === 'canvas' && this._cam.zoom >= SETTLE_ZOOM && !this._anim)
            this._exitToLive();
        const spot = point ?? this._defaultSpot();
        if (this._settings.get_string('launcher') === 'gnome') {
            this._searchHere(spot, text);
            return;
        }
        if (this._mode === 'canvas') {
            this.stopMotion();
            this._input.clearHover();
            this.setCursor('default');
            this._view.setMark(spot);
            this.syncView();
        }
        this._launcher.open({
            text,
            onOpen: (app, enter) => this._openApp(app, spot, enter),
            onClose: () => {
                this._view.setMark(null);
                if (this._mode === 'canvas')
                    this._view.actor.grab_key_focus();
            },
        });
    }

    /**
     * Open Here… through GNOME's own search: the overview opens searching,
     * and the next app window opened from it goes to the spot. From the
     * canvas the camera moves there first, so it opens in view.
     */
    _searchHere(spot, text) {
        if (this._mode === 'canvas') {
            this._cam = {...this._cam, cx: spot.x, cy: spot.y};
            this._abortCanvas();
        }
        // Waits as long as the search is up; LAUNCH_WAIT_MS once it closes.
        this._opening = {app: null, spot, enter: false, known: new Set(this._records.keys()), deadline: Infinity, placedAt: 0};
        Main.overview.focusSearch();
        if (text)
            Main.overview.searchEntry.set_text(text);
    }

    _defaultSpot() {
        const vp = this.viewport();
        if (this._mode === 'canvas') {
            const [x, y] = global.get_pointer();
            const inside = x >= vp.x && y >= vp.y && x < vp.x + vp.w && y < vp.y + vp.h;
            if (inside && !this.recordAt(x, y) && !this._view.isOverChrome(x, y))
                return this.canvasPoint(x, y);
        }
        return {x: this._cam.cx, y: this._cam.cy};
    }

    /**
     * Not running, or running without windows: launched. Running with
     * windows: asked for a new one, and if none shows (an app with a single
     * window) the one used last comes over to the spot instead.
     */
    _openApp(app, spot, enter) {
        const known = new Set(app.get_windows());
        this._opening = {app, spot, enter, known, deadline: now() + LAUNCH_WAIT_MS, placedAt: 0};
        if (known.size > 0 && !app.can_open_new_window()) {
            this._bringOver(app);
            return;
        }
        app.open_new_window(-1);
        if (known.size > 0)
            this._later(NEW_WINDOW_WAIT_MS, () => this._bringOver(app));
    }

    /** The spot Open Here… is waiting to fill, if `rec` is the window it waits for. */
    _openingSpot(rec) {
        const o = this._opening;
        if (!o)
            return null;
        const t = now();
        if (t > (o.placedAt ? o.placedAt + SIBLING_WAIT_MS : o.deadline)) {
            this._opening = null;
            return null;
        }
        if (o.known.has(rec.win) || (o.app && appOf(rec.win) !== o.app) || rec.win.get_transient_for())
            return null;
        if (!o.placedAt) {
            o.placedAt = t;
            if (o.enter)
                this._later(350, () => this._enterOpened(rec));
        }
        return o.spot;
    }

    /** No new window came: the app's window used last comes to the spot. */
    _bringOver(app) {
        const o = this._opening;
        if (o?.app !== app || o.placedAt)
            return;
        this._opening = null;
        const active = new Set(this._activeRecords());
        const recs = app.get_windows().map(w => this._records.get(w)).filter(r => active.has(r));
        const rec = recs.find(r => !r.away) ?? recs[0];
        if (!rec)
            return;
        const others = [...active].filter(r => r !== rec && !r.away);
        const to = this._freeSpot(rec, others, o.spot);
        if (this._mode === 'canvas') {
            this.pushUndo(this.snapshot([rec]));
            if (rec.win.minimized)
                rec.win.unminimize();
            this._view.raise(rec.win);
            this.animateLayout(new Map([[rec, {x: to.x, y: to.y}]]), GLIDE_MS);
            if (o.enter)
                this._later(GLIDE_MS + 50, () => this._enterOpened(rec));
        } else if (this._mode === 'live') {
            rec.x = to.x;
            rec.y = to.y;
            this._ownFocusUntil = now() + 1000;
            this._commit();
            Main.activateWindow(rec.win);
        }
        this.queueSave();
    }

    /** Ctrl+Return / dash-enter: into the window once it's on the canvas, centred. */
    _enterOpened(rec) {
        if (this._mode !== 'canvas' || !this._records.has(rec.win) || rec.away)
            return;
        this.enterCentered(rec);
    }

    // -----------------------------------------------------------------------
    // Right-click menus

    openMenu(rec, sx, sy) {
        const tiling = PRESET_TITLES.map(([preset, label]) => ({label, action: () => this.moveResize(preset, rec)}));
        const items = rec ? [
            {label: 'Enter', action: () => this.enterCentered(rec)},
            {label: 'Move & Resize', items: tiling},
            {label: 'Tidy', action: () => this.tidy()},
            null,
            {label: 'Minimize', action: () => rec.win.minimize()},
            {label: 'Close', action: () => this.closeOnCanvas(rec)},
        ] : [
            {label: 'Open Here…', action: () => this.openHere(this.canvasPoint(sx, sy))},
            {label: 'New Frame', action: () => this.newFrame(sx, sy)},
            ...this._frames.active().length ? [{
                label: 'Go to Frame',
                items: this._frames.active().map(f => ({label: f.name, action: () => this.goToFrame(f)})),
            }] : [],
            null,
            {label: 'See Everything', action: () => this.fitAll()},
            {label: 'Tidy', action: () => this.tidy()},
            {label: this._strip ? 'Free Canvas' : 'Strip Mode', action: () => this.toggleStrip()},
            ...this._undo.length ? [{label: 'Undo', action: () => this.undo()}] : [],
            null,
            {label: 'Save Layout', action: () => this.saveLayout()},
            ...this.layouts().map((l, i) => ({label: `${l.name}  (Ctrl+${i + 1})`, action: () => this.restoreLayout(i)})),
        ];
        this._menu.open(sx, sy, items);
    }

    canvasPoint(sx, sy) {
        const [x, y] = Geo.screenToCanvas(this._cam, this.viewport(), sx, sy);
        return {x, y};
    }

    openFrameMenu(frame, sx, sy) {
        this._menu.open(sx, sy, [
            {label: 'Go to Frame', action: () => this.goToFrame(frame)},
            {label: 'Rename', action: () => this.renameFrame(frame)},
            null,
            {label: 'Delete Frame', action: () => this.deleteFrame(frame)},
        ]);
    }

    closeMenu() {
        this._menu.close();
    }

    // -----------------------------------------------------------------------
    // Public actions (keybindings, minimap, panel menu)

    /**
     * One workspace: every window onto the first workspace's canvas, each
     * workspace's windows side by side, arranged as they were. With `show`,
     * the canvas then shows them all.
     */
    gatherWorkspaces(show) {
        const wm = global.workspace_manager;
        const first = wm.get_workspace_by_index(0);
        this._abortCanvas();
        if (wm.get_active_workspace() !== first)
            first.activate(global.get_current_time());
        const groups = [];
        for (let i = 0; i < wm.n_workspaces; i++) {
            const ws = wm.get_workspace_by_index(i);
            groups.push([...this._records.values()].filter(r => r.win.get_workspace() === ws));
        }
        const offsets = Geo.mergeOffsets(groups.map(g => g.map(r => r.rect)), WORKSPACE_GAP);
        let moved = 0;
        groups.forEach((group, i) => {
            const [dx, dy] = offsets[i];
            for (const rec of group) {
                rec.x += dx;
                rec.y += dy;
                if (i > 0) {
                    rec.win.change_workspace(first);
                    moved++;
                }
            }
        });
        this._commit();
        if (show && moved > 0) {
            this.fitAll();
            this._view.toast(`${moved} window${moved === 1 ? '' : 's'} gathered from the other workspaces`);
        }
    }

    /**
     * Something activated a window and asked the overview to close (Alt+Tab,
     * a notification, a launcher): with the canvas standing in for it, go
     * into that window.
     */
    leaveToFocused() {
        // A dash / Open Here… launch is still waiting for its window: stay put.
        if (this._opening && !this._opening.placedAt)
            return;
        const rec = this._focusedRecord();
        // The focus hasn't moved (an app still starting): back where we came from.
        if (rec && !rec.away && rec.win !== this._cameFrom?.win)
            this.enterCentered(rec);
        else
            this.leaveCanvas();
    }

    /**
     * A click on the canvas's borrowed dash: running apps are entered centred;
     * otherwise the app opens in the middle of the view. With `dash-enter`
     * (on by default) Skylight then goes into that window at 1:1, as Sunlight
     * does for a Dock launch that should be used right away. Ctrl / middle-click
     * asks for a new window even when one is already open.
     * @returns {boolean} true if Skylight handled it (skip GNOME's activate + hide)
     */
    dashActivate(app, button) {
        if (this._mode !== 'canvas' || !app)
            return false;
        const event = Clutter.get_current_event();
        const modifiers = event ? event.get_state() : 0;
        const openNew = app.can_open_new_window() &&
            app.get_state() === Shell.AppState.RUNNING &&
            (((modifiers & Clutter.ModifierType.CONTROL_MASK) !== 0) ||
                button === Clutter.BUTTON_MIDDLE);
        const active = new Set(this._activeRecords());
        const windows = app.get_windows()
            .map(w => this._records.get(w))
            .filter(r => r && active.has(r) && !r.away);
        if (!openNew && windows.length > 0) {
            this.enterCentered(windows[0]);
            return true;
        }
        // Default on: open at the camera centre and go into it (enterCentered).
        const enter = this._settings.get_boolean('dash-enter');
        this.openAppAt(app, {x: this._cam.cx, y: this._cam.cy}, enter);
        return true;
    }

    /**
     * Open an app on the canvas at a canvas-space point (dash drop, Open Here…).
     * Stays in canvas mode; the window arrives via `_opening` / `_onMap`.
     */
    openAppAt(app, spot, enter = false) {
        if (!app || !spot)
            return;
        if (this._mode === 'canvas') {
            this.stopMotion();
            this._input.clearHover();
            this.setCursor('default');
            this._view.setMark(spot);
            this.syncView();
        }
        this._openApp(app, spot, enter);
    }

    /** Pill / menu close on the canvas: play the close effect, then delete. */
    closeOnCanvas(rec) {
        if (!rec || this._mode !== 'canvas') {
            rec?.win.delete(global.get_current_time());
            return;
        }
        const screen = this._screenRect(rec);
        const style = this._windowEffectStyle({});
        const done = () => {
            if (this._records.has(rec.win))
                rec.win.delete(global.get_current_time());
        };
        if (!style) {
            done();
            return;
        }
        this._view.playDeparture(rec.win, screen, style, {}, done);
    }

    toggleCanvas() {
        if (this._mode === 'canvas')
            this.leaveCanvas();
        else
            this.fitAll();
    }

    /** See everything: the canvas with every window fitted. */
    fitAll() {
        if (Main.overview.visible)
            return;
        const recs = this._activeRecords();
        const vp = this.viewport();
        let target = Geo.fitCamera(Geo.union(recs.map(r => r.rect)), vp, {margin: 72, maxZoom: 0.6});
        if (!target)
            target = {...this._cam, zoom: 0.5};
        this.enterCanvas();
        this.flyTo(target);
    }

    zoomToActual() {
        if (this._mode !== 'canvas')
            return;
        this.flyTo({...(this._anim?.to ?? this._cam), zoom: 1}, {
            kind: 'ease',
            duration: 320,
            onDone: () => this._exitToLive(),
        });
    }

    zoomIn() {
        if (this._mode !== 'canvas')
            return;
        const cam = this._anim?.to ?? this._cam;
        const zoom = cam.zoom * ZOOM_STEP;
        if (zoom >= SETTLE_ZOOM) {
            this.zoomToActual();
            return;
        }
        const [sx, sy] = this._viewportCenter();
        this.flyTo(Geo.zoomAround(cam, this.viewport(), sx, sy, zoom), {kind: 'ease', duration: 260});
    }

    zoomOut() {
        if (Main.overview.visible)
            return;
        this.enterCanvas();
        const cam = this._anim?.to ?? this._cam;
        const [sx, sy] = this._viewportCenter();
        this.flyTo(Geo.zoomAround(cam, this.viewport(), sx, sy, cam.zoom / ZOOM_STEP), {kind: 'ease', duration: 260});
    }

    /**
     * Tidy: every window on one grid from the top-left of the screen in view,
     * keeping sizes, and the camera framing the result (or, with the mosaic
     * style, packed as tightly as fits the screen's shape).
     */
    tidy() {
        if (Main.overview.visible)
            return;
        // On the strip, Tidy sorts it again: the app used last first.
        if (this._strip) {
            this._layoutStrip();
            return;
        }
        const recs = this.visibleRecords();
        if (recs.length === 0)
            return;
        const vp = this.viewport();
        const cam = this._cam;
        const spacing = Geo.tidySpacing(this._settings.get_string('tidy-spacing'), this._tileGap);
        const to = new Map();
        let bounds;
        if (this._settings.get_string('tidy-style') === 'mosaic') {
            const layout = Geo.mosaicLayout(recs.map(r => ({id: r, w: r.w, h: r.h})), vp.w / vp.h, spacing);
            for (const [rec, p] of layout)
                to.set(rec, {x: Math.round(cam.cx + p.x), y: Math.round(cam.cy + p.y)});
            bounds = Geo.union(recs.map(r => ({...to.get(r), w: r.w, h: r.h})));
        } else {
            const origin = this._mode === 'canvas' && cam.zoom < 1
                ? Geo.pageContaining(cam.cx, cam.cy, this._homeScreen())
                : Geo.visibleCanvasRect({...cam, zoom: 1}, vp);
            const tabs = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, global.workspace_manager.get_active_workspace());
            const items = recs.map(r => ({
                ...r.rect,
                app: appId(r.win),
                recency: Math.max(0, tabs.indexOf(r.win)),
            }));
            const result = Geo.tidyLayout(items, {
                columns: this._settings.get_int('tidy-columns'),
                order: this._settings.get_string('tidy-order'),
                spacing,
            }, {x: Math.round(origin.x), y: Math.round(origin.y)});
            recs.forEach((r, i) => to.set(r, {x: result.rects[i].x, y: result.rects[i].y}));
            bounds = result.bounds;
        }
        this.pushUndo(this.snapshot(recs));
        this.enterCanvas();
        this.animateLayout(to, 480);
        this.flyTo(Geo.fitCamera(bounds, vp, {margin: 48, maxZoom: 0.6}));
    }

    /**
     * Move & Resize: a window to a slot of its screen. At 1:1 that's the
     * screen you're looking at; zoomed out it's the window's page. Pressing
     * a half again steps to two-thirds, then a third.
     */
    moveResize(preset, rec = null) {
        if (Main.overview.visible)
            return;
        rec ??= this._mode === 'canvas'
            ? this._input.hovered ?? this._focusedRecord()
            : this._focusedRecord();
        if (!rec || rec.away)
            return;
        const vp = this.viewport();
        const area = this._mode === 'canvas'
            ? Geo.pageContaining(...Geo.center(rec.rect), this._homeScreen())
            : Geo.visibleCanvasRect({...this._cam, zoom: 1}, vp);
        const sameArea = rec.tile && ['x', 'y', 'w', 'h'].every(k => Math.abs(rec.tile.area[k] - area[k]) < 1);
        const chosen = Geo.nextPreset(preset, sameArea ? rec.tile.preset : null);
        const target = Geo.presetRect(chosen, rec.w, rec.h, area, this._tileGap);

        this.pushUndo(this.snapshot([rec]));
        rec.tile = {preset: chosen, area};
        rec.anchorTo = {rect: target, anchor: Geo.presetAnchor(chosen), until: now() + TILE_SETTLE_MS};
        if (this._mode === 'canvas') {
            this.resizeReal(rec, target.w, target.h);
            this.animateLayout(new Map([[rec, {x: target.x, y: target.y}]]), SNAP_MS);
        } else {
            rec.x = target.x;
            rec.y = target.y;
            this.resizeReal(rec, target.w, target.h);
            this._commit();
        }
    }

    // Minimap callbacks

    minimapState() {
        const vp = this.viewport();
        const cam = this._cam;
        const focused = this._focusedRecord();
        const windows = this._activeRecords().map(r => ({
            win: r.win,
            rect: r.rect,
            app: appOf(r.win),
            away: r.away,
            focused: r === focused,
        }));
        return {windows, view: Geo.visibleCanvasRect(cam, vp), zoom: cam.zoom};
    }

    /** A click on the minimap: look there at the current zoom. */
    minimapLook(x, y) {
        const target = {...this._cam, cx: x, cy: y};
        if (this._mode === 'canvas')
            this.flyTo(target);
        else
            this._glideTo({...target, zoom: 1});
    }

    /** Dragging the outline pans; at 1:1 the camera glides there when you let go. */
    minimapPan(dx, dy) {
        if (this._mode === 'canvas') {
            this.stopMotion();
            this._cam = {...this._cam, cx: this._cam.cx + dx, cy: this._cam.cy + dy};
            this.syncView();
        } else {
            const t = this._minimapTarget ?? {...this._cam};
            this._minimapTarget = {...t, cx: t.cx + dx, cy: t.cy + dy};
        }
    }

    minimapPanEnd() {
        const t = this._minimapTarget;
        this._minimapTarget = null;
        if (t && this._mode === 'live')
            this._glideTo({...t, zoom: 1});
        else
            this.settle();
    }

    /** A click on a minimised window's dashed outline: bring it back and go in. */
    minimapRestore(win) {
        const rec = this._records.get(win);
        if (!rec)
            return;
        this._applying++;
        try {
            win.unminimize();
        } finally {
            this._applying--;
        }
        rec.parked = false;
        const target = Geo.cameraForWindow(rec.rect, this.viewport());
        if (this._mode === 'canvas') {
            this._view.syncRecords(this.visibleRecords());
            this.flyTo(target, {onDone: () => this._exitToLive(win)});
        } else {
            this._glideTo(target, () => {
                this._ownFocusUntil = now() + 500;
                Main.activateWindow(win);
            });
        }
    }
}
