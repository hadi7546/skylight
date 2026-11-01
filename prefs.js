import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Functions, not constants: gettext is only usable once the extension object exists.
const shortcuts = () => [
    ['toggle-canvas', _('See everything / back into the window you came from')],
    ['zoom-out', _('Zoom out')],
    ['zoom-in', _('Zoom in')],
    ['zoom-reset', _('Zoom to 1:1')],
    ['open-here', _('Open an app where you’re looking')],
    ['spotlight', _('Spotlight: search windows and apps on the canvas')],
    ['tidy-windows', _('Tidy every window')],
    ['toggle-strip', _('Strip mode on and off')],
    ['strip-left', _('Strip mode: the column on the left')],
    ['strip-right', _('Strip mode: the column on the right')],
    ['strip-up', _('Strip mode: the window above')],
    ['strip-down', _('Strip mode: the window below')],
    ['tile-left-half', _('Left half (again: two-thirds, a third)')],
    ['tile-right-half', _('Right half (again: two-thirds, a third)')],
    ['tile-top-half', _('Top half')],
    ['tile-bottom-half', _('Bottom half')],
    ['tile-top-left', _('Top left quarter')],
    ['tile-top-right', _('Top right quarter')],
    ['tile-bottom-left', _('Bottom left quarter')],
    ['tile-bottom-right', _('Bottom right quarter')],
    ['tile-left-third', _('Left third')],
    ['tile-center-third', _('Centre third')],
    ['tile-right-third', _('Right third')],
    ['tile-left-two-thirds', _('Left two-thirds')],
    ['tile-right-two-thirds', _('Right two-thirds')],
    ['tile-full', _('Fill the screen')],
    ['tile-center', _('Centre')],
];

const gestures = () => [
    [_('Pinch'), _('Zoom around your fingers: two fingers on the desktop or canvas, three anywhere')],
    [_('Super + scroll'), _('Zoom around the pointer, anywhere')],
    [_('Two-finger scroll or drag on the empty desktop'), _('Pan, with momentum')],
    [_('Four-finger tap'), _('See everything, and back into the window you came from')],
    [_('Four-finger swipe'), _('Pan the canvas from anywhere, over windows too')],
    [_('Click a window on the canvas'), _('Enter it where it is, growing to 1:1 around the click')],
    [_('Double-click or Return over a window'), _('Bring it to the middle and enter it')],
    [_('Pinch in over a window'), _('Enter it where it is')],
    [_('Drag a window'), _('Move it: guides line it up, the grid settles it. Ctrl moves freely, Shift takes its snapped group')],
    [_('Drag a window’s edge or corner'), _('Resize it')],
    [_('Double-click the empty canvas or desktop, or type on the canvas'), _('Open Here…: pick an app, and its window opens on that spot. Ctrl+Return opens it and goes in')],
    [_('Right-click'), _('Open Here…, New Frame, Strip Mode, Move &amp; Resize, Tidy, layouts…')],
    [_('Type on the canvas'), _('Find a window or a frame; Return goes into it, or searches apps when nothing matches')],
    [_('Drag a frame’s name'), _('Move it with the windows inside; double-click the name to go there')],
    [_('Ctrl+Z · Ctrl+S · Ctrl+1–9 on the canvas'), _('Undo · save a layout · restore one')],
    [_('Minimap'), _('Click to look there, drag the outline to pan, click a dashed outline to bring a minimised window back')],
];

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, lower, upper, step, digits = 0, subtitle = '') {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function entryRow(settings, key, title) {
    const row = new Adw.EntryRow({title, show_apply_button: true});
    row.text = settings.get_string(key);
    row.connect('apply', () => settings.set_string(key, row.text));
    return row;
}

function choiceRow(settings, key, title, choices, subtitle = '') {
    const model = new Gtk.StringList();
    for (const [, label] of choices)
        model.append(label);
    const row = new Adw.ComboRow({title, subtitle, model});
    const sync = () => {
        const i = choices.findIndex(([value]) => value === settings.get_string(key));
        row.selected = Math.max(0, i);
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const value = choices[row.selected]?.[0];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    return row;
}

function acceleratorLabel(accels) {
    if (!accels.length)
        return _('Disabled');
    const [ok, key, mods] = Gtk.accelerator_parse(accels[0]);
    return ok ? Gtk.accelerator_get_label(key, mods) : accels[0];
}

export default class SkylightPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage({title: _('Skylight'), icon_name: 'weather-clear-symbolic'});
        window.add(page);

        const background = new Adw.PreferencesGroup({title: _('Background')});
        page.add(background);
        background.add(choiceRow(settings, 'background', _('Behind the windows'), [
            ['wallpaper', _('Wallpaper')],
            ['grid', _('Dot grid')],
            ['colour', _('Colour')],
        ]));
        background.add(switchRow(settings, 'blur-on-zoom', _('Blur and dim as you zoom out'),
            _('Sharp at 100%, soft by 50%, so the overview is about the windows')));
        background.add(entryRow(settings, 'canvas-color', _('Canvas colour')));
        background.add(entryRow(settings, 'dot-color', _('Dot colour')));
        background.add(switchRow(settings, 'show-grid', _('Dots on the grid background')));

        const canvas = new Adw.PreferencesGroup({title: _('Canvas')});
        page.add(canvas);
        canvas.add(choiceRow(settings, 'launcher', _('Open Here… searches with'), [
            ['gnome', _('GNOME search')],
            ['skylight', _('Skylight’s app bar')],
        ]));
        canvas.add(choiceRow(settings, 'canvas-search', _('Canvas search'), [
            ['windows', _('Find windows')],
            ['apps', _('App launcher')],
            ['both', _('Windows and apps')],
        ], _('Ctrl+Space opens a spotlight in the middle of the view (type on the canvas does the same). Windows and apps are separate sections. A window is entered centred. An app opens in free space (or in the centre when “Open new apps in the centre” is on) and is entered when “Enter apps opened from the canvas” is on')));
        canvas.add(switchRow(settings, 'canvas-app-grid', _('Vertical app grid on the canvas'),
            _('Dash grid button and a second three-finger swipe up open a fast vertical scrolling grid instead of GNOME’s laggy overview apps view (after gnome-vertical-app-grid). Off uses the overview')));
        canvas.add(switchRow(settings, 'dash-enter', _('Enter apps opened from the canvas'),
            _('Dash, app grid, or search: go into the new window at 1:1. Off, it stays where it landed. An app already on the canvas is always entered centred. Dragging onto the canvas always places without entering')));
        canvas.add(switchRow(settings, 'centre-launch', _('Open new apps in the centre'),
            _('Off: a new app from the dash, app grid, or search opens in free space, beside its neighbours when the middle is taken. On: that launch is pinned on the centre of the view. An app already on the canvas is still entered centred')));
        canvas.add(switchRow(settings, 'strip-mode', _('Strip mode'),
            _('Every window on one horizontal strip, a column per app, the app used last on the left. Off again, every window goes back')));
        canvas.add(switchRow(settings, 'one-workspace', _('One workspace'),
            _('GNOME’s workspaces are turned off and every window is gathered onto one canvas, so the overview shows everything too. Turning it off brings your workspace settings back')));
        canvas.add(switchRow(settings, 'show-minimap', _('Minimap')));
        canvas.add(switchRow(settings, 'minimap-in-live-mode', _('Minimap at 1:1'),
            _('Off by default: the minimap shows on the canvas only. On, it also sits under your windows at 1:1')));
        canvas.add(switchRow(settings, 'remember-canvas', _('Remember the canvas'),
            _('Windows go back to their spots after you log in again')));
        canvas.add(switchRow(settings, 'place-in-free-space', _('New windows in free space')));
        canvas.add(switchRow(settings, 'follow-focus', _('Follow focus'),
            _('Glide to a window that gets focus while partly off screen')));
        canvas.add(spinRow(settings, 'scroll-speed', _('Panning speed'), 0.25, 4, 0.25, 2));
        canvas.add(switchRow(settings, 'replace-overview', _('The canvas in place of the overview'),
            _('Super, Activities, the hot corner and a three-finger swipe up show the canvas, with the dash. Search is the spotlight on the canvas')));
        canvas.add(switchRow(settings, 'four-finger-pan', _('Four-finger swipe pans the canvas'),
            _('From anywhere, over windows too. Three-finger swipes stay GNOME’s: the overview and the dash')));
        canvas.add(spinRow(settings, 'pinch-fingers', _('Fingers to pinch from anywhere'), 3, 4, 1));
        canvas.add(switchRow(settings, 'show-indicator', _('Top bar menu')));

        const windows = new Adw.PreferencesGroup({title: _('Windows')});
        page.add(windows);
        windows.add(choiceRow(settings, 'window-effect', _('Opening and closing'), [
            ['automatic', _('Automatic')],
            ['sunrise', _('Sunrise')],
            ['unfold', _('Unfold')],
            ['bloom', _('Bloom')],
            ['dissolve', _('Dissolve')],
            ['none', _('None')],
        ], _('On the canvas. Automatic: Open Here grows from the spot; others rise like sunrise. GNOME’s Reduce Animation turns every effect into a fade')));
        windows.add(switchRow(settings, 'snapping', _('Alignment guides'),
            _('Edges and centres line up with neighbours while you drag; hold Ctrl to move freely')));
        windows.add(spinRow(settings, 'grid-size', _('Drop grid'), 0, 200, 10, 0,
            _('Let go and a window settles onto it; 0 turns it off')));
        windows.add(spinRow(settings, 'tile-gap', _('Move &amp; Resize gap'), 0, 40, 2));

        const tidy = new Adw.PreferencesGroup({title: _('Tidy')});
        page.add(tidy);
        tidy.add(choiceRow(settings, 'tidy-style', _('Style'), [
            ['grid', _('Grid, keeping sizes')],
            ['mosaic', _('Mosaic, packed tight')],
        ]));
        tidy.add(choiceRow(settings, 'tidy-order', _('Order'), [
            ['position', _('Where they are')],
            ['recent', _('Most recent')],
            ['app', _('App')],
        ]));
        tidy.add(choiceRow(settings, 'tidy-spacing', _('Spacing'), [
            ['tight', _('Tight')],
            ['normal', _('Normal')],
            ['roomy', _('Roomy')],
        ]));
        tidy.add(spinRow(settings, 'tidy-columns', _('Columns'), 0, 6, 1, 0, _('0 for automatic')));

        const keys = new Adw.PreferencesGroup({
            title: _('Shortcuts'),
            description: _('Change these with dconf-editor under /org/gnome/shell/extensions/skylight/'),
        });
        page.add(keys);
        for (const [key, title] of shortcuts()) {
            const row = new Adw.ActionRow({title});
            const label = new Gtk.Label({
                label: acceleratorLabel(settings.get_strv(key)),
                css_classes: ['dim-label'],
            });
            row.add_suffix(label);
            settings.connect(`changed::${key}`, () => {
                label.label = acceleratorLabel(settings.get_strv(key));
            });
            keys.add(row);
        }

        const hands = new Adw.PreferencesGroup({title: _('Gestures and the canvas')});
        page.add(hands);
        for (const [title, subtitle] of gestures())
            hands.add(new Adw.ActionRow({title, subtitle}));
    }
}
