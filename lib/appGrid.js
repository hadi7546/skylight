// Vertical app grid on the canvas: a fast stand-in for GNOME's overview
// showApps(), after https://github.com/lublst/gnome-vertical-app-grid — scroll
// instead of page flips, so opening the grid doesn't wait on overview chrome.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import {noteLaunch, search} from './appMatch.js';
import {installedApps} from './launcher.js';

const ICON_SIZE = 64;
const COLUMNS = 6;
const OPEN_MS = 120;

export class AppGrid {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._actor = null;
        this._grab = null;
        this._onOpen = null;
        this._onClose = null;
        this._apps = [];
        this._cells = [];
        this._selected = 0;
    }

    get isOpen() {
        return this._actor !== null;
    }

    /**
     * @param {object} params
     * @param {Function} params.onOpen - (Shell.App, enter)
     * @param {Function} params.onClose
     * @returns {boolean} false if the grid could not be shown (caller should fall back)
     */
    open({onOpen, onClose}) {
        this.close();
        this._onOpen = onOpen;
        this._onClose = onClose;

        try {
            this._apps = installedApps();
            this._selected = 0;

            const mon = Main.layoutManager.primaryMonitor;
            if (!mon)
                throw new Error('no primary monitor');

            // Full-stage reactive cover. The style class dims the canvas so a
            // failed/empty card can never leave an invisible input sink.
            this._actor = new St.Widget({
                style_class: 'skylight-app-grid',
                reactive: true,
                width: global.stage.width,
                height: global.stage.height,
            });
            Main.layoutManager.uiGroup.add_child(this._actor);

            this._card = new St.BoxLayout({style_class: 'skylight-app-grid-card'});
            this._card.orientation = Clutter.Orientation.VERTICAL;

            this._entry = new St.Entry({
                style_class: 'skylight-app-grid-entry',
                hint_text: 'Search apps…',
                can_focus: true,
                x_expand: true,
            });
            this._scroll = new St.ScrollView({
                style_class: 'skylight-app-grid-scroll',
                x_expand: true,
                y_expand: true,
                overlay_scrollbars: true,
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
            });
            this._grid = new St.Widget({
                style_class: 'skylight-app-grid-icons',
                layout_manager: new Clutter.GridLayout({
                    orientation: Clutter.Orientation.VERTICAL,
                    column_homogeneous: true,
                    row_homogeneous: true,
                }),
                x_expand: true,
            });
            // GNOME 45+: ScrollView.set_child; older shells used add_actor.
            if (this._scroll.set_child)
                this._scroll.set_child(this._grid);
            else
                this._scroll.add_actor(this._grid);
            this._card.add_child(this._entry);
            this._card.add_child(this._scroll);
            this._actor.add_child(this._card);

            const w = Math.min(Math.round(mon.width * 0.72), 920);
            const h = Math.min(Math.round(mon.height * 0.78), 720);
            this._card.set_size(w, h);
            this._card.set_position(
                Math.round(mon.x + (mon.width - w) / 2),
                Math.round(mon.y + (mon.height - h) / 2));

            this._actor.connect('button-press-event', (a, event) => {
                if (!this._card.contains(global.stage.get_event_actor(event)))
                    this.close();
                return Clutter.EVENT_STOP;
            });
            this._actor.connect('captured-event', (a, event) =>
                event.type() === Clutter.EventType.KEY_PRESS ? this._onKey(event) : Clutter.EVENT_PROPAGATE);
            this._entry.clutter_text.connect('text-changed', () => this._refresh());

            // Canvas already holds Main.pushModal(global.stage). A nested
            // pushModal on this transparent cover steals the seat; if the card
            // never paints (or the nested grab is broken), the desktop looks
            // frozen with nothing to dismiss. Reuse the existing modal when
            // one is already up; only grab when we are the first.
            if (Main.modalCount === 0) {
                const grab = Main.pushModal(this._actor, {actionMode: Shell.ActionMode.POPUP});
                if (grab.get_seat_state() !== Clutter.GrabState.ALL) {
                    Main.popModal(grab);
                    throw new Error('app grid grab failed');
                }
                this._grab = grab;
            } else {
                this._grab = null;
            }

            global.stage.set_key_focus(this._entry.clutter_text);
            this._refresh();

            this._card.set({
                opacity: 0, scale_x: 0.97, scale_y: 0.97,
                pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            });
            this._card.ease({
                opacity: 255, scale_x: 1, scale_y: 1,
                duration: OPEN_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return true;
        } catch (e) {
            console.error('Skylight: app grid failed to open', e);
            this._teardown(false);
            return false;
        }
    }

    close() {
        if (!this._actor)
            return;
        this._teardown(true);
    }

    /**
     * Tear down the overlay. When `notify` is true, run onClose (user dismiss).
     * Failures during open use notify=false so the caller can fall back cleanly.
     */
    _teardown(notify) {
        const grab = this._grab;
        this._grab = null;
        if (grab) {
            try {
                Main.popModal(grab);
            } catch (e) {
                console.error('Skylight: app grid popModal', e);
            }
        }
        const actor = this._actor;
        this._actor = null;
        this._cells = [];
        if (actor) {
            try {
                actor.destroy();
            } catch (e) {
                console.error('Skylight: app grid destroy', e);
            }
        }
        const onClose = this._onClose;
        this._onOpen = this._onClose = null;
        if (notify)
            onClose?.();
    }

    destroy() {
        this.close();
    }

    _refresh() {
        const favs = AppFavorites.getAppFavorites();
        const favIds = new Set(favs.getFavorites().map(a => a.get_id()));
        const query = this._entry.text;
        let list = search(this._apps, query, this._settings.get_strv('launcher-recents'), 200);
        // Favorites first when the query is empty (vertical-app-grid style).
        if (!query.trim()) {
            const fav = list.filter(a => favIds.has(a.id));
            const rest = list.filter(a => !favIds.has(a.id));
            list = [...fav, ...rest];
        }
        this._results = list;
        this._selected = 0;
        this._render();
    }

    _render() {
        this._grid.destroy_all_children();
        this._cells = [];
        const layout = this._grid.layout_manager;
        const n = this._results.length;
        if (n === 0) {
            this._grid.add_child(new St.Label({
                style_class: 'skylight-app-grid-empty',
                text: 'No apps match',
            }));
            return;
        }
        for (let i = 0; i < n; i++) {
            const {app, name} = this._results[i];
            const cell = new St.Button({
                style_class: 'skylight-app-grid-cell',
                can_focus: true,
                track_hover: true,
            });
            const box = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
            box.orientation = Clutter.Orientation.VERTICAL;
            box.add_child(app.create_icon_texture(ICON_SIZE));
            const label = new St.Label({
                style_class: 'skylight-app-grid-label',
                text: name,
                x_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(label);
            cell.set_child(box);
            const index = i;
            cell.connect('clicked', () => {
                this._selected = index;
                this._openSelected(false);
            });
            layout.attach(cell, i % COLUMNS, Math.floor(i / COLUMNS), 1, 1);
            this._cells.push(cell);
        }
        this._highlight();
    }

    _highlight() {
        for (let i = 0; i < this._cells.length; i++) {
            if (i === this._selected)
                this._cells[i].add_style_pseudo_class('selected');
            else
                this._cells[i].remove_style_pseudo_class('selected');
        }
        const cell = this._cells[this._selected];
        const adj = this._scroll.vadjustment ?? this._scroll.vscroll?.adjustment;
        if (cell && adj)
            adj.clamp_page(cell.y, cell.y + cell.height);
    }

    _move(dx, dy) {
        const n = this._results.length;
        if (n === 0)
            return;
        const cols = COLUMNS;
        const row = Math.floor(this._selected / cols);
        const col = this._selected % cols;
        const rows = Math.ceil(n / cols);
        let r = row + dy, c = col + dx;
        if (dx !== 0) {
            c = (col + dx + cols) % cols;
            if (r * cols + c >= n)
                c = Math.min(col, (n - 1) % cols);
        }
        if (dy !== 0) {
            r = Math.min(rows - 1, Math.max(0, r));
            while (r * cols + c >= n && c > 0)
                c--;
            if (r * cols + c >= n)
                r = Math.max(0, r - 1);
        }
        this._selected = Math.min(n - 1, Math.max(0, r * cols + c));
        this._highlight();
    }

    _openSelected(enter) {
        const picked = this._results[this._selected];
        if (!picked)
            return;
        this._settings.set_strv('launcher-recents',
            noteLaunch(this._settings.get_strv('launcher-recents'), picked.id));
        const onOpen = this._onOpen;
        this.close();
        onOpen?.(picked.app, enter);
    }

    _onKey(event) {
        const sym = event.get_key_symbol();
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        switch (sym) {
        case Clutter.KEY_Escape:
            this.close();
            break;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._openSelected(ctrl);
            break;
        case Clutter.KEY_Left:
            this._move(-1, 0);
            break;
        case Clutter.KEY_Right:
            this._move(1, 0);
            break;
        case Clutter.KEY_Up:
            this._move(0, -1);
            break;
        case Clutter.KEY_Down:
            this._move(0, 1);
            break;
        case Clutter.KEY_Page_Up:
            this._move(0, -3);
            break;
        case Clutter.KEY_Page_Down:
            this._move(0, 3);
            break;
        case Clutter.KEY_Home:
            this._selected = 0;
            this._highlight();
            break;
        case Clutter.KEY_End:
            this._selected = Math.max(0, this._results.length - 1);
            this._highlight();
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }
}
