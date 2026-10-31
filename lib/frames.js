// Frames: named rectangles on a workspace's canvas ("Work", "Music"…). A
// frame carries the windows inside it when it's moved, and the camera can
// go to it. Kept in the `frames` setting, by workspace number, whether or
// not the canvas itself is remembered.

const MIN_W = 240;
const MIN_H = 160;

function parse(json) {
    try {
        const v = JSON.parse(json);
        return v && typeof v === 'object' ? v : {};
    } catch {
        return {};
    }
}

export class Frames {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._byWorkspace = parse(settings.get_string('frames'));
    }

    /** The active workspace's frames: {name, x, y, w, h} in canvas coordinates. */
    active() {
        const i = global.workspace_manager.get_active_workspace_index();
        this._byWorkspace[i] ??= [];
        return this._byWorkspace[i];
    }

    add(rect, name = null) {
        const list = this.active();
        const frame = {
            name: name ?? `Frame ${list.length + 1}`,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(Math.max(rect.w, MIN_W)),
            h: Math.round(Math.max(rect.h, MIN_H)),
        };
        list.push(frame);
        this.save();
        return frame;
    }

    remove(frame) {
        const list = this.active();
        const i = list.indexOf(frame);
        if (i >= 0)
            list.splice(i, 1);
        this.save();
    }

    /** A resize, no smaller than a frame can be. */
    resize(frame, rect) {
        frame.x = Math.round(rect.x);
        frame.y = Math.round(rect.y);
        frame.w = Math.round(Math.max(rect.w, MIN_W));
        frame.h = Math.round(Math.max(rect.h, MIN_H));
    }

    save() {
        this._settings.set_string('frames', JSON.stringify(this._byWorkspace));
    }
}
