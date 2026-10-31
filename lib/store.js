// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

// What Skylight keeps in GSettings: where every window was on the canvas
// (so a new session puts them back), and named layouts.

import GLib from 'gi://GLib';

import {matchWindows} from './geometry.js';

const SAVE_DELAY_MS = 2000;
const REMEMBER_MS = 120000; // windows reopening this soon after login find their spot
const LAYOUT_WAIT_MS = 12000; // windows a layout reopened take their spot
export const LAYOUT_SLOTS = 9;

const now = () => GLib.get_monotonic_time() / 1000;

function parse(text, fallback) {
    try {
        return JSON.parse(text || 'null') ?? fallback;
    } catch {
        return fallback;
    }
}

export class CanvasStore {
    constructor(settings) {
        this._settings = settings;
        this._saveTimeout = 0;
        this._remembered = {entries: [], until: 0};
        this._expected = {entries: [], until: 0};
    }

    destroy() {
        if (this._saveTimeout)
            GLib.Source.remove(this._saveTimeout);
        this._saveTimeout = 0;
    }

    get _enabled() {
        return this._settings.get_boolean('remember-canvas');
    }

    /** Save soon; `collect()` returns {windows, cams} when the time comes. */
    queueSave(collect) {
        if (!this._enabled)
            return;
        if (this._saveTimeout)
            GLib.Source.remove(this._saveTimeout);
        this._saveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveTimeout = 0;
            this.save(collect());
            return GLib.SOURCE_REMOVE;
        });
    }

    save(state) {
        if (!this._enabled)
            return;
        if (this._saveTimeout)
            GLib.Source.remove(this._saveTimeout);
        this._saveTimeout = 0;
        this._settings.set_string('canvas-state', JSON.stringify(state));
    }

    /**
     * The saved state, matched against the windows open now.
     * @param {Array<{id, seq, app, title}>} current
     * @returns {{cams: object, matches: Map<id, entry>}}
     */
    load(current) {
        if (!this._enabled)
            return {cams: {}, matches: new Map()};
        const state = parse(this._settings.get_string('canvas-state'), {});
        const entries = Array.isArray(state.windows) ? state.windows : [];
        const matches = matchWindows(entries, current);
        const used = new Set(matches.values());
        this._remembered = {entries: entries.filter(e => !used.has(e)), until: now() + REMEMBER_MS};
        return {cams: state.cams ?? {}, matches};
    }

    /** Where a window that just opened was last session, if it's one we remember. */
    takeRemembered(info) {
        return this._take(this._remembered, info);
    }

    /** Where a window that a layout reopened should go, if it's one of those. */
    takeExpected(info) {
        return this._take(this._expected, info);
    }

    expect(entries) {
        this._expected = {entries: [...entries], until: now() + LAYOUT_WAIT_MS};
    }

    _take(list, info) {
        if (now() > list.until || list.entries.length === 0)
            return null;
        const entry = matchWindows(list.entries, [{id: 0, ...info}]).get(0);
        if (entry)
            list.entries.splice(list.entries.indexOf(entry), 1);
        return entry ?? null;
    }

    layouts() {
        const layouts = parse(this._settings.get_string('layouts'), []);
        return Array.isArray(layouts) ? layouts : [];
    }

    /** Store a layout in the next free slot (the last one once all are used). Returns it. */
    addLayout(cam, windows) {
        const layouts = this.layouts().filter(Boolean);
        const n = Math.min(layouts.length, LAYOUT_SLOTS - 1);
        const time = GLib.DateTime.new_now_local().format('%H:%M');
        layouts[n] = {name: `Layout ${n + 1} · ${time}`, cam, windows};
        this._settings.set_string('layouts', JSON.stringify(layouts));
        return layouts[n];
    }
}
