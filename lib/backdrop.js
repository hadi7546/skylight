// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

// What sits behind the windows on the canvas.
//
//   wallpaper  Your GNOME wallpaper, as Sunlight's default. It stays put (the
//              windows move over it), sharp at 100% and blurring and dimming
//              as you zoom out, fully so by 50%, so the overview is about the
//              windows.
//   grid       A flat colour with a dot grid that pans and zooms with the camera.
//   colour     Just the colour.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';

import {clamp} from './geometry.js';
import {DotGrid} from './dotGrid.js';

const BLUR_RADIUS = 28; // "Deep" in Sunlight's Focus setting
const MAX_DIM = 0.4;

export class Backdrop {
    /** @param {boolean} wallpaperAllowed - false for the live backdrop, where the real wallpaper shows anyway */
    constructor(wallpaperAllowed) {
        this._wallpaperAllowed = wallpaperAllowed;
        this.actor = new St.Widget({clip_to_allocation: true});
        this._grid = new DotGrid();
        this.actor.add_child(this._grid);
        this._wall = new Clutter.Actor();
        this.actor.add_child(this._wall);
        this._manager = null;
        this._blur = null;
        this._style = 'grid';
        this._blurOnZoom = true;
        this._monitorIndex = -1;
    }

    configure({style, color, dotColor, showDots, blurOnZoom}) {
        this._style = style;
        this._blurOnZoom = blurOnZoom;
        this._grid.setColors(color, dotColor, style === 'grid' && showDots);
        this._syncWallpaper();
    }

    /** Whether there is anything to draw (the live backdrop is empty in wallpaper mode). */
    get active() {
        return this._style !== 'wallpaper' || this._wallpaperAllowed;
    }

    setGeometry(monitorIndex, monitor) {
        this.actor.set_size(monitor.width, monitor.height);
        this._grid.set_size(monitor.width, monitor.height);
        this._wall.set_size(monitor.width, monitor.height);
        if (monitorIndex !== this._monitorIndex) {
            this._monitorIndex = monitorIndex;
            this._destroyWallpaper();
            this._syncWallpaper();
        }
    }

    _syncWallpaper() {
        const wanted = this._style === 'wallpaper' && this._wallpaperAllowed;
        this._grid.visible = !wanted;
        this._wall.visible = wanted;
        if (wanted && !this._manager && this._monitorIndex >= 0) {
            this._manager = new Background.BackgroundManager({
                container: this._wall,
                monitorIndex: this._monitorIndex,
                controlPosition: false,
                vignette: false,
            });
            if (Shell.BlurEffect) {
                this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 0, brightness: 1});
                this._blur.enabled = false;
                this._wall.add_effect(this._blur);
            }
        } else if (!wanted) {
            this._destroyWallpaper();
        }
    }

    _destroyWallpaper() {
        if (this._blur) {
            this._wall.remove_effect(this._blur);
            this._blur = null;
        }
        this._manager?.destroy();
        this._manager = null;
        this._wall.destroy_all_children();
    }

    /** `originX/Y`: the canvas point at the backdrop's top-left corner. */
    update(originX, originY, zoom) {
        if (this._style !== 'wallpaper') {
            this._grid.update(originX, originY, zoom);
            return;
        }
        if (!this._blur)
            return;
        const t = this._blurOnZoom ? clamp((1 - zoom) / 0.5, 0, 1) : 0;
        const radius = Math.round(t * BLUR_RADIUS);
        this._blur.enabled = radius > 0;
        if (this._blur.radius !== radius)
            this._blur.radius = radius;
        this._blur.brightness = 1 - MAX_DIM * t;
    }

    destroy() {
        this._destroyWallpaper();
        this.actor.destroy();
    }
}
