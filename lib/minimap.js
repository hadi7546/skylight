// The minimap in the bottom-right corner, the one thing that doesn't move:
// every window as a small shape with its app's icon in the middle, minimised
// windows as dashed outlines where they were, the screen as an outline, the
// zoom level, and buttons to fit everything or go to 1:1.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Geo from './geometry.js';

export const MAP_WIDTH = 180;
export const MAP_HEIGHT = 85;
const ICON_SIZE = 14;
const MIN_ICON_SIZE = 6;
const CLICK_SLOP = 3;

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

export const Minimap = GObject.registerClass(
class Minimap extends St.BoxLayout {
    /**
     * @param {object} controller - provides minimapState(), minimapLook(),
     *   minimapPan(), minimapRestore(), fitAll() and zoomToActual()
     */
    _init(controller) {
        super._init({style_class: 'skylight-minimap', reactive: true});
        this.orientation = Clutter.Orientation.VERTICAL;

        this._controller = controller;
        this._transform = null;
        this._frozen = null;
        this._grab = null;
        this._press = null;
        this._icons = new Map(); // Meta.Window → icon actor
        this._state = null;

        this._mapBox = new Clutter.Actor({width: MAP_WIDTH, height: MAP_HEIGHT, reactive: true});
        this._map = new St.DrawingArea({
            style_class: 'skylight-minimap-map',
            width: MAP_WIDTH,
            height: MAP_HEIGHT,
        });
        this._map.connect('repaint', () => this._repaint());
        this._mapBox.add_child(this._map);
        this._iconLayer = new Clutter.Actor();
        this._mapBox.add_child(this._iconLayer);
        this._mapBox.connect('button-press-event', (a, e) => this._onPress(e));
        this._mapBox.connect('motion-event', (a, e) => this._onMotion(e));
        this._mapBox.connect('button-release-event', (a, e) => this._onRelease(e));
        this.add_child(this._mapBox);

        const bar = new St.BoxLayout({style_class: 'skylight-minimap-bar'});
        this._zoomLabel = new St.Label({
            style_class: 'skylight-minimap-zoom',
            text: '100%',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        bar.add_child(this._zoomLabel);
        bar.add_child(this._makeButton('zoom-fit-best-symbolic', 'Fit all windows',
            () => this._controller.fitAll()));
        bar.add_child(this._makeButton('zoom-original-symbolic', 'Zoom to 1:1',
            () => this._controller.zoomToActual()));
        this.add_child(bar);

        // Not a vfunc_unmap override: GJS 1.90 (GNOME 51) aborts if a JS
        // vfunc runs while the shell is disposing actors at shutdown.
        this.connect('destroy', () => this._endPress());
    }

    _makeButton(iconName, accessibleName, callback) {
        const button = new St.Button({
            style_class: 'skylight-minimap-button',
            accessible_name: accessibleName,
            can_focus: true,
            child: new St.Icon({icon_name: iconName, style_class: 'skylight-minimap-icon'}),
        });
        button.connect('clicked', callback);
        return button;
    }

    refresh() {
        this._state = this._controller.minimapState();
        this._zoomLabel.text = `${Math.round(this._state.zoom * 100)}%`;
        if (!this._frozen)
            this._computeTransform();
        this._syncIcons();
        this._map.queue_repaint();
    }

    _computeTransform() {
        const {windows, view} = this._state;
        const bounds = Geo.union([...windows.map(w => w.rect), view]);
        const pad = 6;
        const s = Math.min((MAP_WIDTH - 2 * pad) / Math.max(bounds.w, 1),
            (MAP_HEIGHT - 2 * pad) / Math.max(bounds.h, 1));
        this._transform = {
            scale: s,
            ox: (MAP_WIDTH - bounds.w * s) / 2 - bounds.x * s,
            oy: (MAP_HEIGHT - bounds.h * s) / 2 - bounds.y * s,
        };
    }

    _map2(r) {
        const {scale, ox, oy} = this._transform;
        return {x: r.x * scale + ox, y: r.y * scale + oy, w: Math.max(r.w * scale, 2), h: Math.max(r.h * scale, 2)};
    }

    _syncIcons() {
        const seen = new Set();
        for (const w of this._state.windows) {
            seen.add(w.win);
            let icon = this._icons.get(w.win);
            if (!icon) {
                icon = w.app?.create_icon_texture(ICON_SIZE) ??
                    new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: ICON_SIZE});
                this._icons.set(w.win, icon);
                this._iconLayer.add_child(icon);
            }
            const m = this._map2(w.rect);
            const size = Math.round(Geo.clamp(Math.min(m.w, m.h) * 0.6, MIN_ICON_SIZE, ICON_SIZE));
            icon.set_size(size, size);
            icon.set_position(Math.round(m.x + m.w / 2 - size / 2), Math.round(m.y + m.h / 2 - size / 2));
            icon.opacity = w.away ? 140 : 255;
            icon.visible = m.w >= MIN_ICON_SIZE && m.h >= MIN_ICON_SIZE;
        }
        for (const [win, icon] of this._icons) {
            if (!seen.has(win)) {
                icon.destroy();
                this._icons.delete(win);
            }
        }
    }

    _repaint() {
        const cr = this._map.get_context();
        if (!this._state || !this._transform) {
            cr.$dispose();
            return;
        }
        for (const w of this._state.windows) {
            const m = this._map2(w.rect);
            if (w.away) {
                roundedRect(cr, m.x + 0.5, m.y + 0.5, m.w - 1, m.h - 1, 2);
                cr.setDash([3, 2], 0);
                cr.setSourceRGBA(1, 1, 1, 0.6);
                cr.setLineWidth(1);
                cr.stroke();
                cr.setDash([], 0);
            } else {
                roundedRect(cr, m.x, m.y, m.w, m.h, 2);
                cr.setSourceRGBA(1, 1, 1, w.focused ? 0.55 : 0.35);
                cr.fill();
            }
        }
        const v = this._map2(this._state.view);
        roundedRect(cr, v.x + 0.5, v.y + 0.5, v.w - 1, v.h - 1, 2);
        cr.setSourceRGBA(1, 1, 1, 0.06);
        cr.fillPreserve();
        cr.setSourceRGBA(1, 1, 1, 0.92);
        cr.setLineWidth(1.25);
        cr.stroke();
        cr.$dispose();
    }

    _toCanvas(event) {
        if (!this._transform)
            return null;
        const [sx, sy] = event.get_coords();
        const [ok, lx, ly] = this._mapBox.transform_stage_point(sx, sy);
        if (!ok)
            return null;
        const {scale, ox, oy} = this._transform;
        return {x: (lx - ox) / scale, y: (ly - oy) / scale, lx, ly, sx, sy};
    }

    _awayAt(p) {
        for (const w of this._state.windows) {
            if (!w.away)
                continue;
            const m = this._map2(w.rect);
            if (p.lx >= m.x && p.lx <= m.x + m.w && p.ly >= m.y && p.ly <= m.y + m.h)
                return w.win;
        }
        return null;
    }

    _onPress(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const p = this._toCanvas(event);
        if (!p)
            return Clutter.EVENT_PROPAGATE;
        this._grab = global.stage.grab(this._mapBox);
        this._frozen = this._transform;
        this._press = {p, last: p, dragged: false, away: this._awayAt(p)};
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._press)
            return Clutter.EVENT_PROPAGATE;
        const p = this._toCanvas(event);
        if (!p)
            return Clutter.EVENT_STOP;
        const d = this._press;
        if (!d.dragged && Math.hypot(p.sx - d.p.sx, p.sy - d.p.sy) > CLICK_SLOP)
            d.dragged = true;
        if (d.dragged) {
            // Dragging moves the outline: the camera follows the pointer's travel.
            this._controller.minimapPan(p.x - d.last.x, p.y - d.last.y);
            d.last = p;
        }
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        if (!this._press)
            return Clutter.EVENT_PROPAGATE;
        const d = this._press;
        const p = this._toCanvas(event) ?? d.last;
        this._endPress();
        if (!d.dragged) {
            if (d.away)
                this._controller.minimapRestore(d.away);
            else
                this._controller.minimapLook(p.x, p.y);
        } else {
            this._controller.minimapPanEnd();
        }
        return Clutter.EVENT_STOP;
    }

    _endPress() {
        this._grab?.dismiss();
        this._grab = null;
        this._press = null;
        this._frozen = null;
    }

});
