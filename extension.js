// Skylight: an infinite-canvas window manager for GNOME Shell.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Controller} from './lib/controller.js';
import {OneWorkspace} from './lib/oneWorkspace.js';
import {OverviewSwap} from './lib/overviewSwap.js';

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension, settings, controller) {
        super._init(0.0, 'Skylight');
        this._extension = extension;
        this._settings = settings;
        this._controller = controller;
        this.add_child(new St.Icon({
            icon_name: 'weather-clear-symbolic',
            style_class: 'system-status-icon',
        }));
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._rebuild();
        });
        this._rebuild();
    }

    _rebuild() {
        const controller = this._controller;
        this.menu.removeAll();
        const add = (label, callback) => {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', callback);
            this.menu.addMenuItem(item);
        };
        add(_('Open App…'), () => controller.openHere());
        add(_('See Everything'), () => controller.fitAll());
        add(_('Tidy'), () => controller.tidy());
        for (const [key, label] of [
            ['strip-mode', _('Strip Mode')],
            ['one-workspace', _('One Workspace')],
            ['centre-launch', _('Centre Launch')],
        ]) {
            const item = new PopupMenu.PopupSwitchMenuItem(label, this._settings.get_boolean(key));
            item.connect('toggled', (i, state) => this._settings.set_boolean(key, state));
            this.menu.addMenuItem(item);
        }
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Layouts')));
        add(_('Save Layout'), () => controller.saveLayout());
        controller.layouts().forEach((layout, i) => {
            if (layout)
                add(layout.name, () => controller.restoreLayout(i));
        });
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        add(_('Settings'), () => this._extension.openPreferences());
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        add(_('Disable'), () => {
            const uuid = this._extension.uuid;
            this.menu.close();
            // disable() destroys this menu, so run it after the close.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                Main.extensionManager.disableExtension(uuid);
                return GLib.SOURCE_REMOVE;
            });
        });
    }
});

export default class SkylightExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._controller = new Controller(this);
        this._controller.enable();
        this._oneWorkspace = new OneWorkspace(this._settings, this._controller);
        this._oneWorkspace.enable();
        this._overviewSwap = new OverviewSwap(this._settings, this._controller);
        this._overviewSwap.enable();

        this._settings.connectObject('changed::show-indicator', () => this._syncIndicator(), this);
        this._syncIndicator();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._indicator?.destroy();
        this._indicator = null;
        this._overviewSwap.disable();
        this._overviewSwap = null;
        this._oneWorkspace.disable();
        this._oneWorkspace = null;
        this._controller.disable();
        this._controller = null;
        this._settings = null;
    }

    _syncIndicator() {
        const show = this._settings.get_boolean('show-indicator');
        if (show && !this._indicator) {
            this._indicator = new Indicator(this, this._settings, this._controller);
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } else if (!show && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
