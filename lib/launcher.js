// Open Here…: a search bar to pick an app.
// Type to filter, ↑↓ to pick, Return to open, Ctrl+Return to open and go into
// it, Esc or a click elsewhere to dismiss. The controller does the opening.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {noteLaunch, search} from './appMatch.js';

const WIDTH = 560;
const MAX_ROWS = 8;
const ICON_SIZE = 28;

/** Every app the app grid shows, alphabetically, with what else it can be found by. */
export function installedApps() {
    const appSystem = Shell.AppSystem.get_default();
    const apps = [];
    for (const info of appSystem.get_installed()) {
        const app = info.should_show() ? appSystem.lookup_app(info.get_id()) : null;
        if (!app)
            continue;
        const executable = info.get_executable();
        const terms = [info.get_generic_name(), ...info.get_keywords() ?? [],
            executable ? GLib.path_get_basename(executable) : null];
        apps.push({id: app.get_id(), name: app.get_name(), terms: terms.filter(Boolean), app});
    }
    return apps.sort((a, b) => a.name.localeCompare(b.name));
}

export class Launcher {
    /** @param {Gio.Settings} settings - keeps the recents */
    constructor(settings) {
        this._settings = settings;
        this._actor = null;
    }

    get isOpen() {
        return this._actor !== null;
    }

    /**
     * @param {object} params
     * @param {string} params.text - typed already (type-to-open on the canvas)
     * @param {Function} params.onOpen - (Shell.App, enter) once one is picked
     * @param {Function} params.onClose - gone, picked or not
     */
    open({text = '', onOpen, onClose}) {
        this.close();
        this._onOpen = onOpen;
        this._onClose = onClose;
        this._apps = installedApps();
        this._results = [];
        this._rows = [];
        this._selected = 0;
        this._offset = 0;
        this._scrollRest = 0;

        // Covers the stage: a click anywhere but the bar dismisses it.
        this._actor = new St.Widget({reactive: true, width: global.stage.width, height: global.stage.height});
        Main.layoutManager.uiGroup.add_child(this._actor);
        this._card = new St.BoxLayout({style_class: 'skylight-launcher', width: WIDTH});
        this._card.orientation = Clutter.Orientation.VERTICAL;
        this._entry = new St.Entry({
            style_class: 'skylight-launcher-entry',
            hint_text: 'Open an app here…',
            can_focus: true,
            x_expand: true,
            text,
        });
        this._list = new St.BoxLayout({style_class: 'skylight-launcher-list'});
        this._list.orientation = Clutter.Orientation.VERTICAL;
        this._card.add_child(this._entry);
        this._card.add_child(this._list);
        this._actor.add_child(this._card);
        const mon = Main.layoutManager.primaryMonitor;
        this._card.set_position(Math.round(mon.x + (mon.width - WIDTH) / 2), Math.round(mon.y + mon.height * 0.2));

        this._actor.connect('button-press-event', (a, event) => {
            if (!this._card.contains(global.stage.get_event_actor(event)))
                this.close();
            return Clutter.EVENT_STOP;
        });
        this._actor.connect('scroll-event', (a, event) => this._onScroll(event));
        // Keys are taken on the way down: from 51 the entry's own
        // key-press-event never sees them.
        this._actor.connect('captured-event', (a, event) =>
            event.type() === Clutter.EventType.KEY_PRESS ? this._onKey(event) : Clutter.EVENT_PROPAGATE);
        this._entry.clutter_text.connect('text-changed', () => this._refresh());

        this._grab = Main.pushModal(this._actor, {actionMode: Shell.ActionMode.POPUP});
        global.stage.set_key_focus(this._entry.clutter_text);
        this._entry.clutter_text.set_cursor_position(-1);
        this._refresh();

        this._card.set({opacity: 0, scale_x: 0.97, scale_y: 0.97, pivot_point: new Graphene.Point({x: 0.5, y: 0})});
        this._card.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    close() {
        if (!this._actor)
            return;
        Main.popModal(this._grab);
        this._grab = null;
        this._actor.destroy();
        this._actor = null;
        this._rows = [];
        const onClose = this._onClose;
        this._onOpen = this._onClose = null;
        onClose?.();
    }

    destroy() {
        this.close();
    }

    // -----------------------------------------------------------------------
    // Results

    _refresh() {
        this._results = search(this._apps, this._entry.text, this._settings.get_strv('launcher-recents'));
        this._selected = 0;
        this._offset = 0;
        this._render();
    }

    /** The rows from `_offset`, at most MAX_ROWS of them. */
    _render() {
        this._list.destroy_all_children();
        this._rows = [];
        if (this._results.length === 0) {
            this._list.add_child(new St.Label({style_class: 'skylight-launcher-empty', text: 'No apps match'}));
            return;
        }
        const end = Math.min(this._results.length, this._offset + MAX_ROWS);
        for (let i = this._offset; i < end; i++) {
            const {app, name} = this._results[i];
            const row = new St.BoxLayout({style_class: 'skylight-launcher-row', reactive: true});
            row.add_child(app.create_icon_texture(ICON_SIZE));
            row.add_child(new St.Label({style_class: 'skylight-launcher-name', text: name, y_align: Clutter.ActorAlign.CENTER}));
            if (app.get_state() === Shell.AppState.RUNNING)
                row.add_child(new St.Label({style_class: 'skylight-launcher-note', text: 'Running', y_align: Clutter.ActorAlign.CENTER}));
            row.connect('motion-event', () => {
                if (this._selected !== i)
                    this._select(i);
                return Clutter.EVENT_PROPAGATE;
            });
            row.connect('button-release-event', (r, event) => {
                this._select(i);
                this._openSelected((event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0);
                return Clutter.EVENT_STOP;
            });
            this._list.add_child(row);
            this._rows.push(row);
        }
        this._rows[this._selected - this._offset]?.add_style_pseudo_class('selected');
    }

    /** Picks row `i`, scrolling the list just enough to show it. */
    _select(i) {
        this._rows[this._selected - this._offset]?.remove_style_pseudo_class('selected');
        this._selected = i;
        const offset = Math.min(Math.max(this._offset, i - MAX_ROWS + 1), i);
        if (offset !== this._offset) {
            this._offset = offset;
            this._render();
        } else {
            this._rows[i - this._offset].add_style_pseudo_class('selected');
        }
    }

    _move(delta) {
        const n = this._results.length;
        if (n > 0)
            this._select((this._selected + delta + n) % n);
    }

    _openSelected(enter) {
        const picked = this._results[this._selected];
        if (!picked)
            return;
        this._settings.set_strv('launcher-recents', noteLaunch(this._settings.get_strv('launcher-recents'), picked.id));
        const onOpen = this._onOpen;
        this.close();
        onOpen(picked.app, enter);
    }

    // -----------------------------------------------------------------------
    // Input

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
        case Clutter.KEY_Up:
        case Clutter.KEY_ISO_Left_Tab:
            this._move(-1);
            break;
        case Clutter.KEY_Down:
        case Clutter.KEY_Tab:
            this._move(1);
            break;
        case Clutter.KEY_Page_Up:
            this._select(Math.max(0, this._selected - MAX_ROWS));
            break;
        case Clutter.KEY_Page_Down:
            this._select(Math.max(0, Math.min(this._results.length - 1, this._selected + MAX_ROWS)));
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    /** Scrolling over the list moves it a row at a time, keeping the pick in view. */
    _onScroll(event) {
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        let steps = 0;
        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.UP)
            steps = -1;
        else if (dir === Clutter.ScrollDirection.DOWN)
            steps = 1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            this._scrollRest += event.get_scroll_delta()[1];
            steps = Math.trunc(this._scrollRest);
            this._scrollRest -= steps;
        }
        const max = Math.max(0, this._results.length - MAX_ROWS);
        const offset = Math.min(max, Math.max(0, this._offset + steps));
        if (offset !== this._offset) {
            this._offset = offset;
            this._selected = Math.min(Math.max(this._selected, offset), offset + MAX_ROWS - 1);
            this._render();
        }
        return Clutter.EVENT_STOP;
    }
}
