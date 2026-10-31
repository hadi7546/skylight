// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

// The right-click menu on the canvas. It lives inside the canvas overlay,
// which holds the modal grab, rather than in uiGroup.

import GLib from 'gi://GLib';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export class CanvasMenu {
    /** @param {Clutter.Actor} layer - covers the stage, in stage coordinates */
    constructor(layer) {
        this._layer = layer;
        this._menu = null;
        this._anchor = null;
        this._idleId = 0;
    }

    get isOpen() {
        return this._menu?.isOpen ?? false;
    }

    /**
     * @param {number} x - stage coordinates
     * @param {number} y
     * @param {Array} items - {label, action}, {label, items: [...]} for a submenu, or null for a separator
     */
    open(x, y, items) {
        this.close();
        this._anchor = new St.Widget({width: 1, height: 1});
        this._layer.add_child(this._anchor);
        this._anchor.set_position(x, y);
        this._menu = new PopupMenu.PopupMenu(this._anchor, 0.0, St.Side.TOP);
        this._layer.add_child(this._menu.actor);
        this._fill(this._menu, items);
        this._menu.connect('open-state-changed', (menu, open) => {
            // Destroyed from an idle: the menu is still finishing its own close.
            if (!open && !this._idleId) {
                this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._idleId = 0;
                    this._destroyMenu();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
        this._menu.open();
    }

    _fill(menu, items) {
        for (const item of items) {
            if (!item) {
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            } else if (item.items) {
                const sub = new PopupMenu.PopupSubMenuMenuItem(item.label);
                this._fill(sub.menu, item.items);
                menu.addMenuItem(sub);
            } else {
                const entry = new PopupMenu.PopupMenuItem(item.label);
                entry.connect('activate', () => item.action());
                menu.addMenuItem(entry);
            }
        }
    }

    close() {
        if (this._menu?.isOpen)
            this._menu.close();
        else
            this._destroyMenu();
    }

    _destroyMenu() {
        this._menu?.destroy();
        this._anchor?.destroy();
        this._menu = null;
        this._anchor = null;
    }

    destroy() {
        if (this._idleId)
            GLib.Source.remove(this._idleId);
        this._idleId = 0;
        this._destroyMenu();
    }
}
