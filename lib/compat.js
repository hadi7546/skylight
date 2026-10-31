// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

// The few places GNOME Shell 45–51 differ in what Skylight uses.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

// Cursors: Meta.Cursor + global.display.set_cursor() until 50,
// Clutter.CursorType + actor.set_cursor_type() from 51.
const CURSOR_NAMES = {
    default: ['DEFAULT', 'DEFAULT'],
    move: ['MOVE', 'MOVE_OR_RESIZE_WINDOW'],
    n: ['N_RESIZE', 'NORTH_RESIZE'],
    s: ['S_RESIZE', 'SOUTH_RESIZE'],
    e: ['E_RESIZE', 'EAST_RESIZE'],
    w: ['W_RESIZE', 'WEST_RESIZE'],
    ne: ['NE_RESIZE', 'NE_RESIZE'],
    nw: ['NW_RESIZE', 'NW_RESIZE'],
    se: ['SE_RESIZE', 'SE_RESIZE'],
    sw: ['SW_RESIZE', 'SW_RESIZE'],
};

export function setCursor(actor, kind) {
    const [modern, legacy] = CURSOR_NAMES[kind] ?? CURSOR_NAMES.default;
    if (Clutter.CursorType)
        actor.set_cursor_type(Clutter.CursorType[modern]);
    else
        global.display.set_cursor(Meta.Cursor[legacy] ?? Meta.Cursor[modern]);
}

/** The cursor name for a set of resize edges. */
export function resizeCursor(edges) {
    if (!edges)
        return 'default';
    const v = edges.top ? 'n' : edges.bottom ? 's' : '';
    const h = edges.left ? 'w' : edges.right ? 'e' : '';
    return v + h || 'default';
}

// Maximisation: get_maximized() went away in 49, and maximize()/unmaximize()
// lost their MaximizeFlags argument.
const LEGACY_MAXIMIZE = 'get_maximized' in Meta.Window.prototype;

export function isMaximized(win) {
    return LEGACY_MAXIMIZE ? win.get_maximized() !== 0 : win.get_maximize_flags() !== 0;
}

export function unmaximize(win) {
    if (!isMaximized(win))
        return;
    if (LEGACY_MAXIMIZE)
        win.unmaximize(Meta.MaximizeFlags.BOTH);
    else
        win.unmaximize();
}

// St.BoxLayout lost its `vertical` property in 51 (deprecated in 48).
export function makeVertical(box) {
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
}
