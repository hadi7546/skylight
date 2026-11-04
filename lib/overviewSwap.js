// The canvas in place of GNOME's window overview: everything that toggles
// the overview (Super, the Activities button, the hot corner) shows the
// canvas instead, and the three-finger swipe up is Skylight's (input.js).
// Show Apps (the dash button, Super+A, overview.show(APP_GRID)) opens
// Skylight's grid when canvas-app-grid is on — the button itself only
// flips `checked`, which does not call showApps().

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';

export class OverviewSwap {
    /**
     * @param {Gio.Settings} settings
     * @param {Controller} controller
     * @param {HoldSuper} holdSuper
     */
    constructor(settings, controller, holdSuper) {
        this._settings = settings;
        this._controller = controller;
        this._holdSuper = holdSuper;
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
        this._applyToggle();
        if (this._settings.get_boolean('replace-overview'))
            this._apply();
    }

    _applyToggle() {
        const controller = this._controller;
        const holdSuper = this._holdSuper;
        const replace = this._settings.get_boolean('replace-overview');
        // On the class, so turning it off leaves the overview as it was.
        this._injections.overrideMethod(Object.getPrototypeOf(Main.overview), 'toggle', toggle => function () {
            // Super let go after a hold: the jump already happened.
            if (controller.alive && holdSuper.consumeToggle())
                return;
            if (!replace || this.visible || !controller.alive)
                toggle.call(this);
            else
                controller.toggleCanvas();
        });
    }

    _apply() {
        const controller = this._controller;
        const settings = this._settings;
        const overview = Object.getPrototypeOf(Main.overview);
        // Activating a window asks the overview to close (Alt+Tab, a
        // notification, a dock): on the canvas, that means going into it.
        this._injections.overrideMethod(overview, 'hide', hide => function () {
            if (controller.alive && !this.visible && controller.mode === 'canvas')
                controller.leaveToFocused();
            else
                hide.call(this);
        });
        // Super+A / dash-to-dock / showApps() all land in show(APP_GRID).
        // The dash button itself does not: it only sets `checked`, which
        // canvasView suppresses while the dash is borrowed.
        this._injections.overrideMethod(overview, 'show', show => function (state) {
            if (controller.alive && settings.get_boolean('canvas-app-grid') &&
                state === OverviewControls.ControlsState.APP_GRID) {
                controller.showAppGridFromOverview();
                return;
            }
            return show.call(this, state);
        });
        this._injections.overrideMethod(overview, 'showApps', showApps => function () {
            if (controller.alive && settings.get_boolean('canvas-app-grid')) {
                controller.showAppGridFromOverview();
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
