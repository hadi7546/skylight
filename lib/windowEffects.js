// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

// Pure open/close curves for windows on the canvas, after Sunlight's
// WindowEffects.swift. No GNOME imports so node can unit-test them.

import {spring} from './geometry.js';

/** Settings › Windows › Opening and closing. */
export const EFFECTS = ['automatic', 'sunrise', 'unfold', 'bloom', 'dissolve', 'none'];

/** One concrete curve played on a preview. */
export const STYLES = ['sunrise', 'source', 'dealt', 'unfold', 'bloom', 'dissolve'];

export const BLOOM_SCALE = 0.9;
export const BLOOM_SPEED = 0.6;

const IDENTITY = Object.freeze({
    scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5,
    offsetX: 0, offsetY: 0, opacity: 1, dim: 0,
});

export function outExpo(p) {
    return p >= 1 ? 1 : 1 - Math.pow(2, -10 * p);
}

export function outQuint(p) {
    return 1 - Math.pow(1 - p, 5);
}

export function inCubic(p) {
    return p * p * p;
}

/**
 * Which curve a window gets. Null: no effect (it simply appears / goes).
 * @param {string} setting - one of EFFECTS
 * @param {{source?: {x,y}|null, neighbour?: {x,y,w,h}|null, attached?: boolean}} context
 * @param {boolean} reduceMotion
 */
export function styleFor(setting, context = {}, reduceMotion = false) {
    if (setting === 'none')
        return null;
    if (reduceMotion)
        return 'dissolve';
    switch (setting) {
    case 'sunrise':
    case 'unfold':
    case 'bloom':
    case 'dissolve':
        return setting;
    case 'automatic':
        if (context.attached)
            return 'unfold';
        if (context.source)
            return 'source';
        if (context.neighbour)
            return 'dealt';
        return 'sunrise';
    default:
        return 'sunrise';
    }
}

/** A style that needs a source/neighbour it doesn't have becomes sunrise. */
export function usable(style, geometry = {}) {
    if (style === 'source' && !geometry.toSource)
        return 'sunrise';
    if (style === 'dealt' && !geometry.toNeighbour)
        return 'sunrise';
    return style;
}

/** Opening and closing durations in milliseconds. */
export function durationMs(style, opening) {
    switch (style) {
    case 'sunrise':
        return opening ? 380 : 240;
    case 'source':
        return opening ? 340 : 240;
    case 'dealt':
        return opening ? 360 : 260;
    case 'unfold':
        return opening ? 300 : 200;
    case 'bloom':
        return opening ? 500 : 160;
    case 'dissolve':
        return opening ? 180 : 150;
    default:
        return opening ? 300 : 200;
    }
}

/**
 * Screen-space vectors from the window centre to its source / neighbour.
 * @param {{x,y,w,h}} winRect - screen rect of the arriving/leaving window
 * @param {{source?: {x,y}|null, neighbour?: {x,y,w,h}|null}} context - screen coords
 */
export function geometryFrom(winRect, context = {}) {
    const cx = winRect.x + winRect.w / 2;
    const cy = winRect.y + winRect.h / 2;
    const toSource = context.source
        ? {dx: context.source.x - cx, dy: context.source.y - cy}
        : null;
    let toNeighbour = null;
    if (context.neighbour) {
        const n = context.neighbour;
        toNeighbour = {dx: n.x + n.w / 2 - cx, dy: n.y + n.h / 2 - cy};
    }
    return {toSource, toNeighbour};
}

/**
 * One moment of an effect.
 * @returns {{scaleX, scaleY, anchorX, anchorY, offsetX, offsetY, opacity, dim}}
 */
export function frame(style, opening, tSec, geometry = {}) {
    style = usable(style, geometry);
    const d = durationMs(style, opening) / 1000;
    const p = Math.min(1, Math.max(0, tSec / d));
    const f = {
        scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5,
        offsetX: 0, offsetY: 0, opacity: 1, dim: 0,
    };

    if (opening) {
        switch (style) {
        case 'sunrise': {
            const e = outExpo(p);
            f.offsetY = 18 * (1 - e);
            f.opacity = Math.min(1, p / 0.35);
            f.dim = 0.45 * (1 - e);
            break;
        }
        case 'source': {
            const e = outQuint(p);
            const v = geometry.toSource ?? {dx: 0, dy: 0};
            const s = 0.18 + 0.82 * e;
            f.scaleX = f.scaleY = s;
            f.offsetX = v.dx * (1 - e);
            f.offsetY = v.dy * (1 - e);
            f.opacity = Math.min(1, p / 0.3);
            break;
        }
        case 'dealt': {
            const e = outExpo(p);
            const v = geometry.toNeighbour ?? {dx: 0, dy: 0};
            const s = 0.86 + 0.14 * e;
            f.scaleX = f.scaleY = s;
            f.offsetX = v.dx * (1 - e);
            f.offsetY = v.dy * (1 - e);
            f.opacity = Math.min(1, p / 0.25);
            break;
        }
        case 'unfold': {
            const e = outExpo(p);
            f.anchorY = 0;
            f.scaleX = 0.97 + 0.03 * e;
            f.scaleY = 0.03 + 0.97 * e;
            f.opacity = 0.7 + 0.3 * e;
            break;
        }
        case 'bloom': {
            if (tSec >= d) {
                f.scaleX = f.scaleY = 1;
            } else {
                const s = spring(tSec, {x0: BLOOM_SCALE - 1, v0: BLOOM_SPEED});
                f.scaleX = f.scaleY = 1 + s.x;
            }
            f.opacity = Math.min(1, tSec / 0.2);
            break;
        }
        case 'dissolve':
            f.opacity = outExpo(p);
            break;
        }
        if (p >= 1)
            return {...IDENTITY};
    } else {
        const e = inCubic(p);
        switch (style) {
        case 'sunrise':
            f.offsetY = 14 * e;
            f.dim = 0.5 * e;
            f.opacity = 1 - e;
            break;
        case 'source': {
            const v = geometry.toSource ?? {dx: 0, dy: 0};
            f.scaleX = f.scaleY = 1 - 0.82 * e;
            f.offsetX = v.dx * e;
            f.offsetY = v.dy * e;
            f.opacity = p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4;
            break;
        }
        case 'dealt': {
            const v = geometry.toNeighbour ?? {dx: 0, dy: 0};
            f.scaleX = f.scaleY = 1 - 0.14 * e;
            f.offsetX = v.dx * e;
            f.offsetY = v.dy * e;
            f.opacity = p < 0.5 ? 1 : 1 - (p - 0.5) / 0.5;
            break;
        }
        case 'unfold':
            f.anchorY = 0;
            f.scaleX = 1 - 0.03 * e;
            f.scaleY = 1 - 0.97 * e;
            f.opacity = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
            break;
        case 'bloom':
            f.scaleX = f.scaleY = 1 - 0.08 * e;
            f.opacity = 1 - e;
            break;
        case 'dissolve':
            f.opacity = 1 - e;
            break;
        }
    }
    return f;
}
