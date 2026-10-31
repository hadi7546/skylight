// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

// The canvas backdrop: a flat colour with a dot grid that pans and zooms with
// the camera. Drawn entirely in a fragment shader so it costs nothing per
// frame beyond updating a few uniforms.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gridSpacing} from './geometry.js';

const UNIFORMS = ['u_size', 'u_origin', 'u_zoom', 'u_spacing', 'u_radius', 'u_bg', 'u_dot'];
const DECLARATIONS = `
uniform vec2 u_size;
uniform vec2 u_origin;
uniform float u_zoom;
uniform float u_spacing;
uniform float u_radius;
uniform vec4 u_bg;
uniform vec4 u_dot;
`;

const CODE = `
vec2 px = cogl_tex_coord_in[0].xy * u_size;
vec2 c = u_origin + px / u_zoom;
vec2 d = mod(c, u_spacing);
d = min(d, u_spacing - d) * u_zoom;
float a = clamp(u_radius + 0.5 - length(d), 0.0, 1.0) * u_dot.a;
float o = cogl_color_in.a;
cogl_color_out = vec4(mix(u_bg.rgb, u_dot.rgb, a) * o, o);
`;

// GNOME 51 removed Shell.GLSLEffect in favour of Clutter.ShaderEffect with a
// static snippet. The two need different vfuncs, so define whichever exists.
let DotGridEffect;
if (Shell.GLSLEffect) {
    // GNOME 48 moved the snippet hook enum from Shell to Cogl.
    const SnippetHook = Shell.SnippetHook ?? Cogl.SnippetHook;

    DotGridEffect = GObject.registerClass({
        GTypeName: 'SkylightDotGridGLSLEffect',
    }, class DotGridEffect extends Shell.GLSLEffect {
        _init() {
            super._init();
            this._locations = {};
            for (const name of UNIFORMS)
                this._locations[name] = this.get_uniform_location(name);
        }

        vfunc_build_pipeline() {
            this.add_glsl_snippet(SnippetHook.FRAGMENT, DECLARATIONS, CODE, true);
        }

        setUniform(name, values) {
            this.set_uniform_float(this._locations[name], values.length, values);
        }
    });
} else {
    DotGridEffect = GObject.registerClass({
        GTypeName: 'SkylightDotGridShaderEffect',
    }, class DotGridEffect extends Clutter.ShaderEffect {
        vfunc_get_static_snippet() {
            const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, null);
            snippet.set_replace(CODE);
            return snippet;
        }

        setUniform(name, values) {
            this.set_uniform_float(name, values.length, values);
        }
    });
}

// Accepts #rgb, #rrggbb, #rrggbbaa and rgb()/rgba(). Parsed by hand because
// Clutter.Color was removed in GNOME 47.
export function parseColor(str, fallback) {
    str = (str ?? '').trim();
    let m = str.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (m) {
        let hex = m[1];
        if (hex.length === 3)
            hex = [...hex].map(c => c + c).join('');
        const n = i => parseInt(hex.slice(i, i + 2), 16) / 255;
        return [n(0), n(2), n(4), hex.length === 8 ? n(6) : 1];
    }
    m = str.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
    if (m)
        return [m[1] / 255, m[2] / 255, m[3] / 255, m[4] !== undefined ? Number(m[4]) : 1];
    return fallback;
}

/**
 * A widget filling its allocation with the canvas background. Call
 * `update(originX, originY, zoom)` with the canvas coordinates of the
 * widget's top-left corner whenever the camera moves.
 */
export const DotGrid = GObject.registerClass(
class DotGrid extends St.Widget {
    _init(params = {}) {
        super._init({
            style: 'background-color: black;',
            ...params,
        });
        this._effect = new DotGridEffect();
        this.add_effect(this._effect);
        this._bg = [0.84, 0.84, 0.84, 1];
        this._dot = [0, 0, 0, 0.16];
        this._showDots = true;
        this._origin = [0, 0];
        this._zoom = 1;
        this.connect('notify::size', () => this._apply());
    }

    setColors(bg, dot, showDots) {
        this._bg = parseColor(bg, this._bg);
        this._dot = parseColor(dot, this._dot);
        this._showDots = showDots;
        this._apply();
    }

    update(originX, originY, zoom) {
        this._origin = [originX, originY];
        this._zoom = zoom;
        this._apply();
    }

    _apply() {
        const e = this._effect;
        const [w, h] = this.get_size();
        e.setUniform('u_size', [Math.max(w, 1), Math.max(h, 1)]);
        e.setUniform('u_origin', this._origin);
        e.setUniform('u_zoom', [this._zoom]);
        e.setUniform('u_spacing', [gridSpacing(this._zoom)]);
        e.setUniform('u_radius', [this._showDots ? 1.1 : 0]);
        e.setUniform('u_bg', this._bg);
        e.setUniform('u_dot', this._showDots ? this._dot : [0, 0, 0, 0]);
        e.queue_repaint();
    }
});
