// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

// One workspace: GNOME's workspaces turned off and every window gathered onto
// one canvas, so the canvas and the GNOME overview both show everything.
// GNOME's own workspace settings are kept in `saved-workspaces` (so they
// survive a crash or a logout) and put back when the mode, or the
// extension, is turned off.

import Gio from 'gi://Gio';

export class OneWorkspace {
    /**
     * @param {Gio.Settings} settings - Skylight's
     * @param {Controller} controller
     */
    constructor(settings, controller) {
        this._settings = settings;
        this._controller = controller;
    }

    enable() {
        this._mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        this._settings.connectObject('changed::one-workspace', () => this._sync(true), this);
        this._sync(false);
    }

    disable() {
        this._settings.disconnectObject(this);
        this._restore();
        this._mutter = null;
        this._wm = null;
    }

    /** @param {boolean} toggled - just switched on: show the gathered canvas */
    _sync(toggled) {
        if (this._settings.get_boolean('one-workspace'))
            this._apply(toggled);
        else
            this._restore();
    }

    _apply(toggled) {
        if (!this._settings.get_string('saved-workspaces')) {
            this._settings.set_string('saved-workspaces', JSON.stringify({
                dynamic: this._mutter.get_boolean('dynamic-workspaces'),
                count: this._wm.get_int('num-workspaces'),
            }));
        }
        this._controller.gatherWorkspaces(toggled);
        // The count first: it only counts once workspaces are static, and
        // the other order would briefly make the default four.
        this._wm.set_int('num-workspaces', 1);
        this._mutter.set_boolean('dynamic-workspaces', false);
    }

    _restore() {
        const saved = this._settings.get_string('saved-workspaces');
        if (!saved)
            return;
        const {dynamic, count} = JSON.parse(saved);
        this._wm.set_int('num-workspaces', count);
        this._mutter.set_boolean('dynamic-workspaces', dynamic);
        this._settings.set_string('saved-workspaces', '');
    }
}
