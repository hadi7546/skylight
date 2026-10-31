// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

// The zoomable canvas overlay. While the camera is not at 100% (or while it
// is moving) this actor covers the primary monitor and draws every window
// as a clone at its canvas position, scaled by the camera zoom. Windows are
// never resized by zooming, so nothing reflows.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Geo from './geometry.js';
import {Backdrop} from './backdrop.js';
import {Minimap} from './minimap.js';

const PILL_INSET = 8;
const LABEL_GAP = 6;
const ENTRANCE_SCALE = 0.9;
const ENTRANCE_MS = 500;
const RING_MS = 450;
const RING_REACH = 24;
const MARK_SIZE = 36;
const DASH_HEIGHT = 0.15; // of the view, as GNOME's overview gives it
const DIMMED = 90; // the windows a search doesn't match
const RING_GAP = 4;
const FRAME_TITLE_GAP = 6;

/** Opacity (0..1) of labels and controls: they fade out as we near 1:1. */
function chromeFactor(zoom) {
    return Geo.clamp((0.985 - zoom) / 0.1, 0, 1);
}

function appName(win) {
    // Apps without a .desktop file only have their id as a name: use the title.
    const app = Shell.WindowTracker.get_default().get_window_app(win);
    const name = app && !app.is_window_backed() ? app.get_name() : null;
    return name ?? win.get_title() ?? '';
}

class WindowPreview {
    constructor(win) {
        this.win = win;
        this.actor = new St.Widget({style_class: 'skylight-preview'});

        // Everything inside `_scaled` is in window (frame) pixels, scaled as a
        // whole. `_entrance` wraps it so the arrival spring has its own scale.
        this._entrance = new Clutter.Actor({pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        this.actor.add_child(this._entrance);
        this._scaled = new Clutter.Actor();
        this._entrance.add_child(this._scaled);
        this._clones = [];
        this._addClone(win);
        win.foreach_transient(t => {
            if (t.is_attached_dialog())
                this._addClone(t);
            return true;
        });

        // Around it while it matches what's typed in the search.
        this._ring = new St.Widget({style_class: 'skylight-match-ring', visible: false});
        this.actor.add_child(this._ring);

        this._label = new St.Label({style_class: 'skylight-label'});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.actor.add_child(this._label);
        this.updateTitle();

        // The floating controls at the top-right: minimise and close.
        this.pill = new St.BoxLayout({style_class: 'skylight-pill', visible: false});
        this.minimizeButton = new St.Bin({
            style_class: 'skylight-pill-button',
            child: new St.Icon({icon_name: 'window-minimize-symbolic', style_class: 'skylight-pill-icon'}),
        });
        this.closeButton = new St.Bin({
            style_class: 'skylight-pill-button',
            child: new St.Icon({icon_name: 'window-close-symbolic', style_class: 'skylight-pill-icon'}),
        });
        this.pill.add_child(this.minimizeButton);
        this.pill.add_child(this.closeButton);
        this.actor.add_child(this.pill);

        this._hovered = false;
    }

    _addClone(win) {
        const source = win.get_compositor_private();
        if (!source)
            return;
        const clone = new Clutter.Clone({source});
        this._clones.push({win, clone});
        this._scaled.add_child(clone);
    }

    updateTitle() {
        this._label.text = appName(this.win);
    }

    setHovered(hovered) {
        this._hovered = hovered;
    }

    /** null: no search. Otherwise whether it matches, and is the one Return goes into. */
    setMatch(match) {
        this._entrance.opacity = match && !match.matches ? DIMMED : 255;
        this._ring.visible = match?.selected ?? false;
    }

    update(sx, sy, rec, zoom) {
        const w = rec.w * zoom, h = rec.h * zoom;
        this.actor.set_position(sx, sy);
        this.actor.set_size(w, h);
        this._ring.set_position(-RING_GAP, -RING_GAP);
        this._ring.set_size(w + 2 * RING_GAP, h + 2 * RING_GAP);
        this._entrance.set_size(w, h);
        this._scaled.set_scale(zoom, zoom);

        const frame = this.win.get_frame_rect();
        for (const {win, clone} of this._clones) {
            const buf = win.get_buffer_rect();
            clone.set_position(buf.x - frame.x, buf.y - frame.y);
        }

        const f = chromeFactor(zoom);
        const [, natW] = this._label.get_preferred_width(-1);
        const [, natH] = this._label.get_preferred_height(-1);
        this._label.set_width(Math.min(natW, Math.max(w, 0)));
        this._label.set_position(0, -natH - LABEL_GAP);
        this._label.opacity = Math.round(255 * f);
        this._label.visible = f > 0;

        const [, pillW] = this.pill.get_preferred_width(-1);
        this.pill.visible = this._hovered && f > 0 && w > pillW + 2 * PILL_INSET;
        this.pill.opacity = Math.round(255 * f);
        this.pill.set_position(Math.round(w - pillW - PILL_INSET), PILL_INSET);
    }

    /** Which pill button (if any) is under stage point (x, y). */
    pillHit(x, y) {
        if (!this.pill.visible)
            return null;
        for (const [name, button] of [['minimize', this.minimizeButton], ['close', this.closeButton]]) {
            const {origin, size} = button.get_transformed_extents();
            if (x >= origin.x && x < origin.x + size.width && y >= origin.y && y < origin.y + size.height)
                return name;
        }
        return null;
    }

    /** A window arriving on the canvas: it springs up to size. */
    arrive() {
        this._entrance.remove_all_transitions();
        this._entrance.set_scale(ENTRANCE_SCALE, ENTRANCE_SCALE);
        this._entrance.ease({
            scale_x: 1,
            scale_y: 1,
            duration: ENTRANCE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    destroy() {
        this.actor.destroy();
    }
}

export class CanvasView {
    constructor(controller) {
        this._controller = controller;
        this._previews = new Map();

        this.actor = new St.Widget({
            name: 'skylight-canvas',
            reactive: true,
            visible: false,
            clip_to_allocation: true,
        });

        this.backdrop = new Backdrop(true);
        this.actor.add_child(this.backdrop.actor);

        // Frames: their outlines under the windows, their names over them.
        this._frameLayer = new Clutter.Actor();
        this.actor.add_child(this._frameLayer);
        this._frameViews = new Map(); // frame → {box, title}
        this._editing = null; // {finish}: a frame's name being typed

        this._windowLayer = new Clutter.Actor();
        this.actor.add_child(this._windowLayer);

        this._frameTitleLayer = new Clutter.Actor();
        this.actor.add_child(this._frameTitleLayer);

        this._guideLayer = new Clutter.Actor();
        this.actor.add_child(this._guideLayer);
        this._guides = [];

        // Open Here…: a ring where the app will open, while the bar is up.
        this._mark = null;
        this._markRing = new St.Widget({
            style_class: 'skylight-mark',
            visible: false,
            width: MARK_SIZE,
            height: MARK_SIZE,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this._guideLayer.add_child(this._markRing);

        // Heads-up display: zoom level top-left, minimap bottom-right.
        this._hud = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this.actor.add_child(this._hud);
        this._zoomLabel = new St.Label({
            style_class: 'skylight-zoom-label',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        this._hud.add_child(this._zoomLabel);
        this.minimap = new Minimap(controller);
        this.minimap.set({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
        });
        this.minimap.add_style_class_name('skylight-minimap-floating');
        this._hud.add_child(this.minimap);

        // Standing in for GNOME's overview: search at the top, the dash at
        // the bottom (setOverviewChrome).
        this._overviewChrome = false;
        // Typing finds windows (controller.findWindows); Return with none
        // found searches apps instead.
        this.search = new St.Entry({
            style_class: 'skylight-search',
            hint_text: 'Find a window, or an app',
            can_focus: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this.search.clutter_text.connect('text-changed', () => controller.findWindows(this.search.text));
        this._hud.add_child(this.search);
        // GNOME's own dash is borrowed from the overview while the canvas
        // shows (borrowDash), and sits here.
        this._dashSlot = new St.Widget({
            style_class: 'skylight-dash-slot',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        this._hud.add_child(this._dashSlot);
        this._borrowed = null; // {parent, index, props}: where the dash goes back to

        // Popup menus live here, in stage coordinates, above everything.
        this.menuLayer = new Clutter.Actor();
        this.actor.add_child(this.menuLayer);

        // Over the windows, under the top bar, which stays in use.
        Main.layoutManager.uiGroup.insert_child_below(this.actor, Main.layoutManager.panelBox);
    }

    /** Keeps one outline and name per frame. */
    setFrames(frames) {
        for (const [frame, v] of this._frameViews) {
            if (!frames.includes(frame)) {
                v.box.destroy();
                v.title.destroy();
                this._frameViews.delete(frame);
            }
        }
        for (const frame of frames) {
            if (this._frameViews.has(frame))
                continue;
            const box = new St.Widget({style_class: 'skylight-frame'});
            const title = new St.Label({style_class: 'skylight-frame-title', reactive: true});
            this._frameLayer.add_child(box);
            this._frameTitleLayer.add_child(title);
            this._frameViews.set(frame, {box, title});
        }
    }

    /** @param {Set} matched - frames the search found; `selected` the one Return goes to */
    setFrameMatches(matched, selected) {
        for (const [frame, v] of this._frameViews) {
            for (const [on, pseudo] of [[matched?.has(frame), 'matched'], [frame === selected, 'selected']]) {
                if (on)
                    v.box.add_style_pseudo_class(pseudo);
                else
                    v.box.remove_style_pseudo_class(pseudo);
            }
        }
    }

    /** A frame under a stage point: its name (to move it) or its edge (to resize it). */
    frameAt(x, y) {
        const views = [...this._frameViews].reverse();
        for (const [frame, v] of views) {
            const {origin, size} = v.title.get_transformed_extents();
            if (x >= origin.x && x < origin.x + size.width && y >= origin.y && y < origin.y + size.height)
                return {frame, part: 'title'};
        }
        for (const [frame, v] of views) {
            const {origin, size} = v.box.get_transformed_extents();
            const edges = Geo.resizeEdges(x, y, {x: origin.x, y: origin.y, w: size.width, h: size.height});
            if (edges)
                return {frame, part: 'edge', edges};
        }
        return null;
    }

    get editingFrame() {
        return this._editing !== null;
    }

    /** Typing a frame's name in place of it; `onDone` once it's kept or abandoned. */
    editFrameName(frame, onDone) {
        this.endFrameEdit(true);
        const v = this._frameViews.get(frame);
        const entry = new St.Entry({style_class: 'skylight-frame-title-entry', text: frame.name, can_focus: true});
        this._frameTitleLayer.add_child(entry);
        entry.set_position(v.title.x, v.title.y);
        v.title.hide();
        global.stage.set_key_focus(entry.clutter_text);
        entry.clutter_text.set_selection(0, -1);
        const finish = keep => {
            if (this._editing?.entry !== entry)
                return;
            this._editing = null;
            if (keep && entry.text.trim())
                frame.name = entry.text.trim();
            entry.destroy();
            v.title.show();
            this.actor.grab_key_focus();
            onDone();
        };
        entry.clutter_text.connect('activate', () => finish(true));
        entry.clutter_text.connect('key-focus-out', () => finish(true));
        this._editing = {entry, finish};
    }

    endFrameEdit(keep) {
        this._editing?.finish(keep);
    }

    get searchFocused() {
        return global.stage.key_focus === this.search.clutter_text;
    }

    /** Typing on the canvas goes into the search, starting with `text`. */
    focusSearch(text = '') {
        global.stage.set_key_focus(this.search.clutter_text);
        this.search.clutter_text.insert_text(text, -1);
    }

    /** Empty, and the keys back to the canvas. */
    endSearch() {
        this.search.text = '';
        if (this.searchFocused)
            this.actor.grab_key_focus();
    }

    /** @param {Map<Meta.Window, {matches, selected}>|null} matches - null: no search */
    setMatches(matches) {
        for (const [win, preview] of this._previews)
            preview.setMatch(matches ? matches.get(win) ?? {matches: false, selected: false} : null);
    }

    /** Search and the dash on the canvas, when it stands in for the overview. */
    setOverviewChrome(on) {
        this._overviewChrome = on;
        if (on)
            this.borrowDash();
        else
            this.returnDash();
    }

    /** The overview's dash onto the canvas; its app grid button opens the app grid. */
    borrowDash() {
        const dash = Main.overview.dash;
        if (this._borrowed)
            return;
        const parent = dash.get_parent();
        this._borrowed = {
            parent,
            index: parent.get_children().indexOf(dash),
            props: {x_expand: dash.x_expand, y_expand: dash.y_expand, x_align: dash.x_align, y_align: dash.y_align},
        };
        parent.remove_child(dash);
        dash.set({x_expand: false, y_expand: false, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.END});
        this._dashSlot.add_child(dash);
        const [w, h] = this._hud.get_size();
        dash.setMaxSize(w, Math.round(h * DASH_HEIGHT));
        dash.showAppsButton.connectObject('notify::checked', () => {
            if (dash.showAppsButton.checked)
                Main.overview.showApps();
        }, this);
    }

    /** Back where the overview keeps it: before the overview shows, and whenever the canvas goes. */
    returnDash() {
        const b = this._borrowed;
        if (!b)
            return;
        this._borrowed = null;
        const dash = Main.overview.dash;
        dash.showAppsButton.disconnectObject(this);
        this._dashSlot.remove_child(dash);
        dash.set(b.props);
        b.parent.insert_child_at_index(dash, b.index);
    }

    setGeometry(monitorIndex, monitor, vp) {
        this._monitor = monitor;
        this.actor.set_position(monitor.x, monitor.y);
        this.actor.set_size(monitor.width, monitor.height);
        this.backdrop.setGeometry(monitorIndex, monitor);
        this._hud.set_position(vp.x - monitor.x, vp.y - monitor.y);
        this._hud.set_size(vp.w, vp.h);
        this.menuLayer.set_position(-monitor.x, -monitor.y);
    }

    setMinimapVisible(visible) {
        this.minimap.visible = visible;
    }

    /** Is the stage point over a widget that handles its own events (minimap, menu)? */
    isOverChrome(x, y) {
        const inside = actor => {
            if (!actor.visible || !actor.mapped)
                return false;
            const {origin, size} = actor.get_transformed_extents();
            return x >= origin.x && x < origin.x + size.width && y >= origin.y && y < origin.y + size.height;
        };
        if ([this.minimap, this.search, this._dashSlot].some(inside))
            return true;
        return this.menuLayer.get_children().some(inside);
    }

    /** Create/destroy previews so there is exactly one per record. */
    syncRecords(records) {
        const wanted = new Set(records.map(r => r.win));
        for (const [win, preview] of this._previews) {
            if (!wanted.has(win)) {
                preview.destroy();
                this._previews.delete(win);
            }
        }
        for (const rec of records) {
            if (!this._previews.has(rec.win)) {
                const preview = new WindowPreview(rec.win);
                this._previews.set(rec.win, preview);
                this._windowLayer.add_child(preview.actor);
            }
        }
        this.syncStacking();
    }

    syncStacking() {
        const wins = global.display.sort_windows_by_stacking([...this._previews.keys()]);
        for (const win of wins)
            this._windowLayer.set_child_above_sibling(this._previews.get(win).actor, null);
    }

    raise(win) {
        const preview = this._previews.get(win);
        if (preview)
            this._windowLayer.set_child_above_sibling(preview.actor, null);
    }

    updateTitle(win) {
        this._previews.get(win)?.updateTitle();
    }

    clear() {
        for (const preview of this._previews.values())
            preview.destroy();
        this._previews.clear();
        this.setGuides([]);
        this.menuLayer.destroy_all_children();
        this.endSearch();
        this.endFrameEdit(true);
    }

    setHovered(win) {
        for (const [w, preview] of this._previews)
            preview.setHovered(w === win);
    }

    pillHit(win, x, y) {
        return this._previews.get(win)?.pillHit(x, y) ?? null;
    }

    /** Alignment guides, in screen coordinates: pink lines while a drag is held by them. */
    setGuides(guides) {
        while (this._guides.length < guides.length) {
            const line = new St.Widget({style_class: 'skylight-guide'});
            this._guides.push(line);
            this._guideLayer.add_child(line);
        }
        const mon = this._monitor ?? {x: 0, y: 0};
        this._guides.forEach((line, i) => {
            const g = guides[i];
            line.visible = !!g;
            if (!g)
                return;
            const thick = g.kind === 'gap' ? 3 : 1.5;
            const x = Math.min(g.x1, g.x2), y = Math.min(g.y1, g.y2);
            const w = Math.max(Math.abs(g.x2 - g.x1), thick), h = Math.max(Math.abs(g.y2 - g.y1), thick);
            line.set_position(x - mon.x - (g.x1 === g.x2 ? thick / 2 : 0), y - mon.y - (g.y1 === g.y2 ? thick / 2 : 0));
            line.set_size(w, h);
        });
    }

    /** A short message at the top of the canvas (layout saved, restored…). */
    toast(text) {
        this._toast?.destroy();
        const label = new St.Label({style_class: 'skylight-toast', text});
        this._hud.add_child(label);
        label.set({x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.START});
        this._toast = label;
        label.ease({
            opacity: 0,
            delay: 1400,
            duration: 300,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                label.destroy();
                if (this._toast === label)
                    this._toast = null;
            },
        });
    }

    /** The Open Here… ring at a canvas point, gently pulsing; null fades it out. */
    setMark(point) {
        const ring = this._markRing;
        const was = this._mark;
        this._mark = point;
        if (!point === !was)
            return;
        ring.remove_all_transitions();
        if (point) {
            ring.set({visible: true, opacity: 0, scale_x: 1, scale_y: 1});
            ring.ease({opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            ring.ease({
                scale_x: 1.25,
                scale_y: 1.25,
                duration: 800,
                repeatCount: -1,
                autoReverse: true,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            });
        } else {
            ring.ease({
                opacity: 0,
                duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => ring.hide(),
            });
        }
    }

    /** A thin ring rippling out from a window's edges (screen rect) as it arrives. */
    ripple(win, rect) {
        this._previews.get(win)?.arrive();
        const mon = this._monitor;
        const ring = new St.Widget({style_class: 'skylight-ring'});
        ring.set_position(rect.x - mon.x, rect.y - mon.y);
        ring.set_size(rect.w, rect.h);
        this._guideLayer.add_child(ring);
        ring.ease({
            x: rect.x - mon.x - RING_REACH,
            y: rect.y - mon.y - RING_REACH,
            width: rect.w + 2 * RING_REACH,
            height: rect.h + 2 * RING_REACH,
            opacity: 0,
            duration: RING_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => ring.destroy(),
        });
    }

    sync(cam, vp, records) {
        const mon = this._monitor;
        const [ox, oy] = Geo.screenToCanvas(cam, vp, mon.x, mon.y);
        this.backdrop.update(ox, oy, cam.zoom);

        for (const [frame, v] of this._frameViews) {
            const [fx, fy] = Geo.canvasToScreen(cam, vp, frame.x, frame.y);
            v.box.set_position(Math.round(fx - mon.x), Math.round(fy - mon.y));
            v.box.set_size(Math.round(frame.w * cam.zoom), Math.round(frame.h * cam.zoom));
            if (v.title.text !== frame.name)
                v.title.text = frame.name;
            const [, titleH] = v.title.get_preferred_height(-1);
            v.title.set_position(Math.round(fx - mon.x), Math.round(fy - mon.y - titleH - FRAME_TITLE_GAP));
        }

        const atActual = Math.abs(cam.zoom - 1) < 1e-4;
        for (const rec of records) {
            const preview = this._previews.get(rec.win);
            if (!preview)
                continue;
            let sx, sy;
            if (atActual) {
                // Match the whole-pixel positions real windows get at 1:1.
                const r = Geo.liveRect(cam, vp, rec);
                sx = r.x;
                sy = r.y;
            } else {
                [sx, sy] = Geo.canvasToScreen(cam, vp, rec.x, rec.y);
            }
            preview.update(sx - mon.x, sy - mon.y, rec, cam.zoom);
        }

        if (this._mark) {
            const [mx, my] = Geo.canvasToScreen(cam, vp, this._mark.x, this._mark.y);
            this._markRing.set_position(Math.round(mx - mon.x - MARK_SIZE / 2), Math.round(my - mon.y - MARK_SIZE / 2));
        }

        this._zoomLabel.text = `${Math.round(cam.zoom * 100)}%`;
        const chrome = chromeFactor(cam.zoom);
        this._zoomLabel.opacity = Math.round(255 * chrome);
        // The search finds windows whatever stands in for the overview.
        this.search.visible = chrome > 0 || this.search.text !== '';
        this._dashSlot.visible = this._overviewChrome && chrome > 0;
        this.search.opacity = this.search.text ? 255 : Math.round(255 * chrome);
        this._dashSlot.opacity = Math.round(255 * chrome);
        if (this.minimap.visible)
            this.minimap.refresh();
    }

    destroy() {
        this.clear();
        this.returnDash();
        this.backdrop.destroy();
        this.actor.destroy();
    }
}
