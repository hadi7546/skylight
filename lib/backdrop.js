// What sits behind the windows on the canvas.
//
//   wallpaper  Your GNOME wallpaper, as Sunlight's default. It stays put (the
//              windows move over it), sharp at 100% and blurring and dimming
//              as you zoom out, fully so by 50%, so the overview is about the
//              windows.
//   image      A picture file (cover-fitted), blurring and dimming like the wallpaper.
//   gradient   Two colours, vertical, horizontal or radial, likewise.
//   grid       A flat colour with a dot grid that pans and zooms with the camera.
//   colour     Just the colour.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
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
        this._built = null; // null: nothing yet; true: wallpaper; false: a picture
        this._picture = null;
        this._image = '';
        this._gradient = null;
    }

    configure({style, color, dotColor, showDots, blurOnZoom, image = '', gradient = null}) {
        this._style = style;
        this._blurOnZoom = blurOnZoom;
        this._image = image;
        this._gradient = gradient;
        this._grid.setColors(color, dotColor, style === 'grid' && showDots);
        this._syncWallpaper();
    }

    /** Whether there is anything to draw (the live backdrop is empty in wallpaper mode). */
    get active() {
        return !this._pictured || this._wallpaperAllowed;
    }

    /** Styles drawn into the blurrable layer above the grid. */
    get _pictured() {
        return this._style === 'wallpaper' || this._style === 'image' || this._style === 'gradient';
    }

    _pictureCss() {
        const g = this._gradient;
        if (this._style === 'image' && this._image) {
            const uri = GLib.filename_to_uri(this._image, null);
            return `background-color: #000; background-image: url("${uri}"); background-size: cover;`;
        }
        if (this._style === 'gradient' && g) {
            return `background-gradient-start: ${g.start}; background-gradient-end: ${g.end}; ` +
                `background-gradient-direction: ${g.direction};`;
        }
        return 'background-color: #000;';
    }

    setGeometry(monitorIndex, monitor) {
        this.actor.set_size(monitor.width, monitor.height);
        this._grid.set_size(monitor.width, monitor.height);
        this._wall.set_size(monitor.width, monitor.height);
        this._picture?.set_size(monitor.width, monitor.height);
        if (monitorIndex !== this._monitorIndex) {
            this._monitorIndex = monitorIndex;
            this._destroyWallpaper();
            this._syncWallpaper();
        }
    }

    _syncWallpaper() {
        const wanted = this._pictured && this._wallpaperAllowed;
        this._grid.visible = !wanted;
        this._wall.visible = wanted;
        if (!wanted || this._monitorIndex < 0) {
            if (!wanted)
                this._destroyWallpaper();
            return;
        }
        const wallpaper = this._style === 'wallpaper';
        // Switching between the wallpaper and a picture rebuilds the layer.
        if (this._built !== null && this._built !== wallpaper)
            this._destroyWallpaper();
        if (this._built === null) {
            this._built = wallpaper;
            if (wallpaper) {
                this._manager = new Background.BackgroundManager({
                    container: this._wall,
                    monitorIndex: this._monitorIndex,
                    controlPosition: false,
                    vignette: false,
                });
            } else {
                this._picture = new St.Widget({x_expand: true, y_expand: true});
                this._wall.add_child(this._picture);
                this._picture.set_size(this._wall.width, this._wall.height);
            }
            if (Shell.BlurEffect) {
                this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 0, brightness: 1});
                this._blur.enabled = false;
                this._wall.add_effect(this._blur);
            }
        }
        this._picture?.set_style(this._pictureCss());
    }

    _destroyWallpaper() {
        if (this._blur) {
            this._wall.remove_effect(this._blur);
            this._blur = null;
        }
        this._manager?.destroy();
        this._manager = null;
        this._picture = null;
        this._built = null;
        this._wall.destroy_all_children();
    }

    /** `originX/Y`: the canvas point at the backdrop's top-left corner. */
    update(originX, originY, zoom) {
        if (!this._pictured) {
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
