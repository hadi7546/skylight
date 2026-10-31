// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

// The canvas in place of GNOME's window overview: everything that toggles
// the overview (Super, the Activities button, the hot corner) shows the
// canvas instead, and the three-finger swipe up is Skylight's (input.js).
// GNOME's overview stays for search and the app grid.

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class OverviewSwap {
    /**
     * @param {Gio.Settings} settings
     * @param {Controller} controller
     */
    constructor(settings, controller) {
        this._settings = settings;
        this._controller = controller;
        this._injections = new InjectionManager();
    }

    enable() {
        this._settings.connectObject('changed::replace-overview', () => this._sync(), this);
        this._sync();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._restore();
    }

    _sync() {
        this._restore();
        if (this._settings.get_boolean('replace-overview'))
            this._apply();
    }

    _apply() {
        const controller = this._controller;
        const settings = this._settings;
        // On the class, so turning it off leaves the overview as it was.
        const overview = Object.getPrototypeOf(Main.overview);
        this._injections.overrideMethod(overview, 'toggle', toggle => function () {
            if (this.visible)
                toggle.call(this);
            else
                controller.toggleCanvas();
        });
        // Activating a window asks the overview to close (Alt+Tab, a
        // notification, a dock): on the canvas, that means going into it.
        this._injections.overrideMethod(overview, 'hide', hide => function () {
            if (!this.visible && controller.mode === 'canvas')
                controller.leaveToFocused();
            else
                hide.call(this);
        });
        // Super+A / dash App List / showApps(): Skylight's grid, never flash
        // GNOME's overview as a bridge when canvas-app-grid is on.
        this._injections.overrideMethod(overview, 'showApps', showApps => function () {
            if (settings.get_boolean('canvas-app-grid')) {
                controller.showAppGrid();
                return;
            }
            return showApps.call(this);
        });
        Main.overview._swipeTracker.enabled = false;
    }

    _restore() {
        this._injections.clear();
        Main.overview._swipeTracker.enabled = true;
    }
}
