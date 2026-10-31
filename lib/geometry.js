// Pure geometry for the infinite canvas. No GNOME imports so it can be unit
// tested with plain node (see tests/geometry.test.mjs).
//
// Much of this is a port of Sunlight's pure modules (Camera.swift,
// Snapping.swift, Resizing.swift, NewWindowSpot.swift, Tiling.swift,
// Tidy.swift; MIT, © 2026 spacefarm), so the canvas behaves the same way.
//
// Conventions
//   - Canvas space: unbounded 2D plane, units are logical pixels at 100% zoom.
//   - Rects are {x, y, w, h}.
//   - A camera is {cx, cy, zoom}: the canvas point shown at the centre of the
//     viewport, and the scale factor from canvas to screen.
//   - A viewport is the screen rect ({x, y, w, h}) that shows the canvas at
//     100%; it is the primary monitor's work area.

export const MIN_ZOOM = 0.04;
export const MAX_ZOOM = 1;
/** Ending a pinch at or above this zoom over a window enters it. */
export const HANDOFF_ZOOM = 0.9;

export function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

export function clampZoom(z) {
    return clamp(z, MIN_ZOOM, MAX_ZOOM);
}

export function intersects(a, b, pad = 0) {
    return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad &&
        a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

export function overlapArea(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Merging canvases into one: each group of rects keeps its own arrangement
 * and goes to the right of everything placed so far, top-aligned with it.
 * Returns the [dx, dy] that moves each group.
 */
export function mergeOffsets(groups, gap) {
    let placed = null;
    return groups.map(g => {
        const u = union(g);
        if (!u)
            return [0, 0];
        if (!placed) {
            placed = u;
            return [0, 0];
        }
        const dx = placed.x + placed.w + gap - u.x, dy = placed.y - u.y;
        placed = union([placed, {x: u.x + dx, y: u.y + dy, w: u.w, h: u.h}]);
        return [dx, dy];
    });
}

export function union(rects) {
    if (rects.length === 0)
        return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of rects) {
        x1 = Math.min(x1, r.x);
        y1 = Math.min(y1, r.y);
        x2 = Math.max(x2, r.x + r.w);
        y2 = Math.max(y2, r.y + r.h);
    }
    return {x: x1, y: y1, w: x2 - x1, h: y2 - y1};
}

export function center(r) {
    return [r.x + r.w / 2, r.y + r.h / 2];
}

export function inset(r, d) {
    return {x: r.x + d, y: r.y + d, w: r.w - 2 * d, h: r.h - 2 * d};
}

// ---------------------------------------------------------------------------
// Camera

export function canvasToScreen(cam, vp, x, y) {
    return [
        vp.x + vp.w / 2 + (x - cam.cx) * cam.zoom,
        vp.y + vp.h / 2 + (y - cam.cy) * cam.zoom,
    ];
}

export function screenToCanvas(cam, vp, sx, sy) {
    return [
        cam.cx + (sx - vp.x - vp.w / 2) / cam.zoom,
        cam.cy + (sy - vp.y - vp.h / 2) / cam.zoom,
    ];
}

/** The canvas rect currently visible through the viewport. */
export function visibleCanvasRect(cam, vp) {
    const w = vp.w / cam.zoom, h = vp.h / cam.zoom;
    return {x: cam.cx - w / 2, y: cam.cy - h / 2, w, h};
}

/** Zoom to `zoom` while keeping the canvas point under screen (sx, sy) fixed. */
export function zoomAround(cam, vp, sx, sy, zoom) {
    zoom = clampZoom(zoom);
    const [px, py] = screenToCanvas(cam, vp, sx, sy);
    return {
        cx: px - (sx - vp.x - vp.w / 2) / zoom,
        cy: py - (sy - vp.y - vp.h / 2) / zoom,
        zoom,
    };
}

/** Camera that shows `bounds` entirely, with `margin` screen px around it. */
export function fitCamera(bounds, vp, {margin = 64, maxZoom = 0.6} = {}) {
    if (!bounds)
        return null;
    const zx = (vp.w - 2 * margin) / Math.max(bounds.w, 1);
    const zy = (vp.h - 2 * margin) / Math.max(bounds.h, 1);
    const [cx, cy] = center(bounds);
    return {cx, cy, zoom: clampZoom(Math.min(zx, zy, maxZoom))};
}

/** Camera at 100% that puts the top-left of canvas rect `r` at screen (ox, oy). */
export function cameraPlacing(r, vp, ox, oy) {
    return {cx: r.x + vp.x + vp.w / 2 - ox, cy: r.y + vp.y + vp.h / 2 - oy, zoom: 1};
}

/**
 * Entering a window "in the middle" (double-click, Return): centred when it
 * fits, otherwise aligned to its top-left corner so the title bar shows.
 */
export function cameraForWindow(r, vp) {
    const cx = r.w <= vp.w ? r.x + r.w / 2 : r.x + vp.w / 2;
    const cy = r.h <= vp.h ? r.y + r.h / 2 : r.y + vp.h / 2;
    return {cx: Math.round(cx), cy: Math.round(cy), zoom: 1};
}

/**
 * Entering a window by clicking it: it grows to 1:1 around the clicked spot,
 * which stays under the pointer, except that its top never goes above the
 * work area.
 */
export function clickEnterCamera(cam, vp, r, sx, sy) {
    const [wx, wy] = screenToCanvas(cam, vp, sx, sy);
    const ox = Math.round(sx - (wx - r.x));
    const oy = Math.round(Math.max(vp.y, sy - (wy - r.y)));
    return cameraPlacing(r, vp, ox, oy);
}

/**
 * Entering a window by pinching in over it: it grows down from its title
 * bar, which stays at the height it has on screen, the point's x staying
 * under the fingers.
 */
export function inPlaceCamera(cam, vp, r, sx) {
    const [wx] = screenToCanvas(cam, vp, sx, 0);
    const [, top] = canvasToScreen(cam, vp, r.x, r.y);
    return cameraPlacing(r, vp, Math.round(sx - (wx - r.x)), Math.round(Math.max(vp.y, top)));
}

/**
 * Enough of `r` shows that following the focus to it isn't worth moving the
 * camera: its top edge (where the title bar is) and most of the rest.
 */
export function wellInView(cam, vp, r) {
    const view = visibleCanvasRect(cam, vp);
    const visW = Math.min(r.x + r.w, view.x + view.w) - Math.max(r.x, view.x);
    const visH = Math.min(r.y + r.h, view.y + view.h) - Math.max(r.y, view.y);
    return r.y >= view.y && visW >= 0.8 * Math.min(r.w, view.w) && visH >= 0.8 * Math.min(r.h, view.h);
}

/** Pans shorter than this aren't worth a flight: the window is as good as in view. */
export const REVEAL_MIN = 48;

/**
 * Smallest pan at the current zoom that makes `r` fully visible (with
 * `margin` canvas px), or null if it already is, or nearly (within
 * REVEAL_MIN). Falls back to centring when the rect is larger than the view.
 */
export function cameraToReveal(cam, vp, r, margin = 24) {
    const view = visibleCanvasRect(cam, vp);
    let {cx, cy} = cam;
    if (r.w + 2 * margin > view.w)
        cx = r.w <= view.w ? r.x + r.w / 2 : r.x + view.w / 2;
    else if (r.x - margin < view.x)
        cx += r.x - margin - view.x;
    else if (r.x + r.w + margin > view.x + view.w)
        cx += r.x + r.w + margin - (view.x + view.w);
    if (r.h + 2 * margin > view.h)
        // Taller than the view: its top at the top, never a pixel above
        // (mutter hides X11 title bars there).
        cy = r.h <= view.h ? r.y + r.h / 2 : Math.floor(r.y + view.h / 2);
    else if (r.y - margin < view.y)
        cy += r.y - margin - view.y;
    else if (r.y + r.h + margin > view.y + view.h)
        cy += r.y + r.h + margin - (view.y + view.h);
    // A window nearly as tall as the view would otherwise creep the camera a
    // pixel or two at every focus change, as mutter nudges its title bar.
    if (Math.abs(cx - cam.cx) < REVEAL_MIN && Math.abs(cy - cam.cy) < REVEAL_MIN)
        return null;
    return {cx: Math.round(cx), cy: Math.round(cy), zoom: cam.zoom};
}

/** Fraction (0..1) of `r` that is visible through the camera. */
export function visibleFraction(cam, vp, r) {
    const area = r.w * r.h;
    return area > 0 ? overlapArea(r, visibleCanvasRect(cam, vp)) / area : 0;
}

/**
 * Interpolate between two cameras as a pure zoom about a fixed point: zoom
 * moves geometrically and the centre is weighted by 1/zoom. Used for
 * entering a window, which is a straight zoom in.
 */
export function lerpCamera(a, b, t) {
    const zoom = Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * t);
    let u = t;
    const ia = 1 / a.zoom, ib = 1 / b.zoom;
    if (Math.abs(ib - ia) > 1e-6)
        u = (1 / zoom - ia) / (ib - ia);
    return {
        cx: a.cx + (b.cx - a.cx) * u,
        cy: a.cy + (b.cy - a.cy) * u,
        zoom,
    };
}

/**
 * Van Wijk & Nuij's smooth pan-and-zoom path ("Smooth and efficient zooming
 * and panning", 2003): the camera pulls back a little on the way, more for
 * longer trips, so a move reads as travel across the canvas. `at(t)` runs
 * 0 → 1 and extrapolates smoothly past either end, so a spring can overshoot.
 */
export function cameraPath(from, to, vp, rho = 1.1) {
    const rho2 = rho * rho, rho4 = rho2 * rho2;
    const w0 = vp.w / from.zoom, w1 = vp.w / to.zoom;
    const dx = to.cx - from.cx, dy = to.cy - from.cy;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1e-6) {
        const S = Math.log(w1 / w0) / rho;
        return {
            length: Math.abs(S),
            at: t => ({cx: from.cx + t * dx, cy: from.cy + t * dy, zoom: vp.w / (w0 * Math.exp(rho * t * S))}),
        };
    }
    const d1 = Math.sqrt(d2);
    const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
    const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
    const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    const S = (r1 - r0) / rho;
    const ch = Math.cosh(r0), sh = Math.sinh(r0);
    return {
        length: Math.abs(S),
        at: t => {
            const s = t * S;
            const u = w0 / (rho2 * d1) * (ch * Math.tanh(rho * s + r0) - sh);
            const w = w0 * ch / Math.cosh(rho * s + r0);
            return {cx: from.cx + u * dx, cy: from.cy + u * dy, zoom: vp.w / w};
        },
    };
}

/**
 * A damped spring in closed form, pulling a scalar from `x0` toward 0. A
 * little under-damped: the slight overshoot is the rubber band at the end
 * of a flight. Returns offset and velocity `t` seconds in.
 */
export function spring(t, {x0 = 1, v0 = 0, response = 0.45, damping = 0.72} = {}) {
    const w = 2 * Math.PI / response;
    const z = damping;
    const wd = w * Math.sqrt(1 - z * z);
    const decay = Math.exp(-z * w * t);
    const a = x0, b = (v0 + z * w * x0) / wd;
    const c = Math.cos(wd * t), s = Math.sin(wd * t);
    return {
        x: decay * (a * c + b * s),
        v: decay * ((b * wd - a * z * w) * c - (a * wd + b * z * w) * s),
    };
}

/** Screen rect a window would occupy at 100% (rounded to whole pixels). */
export function liveRect(cam, vp, r) {
    return {
        x: Math.round(vp.x + vp.w / 2 + r.x - cam.cx),
        y: Math.round(vp.y + vp.h / 2 + r.y - cam.cy),
        w: r.w,
        h: r.h,
    };
}

/**
 * Whether mutter will accept a window at screen rect `s` without clamping
 * it back on screen. It insists on min(75, max(10, size / 4)) px of each
 * axis remaining inside the work area (see constrain_partially_onscreen).
 */
export function placeableOnScreen(s, workArea, slack = 2) {
    const needW = clamp(Math.floor(s.w / 4), 10, 75) + slack;
    const needH = clamp(Math.floor(s.h / 4), 10, 75) + slack;
    const visW = Math.min(s.x + s.w, workArea.x + workArea.w) - Math.max(s.x, workArea.x);
    const visH = Math.min(s.y + s.h, workArea.y + workArea.h) - Math.max(s.y, workArea.y);
    return visW >= needW && visH >= needH;
}

// ---------------------------------------------------------------------------
// Snapping (Snapping.swift): edges stick to a neighbour's edges, centres to
// centres, or sit `gap` beside a neighbour that overlaps across the axis.

function span(r, axis) {
    return axis === 'x' ? [r.x, r.x + r.w / 2, r.x + r.w] : [r.y, r.y + r.h / 2, r.y + r.h];
}

function snapCandidates(axis, m, others, gap) {
    const [mMin, mMid, mMax] = span(m, axis);
    const list = [];
    for (const o of others) {
        const [tMin, tMid, tMax] = span(o, axis);
        for (const mv of [mMin, mMax]) {
            for (const tv of [tMin, tMax])
                list.push({delta: tv - mv, other: o, kind: 'line', at: tv});
        }
        list.push({delta: tMid - mMid, other: o, kind: 'line', at: tMid});

        const across = axis === 'x'
            ? [m.y, m.y + m.h, o.y, o.y + o.h]
            : [m.x, m.x + m.w, o.x, o.x + o.w];
        if (!(across[0] < across[3] && across[2] < across[1]))
            continue;
        list.push({delta: tMax + gap - mMin, other: o, kind: 'gap', at: tMax});
        list.push({delta: tMin - gap - mMax, other: o, kind: 'gap', at: tMin - gap});
    }
    return list;
}

function nearestCandidates(list, threshold) {
    let best = null;
    for (const c of list) {
        if (Math.abs(c.delta) <= threshold && (!best || Math.abs(c.delta) < Math.abs(best.delta)))
            best = c;
    }
    return best ? list.filter(c => Math.abs(c.delta - best.delta) < 0.5) : [];
}

function guideFor(c, axis, r, gap) {
    const o = c.other;
    if (c.kind === 'line' && axis === 'x')
        return {kind: 'line', x1: c.at, y1: Math.min(r.y, o.y), x2: c.at, y2: Math.max(r.y + r.h, o.y + o.h)};
    if (c.kind === 'line')
        return {kind: 'line', x1: Math.min(r.x, o.x), y1: c.at, x2: Math.max(r.x + r.w, o.x + o.w), y2: c.at};
    if (axis === 'x') {
        const y = (Math.max(r.y, o.y) + Math.min(r.y + r.h, o.y + o.h)) / 2;
        return {kind: 'gap', x1: c.at, y1: y, x2: c.at + gap, y2: y};
    }
    const x = (Math.max(r.x, o.x) + Math.min(r.x + r.w, o.x + o.w)) / 2;
    return {kind: 'gap', x1: x, y1: c.at, x2: x, y2: c.at + gap};
}

/**
 * Line a moving rect up with the nearest of `others` on each axis, if within
 * `threshold` (canvas units). Call with the raw pointer position on every
 * move, so the rect sticks until the pointer pulls away.
 */
export function align(moving, others, {threshold, gap}) {
    const xs = nearestCandidates(snapCandidates('x', moving, others, gap), threshold);
    const ys = nearestCandidates(snapCandidates('y', moving, others, gap), threshold);
    const x = moving.x + (xs[0]?.delta ?? 0);
    const y = moving.y + (ys[0]?.delta ?? 0);
    const snapped = {x, y, w: moving.w, h: moving.h};
    return {
        x, y,
        snappedX: xs.length > 0,
        snappedY: ys.length > 0,
        guides: [...xs.map(c => guideFor(c, 'x', snapped, gap)), ...ys.map(c => guideFor(c, 'y', snapped, gap))],
    };
}

/** The nearest grid point on each axis that no neighbour is holding. */
export function gridSnap(x, y, size, keepX = false, keepY = false) {
    if (!(size > 0))
        return {x, y};
    return {
        x: keepX ? x : Math.round(x / size) * size,
        y: keepY ? y : Math.round(y / size) * size,
    };
}

/**
 * Windows whose edges touch (within `gap` + tolerance) form a cluster.
 * Returns the ids of every member of the cluster containing `startId`.
 */
export function clusterOf(startId, items, gap, tolerance = 2) {
    const pad = gap + tolerance;
    const byId = new Map(items.map(i => [i.id, i]));
    const seen = new Set([startId]);
    const queue = [startId];
    while (queue.length) {
        const cur = byId.get(queue.pop());
        if (!cur)
            continue;
        for (const o of items) {
            if (seen.has(o.id))
                continue;
            if (intersects(cur, o, pad)) {
                seen.add(o.id);
                queue.push(o.id);
            }
        }
    }
    return [...seen];
}

// ---------------------------------------------------------------------------
// Resizing from the edges on the canvas (Resizing.swift)

export const RESIZE_BAND = 6; // screen px inside an edge that grab it
export const RESIZE_CORNER = 16; // along an edge, this close to a corner grabs the corner
export const RESIZE_MIN_SCREEN = {w: 60, h: 40};
export const MIN_WINDOW = {w: 160, h: 100};

/** Which edges of on-screen rect `r` the point is on: {left, right, top, bottom} or null. */
export function resizeEdges(px, py, r) {
    if (r.w < RESIZE_MIN_SCREEN.w || r.h < RESIZE_MIN_SCREEN.h)
        return null;
    if (px < r.x || py < r.y || px >= r.x + r.w || py >= r.y + r.h)
        return null;
    const left = px - r.x, right = r.x + r.w - px, top = py - r.y, bottom = r.y + r.h - py;
    const e = {left: false, right: false, top: false, bottom: false};
    if (left < RESIZE_BAND)
        e.left = true;
    else if (right < RESIZE_BAND)
        e.right = true;
    if (top < RESIZE_BAND)
        e.top = true;
    else if (bottom < RESIZE_BAND)
        e.bottom = true;
    const horiz = e.left || e.right, vert = e.top || e.bottom;
    if (horiz && !vert) {
        if (top < RESIZE_CORNER)
            e.top = true;
        else if (bottom < RESIZE_CORNER)
            e.bottom = true;
    } else if (vert && !horiz) {
        if (left < RESIZE_CORNER)
            e.left = true;
        else if (right < RESIZE_CORNER)
            e.right = true;
    }
    return e.left || e.right || e.top || e.bottom ? e : null;
}

/** The corner that stays put while `edges` move, as a unit point (0,0 = top-left). */
export function resizeAnchor(edges) {
    return {x: edges?.left ? 1 : 0, y: edges?.top ? 1 : 0};
}

/** `start` with the grabbed edges moved by a canvas delta, never below `min`. */
export function resizeRect(start, edges, dx, dy, min = MIN_WINDOW) {
    let x1 = start.x, x2 = start.x + start.w, y1 = start.y, y2 = start.y + start.h;
    if (edges.left)
        x1 = Math.min(x2 - min.w, start.x + dx);
    if (edges.right)
        x2 = Math.max(x1 + min.w, x2 + dx);
    if (edges.top)
        y1 = Math.min(y2 - min.h, start.y + dy);
    if (edges.bottom)
        y2 = Math.max(y1 + min.h, y2 + dy);
    return {x: x1, y: y1, w: x2 - x1, h: y2 - y1};
}

/** Let go: the edges that moved settle onto the grid. */
export function resizeGrid(r, edges, size, min = MIN_WINDOW) {
    if (!(size > 0))
        return {...r};
    const snap = v => Math.round(v / size) * size;
    let x1 = r.x, x2 = r.x + r.w, y1 = r.y, y2 = r.y + r.h;
    if (edges.left) {
        x1 = snap(x1);
        if (x2 - x1 < min.w)
            x1 = Math.floor((x2 - min.w) / size) * size;
    }
    if (edges.right) {
        x2 = snap(x2);
        if (x2 - x1 < min.w)
            x2 = Math.ceil((x1 + min.w) / size) * size;
    }
    if (edges.top) {
        y1 = snap(y1);
        if (y2 - y1 < min.h)
            y1 = Math.floor((y2 - min.h) / size) * size;
    }
    if (edges.bottom) {
        y2 = snap(y2);
        if (y2 - y1 < min.h)
            y2 = Math.ceil((y1 + min.h) / size) * size;
    }
    return {x: x1, y: y1, w: x2 - x1, h: y2 - y1};
}

/** Where a rect of size (w, h) sits in `r` so that `anchor` stays put. */
export function placeAnchored(w, h, r, anchor) {
    const fx = r.x + r.w * anchor.x, fy = r.y + r.h * anchor.y;
    return {x: fx - w * anchor.x, y: fy - h * anchor.y, w, h};
}

// ---------------------------------------------------------------------------
// New windows (NewWindowSpot.swift): the middle of the view if that's clear,
// otherwise the free spot nearest the middle beside the windows in the way,
// in view if there's room in view.

const OUT_OF_VIEW_PENALTY = 1e6;
const OUT_OF_VIEW_WEIGHT = 4;

export function isClear(r, others, gap) {
    const reach = Math.max(gap - 0.5, 0);
    const grown = {x: r.x - reach, y: r.y - reach, w: r.w + 2 * reach, h: r.h + 2 * reach};
    return !others.some(o => intersects(grown, o));
}

function spotScore(r, tx, ty, view) {
    const distance = Math.hypot(r.x + r.w / 2 - tx, r.y + r.h / 2 - ty);
    const out = Math.max(0, view.x - r.x) + Math.max(0, r.x + r.w - (view.x + view.w)) +
        Math.max(0, view.y - r.y) + Math.max(0, r.y + r.h - (view.y + view.h));
    return out > 0 ? OUT_OF_VIEW_PENALTY + OUT_OF_VIEW_WEIGHT * out + distance : distance;
}

export function newWindowSpot(w, h, others, view, gap, target = null) {
    const tx = target?.x ?? view.x + view.w / 2, ty = target?.y ?? view.y + view.h / 2;
    const middle = {x: Math.round(tx - w / 2), y: Math.round(ty - h / 2), w, h};
    if (isClear(middle, others, gap))
        return middle;
    let best = null, bestScore = Infinity;
    for (const o of others) {
        const right = o.x + o.w + gap, left = o.x - gap - w;
        const below = o.y + o.h + gap, above = o.y - gap - h;
        const spots = [
            [right, o.y], [right, o.y + o.h - h], [left, o.y], [left, o.y + o.h - h],
            [o.x, below], [o.x + o.w - w, below], [o.x, above], [o.x + o.w - w, above],
            [right, middle.y], [left, middle.y], [middle.x, below], [middle.x, above],
        ];
        for (const [x, y] of spots) {
            const r = {x, y, w, h};
            if (!isClear(r, others, gap))
                continue;
            const s = spotScore(r, tx, ty, view);
            if (s < bestScore) {
                bestScore = s;
                best = r;
            }
        }
    }
    if (best)
        return {x: Math.round(best.x), y: Math.round(best.y), w, h};
    const u = union(others);
    return {x: u.x + u.w + gap, y: u.y, w, h};
}

// ---------------------------------------------------------------------------
// Move & Resize (Tiling.swift): a window to a fraction of a screen-sized area.

const T = 1 / 3;
export const PRESETS = {
    'left-half': {x: 0, y: 0, w: 0.5, h: 1},
    'right-half': {x: 0.5, y: 0, w: 0.5, h: 1},
    'top-half': {x: 0, y: 0, w: 1, h: 0.5},
    'bottom-half': {x: 0, y: 0.5, w: 1, h: 0.5},
    'top-left': {x: 0, y: 0, w: 0.5, h: 0.5},
    'top-right': {x: 0.5, y: 0, w: 0.5, h: 0.5},
    'bottom-left': {x: 0, y: 0.5, w: 0.5, h: 0.5},
    'bottom-right': {x: 0.5, y: 0.5, w: 0.5, h: 0.5},
    'left-third': {x: 0, y: 0, w: T, h: 1},
    'center-third': {x: T, y: 0, w: T, h: 1},
    'right-third': {x: 2 * T, y: 0, w: 1 - 2 * T, h: 1},
    'left-two-thirds': {x: 0, y: 0, w: 2 * T, h: 1},
    'center-two-thirds': {x: T / 2, y: 0, w: 2 * T, h: 1},
    'right-two-thirds': {x: T, y: 0, w: 1 - T, h: 1},
    'full': {x: 0, y: 0, w: 1, h: 1},
    'center': null,
};

/** Pressing the same slot again steps through its widths: ½ → ⅔ → ⅓ → ½. */
const PRESET_NEXT = {
    'left-half': 'left-two-thirds',
    'left-two-thirds': 'left-third',
    'left-third': 'left-half',
    'right-half': 'right-two-thirds',
    'right-two-thirds': 'right-third',
    'right-third': 'right-half',
    'center-third': 'center-two-thirds',
    'center-two-thirds': 'center-third',
};

const PRESET_ROOT = {
    'left-two-thirds': 'left-half',
    'left-third': 'left-half',
    'right-two-thirds': 'right-half',
    'right-third': 'right-half',
    'center-two-thirds': 'center-third',
};

/** The preset a press of `pressed` gives, given the window's current one. */
export function nextPreset(pressed, current) {
    if (current && (PRESET_ROOT[current] ?? current) === pressed)
        return PRESET_NEXT[current] ?? current;
    return pressed;
}

/** A unit rect in an area, `gap` from its edges and between neighbours. */
export function unitRect(unit, area, gap) {
    const edge = (u, origin, length, leading) => {
        const v = origin + u * length;
        const atBorder = u <= 0.0001 || u >= 0.9999;
        const ins = atBorder ? gap : gap / 2;
        return Math.round(leading ? v + ins : v - ins);
    };
    const x1 = edge(unit.x, area.x, area.w, true);
    const x2 = edge(unit.x + unit.w, area.x, area.w, false);
    const y1 = edge(unit.y, area.y, area.h, true);
    const y2 = edge(unit.y + unit.h, area.y, area.h, false);
    return {x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1)};
}

/** Where a preset puts a window of size (w, h). `center` keeps the size. */
export function presetRect(preset, w, h, area, gap) {
    const unit = PRESETS[preset];
    if (unit)
        return unitRect(unit, area, gap);
    const room = inset(area, gap);
    const nw = Math.min(w, room.w), nh = Math.min(h, room.h);
    return {x: Math.round(room.x + room.w / 2 - nw / 2), y: Math.round(room.y + room.h / 2 - nh / 2), w: nw, h: nh};
}

/** The edge of a slot a window stays against if its app won't take the exact size. */
export function presetAnchor(preset) {
    const unit = PRESETS[preset];
    if (!unit)
        return {x: 0.5, y: 0.5};
    const axis = (lo, hi) => {
        if (lo <= 0.0001)
            return 0;
        if (hi >= 0.9999)
            return 1;
        return 0.5;
    };
    return {x: axis(unit.x, unit.x + unit.w), y: axis(unit.y, unit.y + unit.h)};
}

export const PAGE_GUTTER = 240;

/**
 * Zoomed out, a window is tiled within its page: screen-sized areas laid out
 * in a grid from the real desktop (`screen`, the work area at the identity
 * camera), a gutter apart.
 */
export function pageContaining(px, py, screen, gutter = PAGE_GUTTER) {
    const pitchX = screen.w + gutter, pitchY = screen.h + gutter;
    const i = Math.floor((px - screen.x + gutter / 2) / pitchX);
    const j = Math.floor((py - screen.y + gutter / 2) / pitchY);
    return {x: screen.x + i * pitchX, y: screen.y + j * pitchY, w: screen.w, h: screen.h};
}

// ---------------------------------------------------------------------------
// Tidy (Tidy.swift): every window on one grid from the top-left of the screen
// in view, keeping sizes: columns as wide as their widest window, rows as
// tall as their tallest, each window at the top-left of its cell.

export const TIDY_SPACING = {tight: 1, normal: 4, roomy: 12};

export function tidySpacing(name, gap) {
    return name === 'tight' ? gap : (TIDY_SPACING[name] ?? 4) * Math.max(gap, 8);
}

/**
 * Rows by where the rects sit, each row left to right. A rect joins the row
 * above when its top is above that row's first rect's middle.
 */
export function readingOrder(indices, rects) {
    const byTop = [...indices].sort((a, b) =>
        rects[a].y !== rects[b].y ? rects[a].y - rects[b].y : rects[a].x - rects[b].x);
    const rows = [];
    let rowMid = 0;
    for (const i of byTop) {
        if (rows.length === 0 || rects[i].y >= rowMid) {
            rows.push([i]);
            rowMid = rects[i].y + rects[i].h / 2;
        } else {
            rows[rows.length - 1].push(i);
        }
    }
    return rows.flatMap(row => row.sort((a, b) =>
        rects[a].x !== rects[b].x ? rects[a].x - rects[b].x : rects[a].y - rects[b].y));
}

/**
 * @param {Array<{w, h, x, y, recency?, app?}>} items
 * @param {{columns, order, spacing}} options - order: 'position' | 'recent' | 'app'
 * @param {{x, y}} origin - top-left of the screen in view
 * @returns {{rects: Array<{x, y, w, h}>, bounds}} rects indexed like items
 */
export function tidyLayout(items, {columns = 0, order = 'position', spacing = 32} = {}, origin) {
    if (items.length === 0)
        return {rects: [], bounds: null};
    const idx = items.map((_, i) => i);
    let seq = readingOrder(idx, items);
    if (order === 'recent') {
        const pos = new Map(seq.map((i, n) => [i, n]));
        seq = [...seq].sort((a, b) => {
            const ra = items[a].recency ?? Infinity, rb = items[b].recency ?? Infinity;
            return ra !== rb ? ra - rb : pos.get(a) - pos.get(b);
        });
    } else if (order === 'app') {
        const apps = [];
        for (const i of seq) {
            if (!apps.includes(items[i].app))
                apps.push(items[i].app);
        }
        seq = apps.flatMap(app => seq.filter(i => items[i].app === app));
    }
    const cols = columns > 0 ? columns : Math.max(1, Math.ceil(Math.sqrt(items.length)));
    const widths = new Array(cols).fill(0);
    const heights = new Array(Math.ceil(seq.length / cols)).fill(0);
    seq.forEach((i, slot) => {
        widths[slot % cols] = Math.max(widths[slot % cols], items[i].w);
        heights[Math.floor(slot / cols)] = Math.max(heights[Math.floor(slot / cols)], items[i].h);
    });
    const xs = [], ys = [];
    let x = origin.x + spacing;
    for (const w of widths) {
        xs.push(x);
        x += w + spacing;
    }
    let y = origin.y + spacing;
    for (const h of heights) {
        ys.push(y);
        y += h + spacing;
    }
    const rects = items.map(it => ({x: it.x, y: it.y, w: it.w, h: it.h}));
    seq.forEach((i, slot) => {
        rects[i].x = Math.round(xs[slot % cols]);
        rects[i].y = Math.round(ys[Math.floor(slot / cols)]);
    });
    const u = union(rects);
    return {rects, bounds: {x: u.x - spacing, y: u.y - spacing, w: u.w + 2 * spacing, h: u.h + 2 * spacing}};
}

// ---------------------------------------------------------------------------
// Mosaic layout (the alternative Tidy style, after the Mosaic extension):
// windows at native size packed into rows, picking the row width that can be
// shown at the highest zoom in a viewport of the given aspect.

function packRows(items, maxRowWidth, gap) {
    const rows = [];
    let row = null;
    for (const it of items) {
        if (!row || (row.items.length > 0 && row.w + gap + it.w > maxRowWidth)) {
            row = {items: [], w: 0, h: 0};
            rows.push(row);
        }
        row.w += (row.items.length ? gap : 0) + it.w;
        row.h = Math.max(row.h, it.h);
        row.items.push(it);
    }
    const width = Math.max(...rows.map(r => r.w));
    const height = rows.reduce((s, r) => s + r.h, 0) + gap * (rows.length - 1);
    return {rows, width, height};
}

/** @returns {Map<id, {x, y}>} positions with the arrangement centred on (0, 0) */
export function mosaicLayout(items, aspect, gap) {
    const result = new Map();
    if (items.length === 0)
        return result;
    const sorted = [...items].sort((a, b) => b.h - a.h || b.w - a.w);
    const maxW = Math.max(...items.map(i => i.w));
    const totalW = items.reduce((s, i) => s + i.w, 0) + gap * (items.length - 1);

    let best = null, bestScore = -Infinity;
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
        const limit = maxW + (totalW - maxW) * (i / steps);
        const packed = packRows(sorted, limit, gap);
        const score = Math.min(aspect / packed.width, 1 / packed.height);
        if (score > bestScore) {
            bestScore = score;
            best = packed;
        }
    }

    let y = -best.height / 2;
    for (const row of best.rows) {
        let x = -row.w / 2;
        for (const it of row.items) {
            result.set(it.id, {x: Math.round(x), y: Math.round(y + (row.h - it.h) / 2)});
            x += it.w + gap;
        }
        y += row.h + gap;
    }
    return result;
}

/** Grid spacing (canvas units) for the background dots at a given zoom. */
export function gridSpacing(zoom, base = 24, minScreen = 14) {
    let s = base;
    while (s * zoom < minScreen)
        s *= 2;
    return s;
}

// ---------------------------------------------------------------------------
// Remembering windows (Layouts.swift): a window is recognised by its id
// while it lives, then by its app and title, then by its app alone.

/**
 * @param {Array<{seq?, app, title}>} saved
 * @param {Array<{id, seq, app, title}>} current
 * @returns {Map<currentId, savedEntry>}
 */
export function matchWindows(saved, current) {
    const result = new Map();
    const used = new Set();
    const pass = test => {
        for (const c of current) {
            if (result.has(c.id))
                continue;
            const s = saved.find(e => !used.has(e) && test(e, c));
            if (s) {
                result.set(c.id, s);
                used.add(s);
            }
        }
    };
    pass((e, c) => e.seq !== undefined && e.seq === c.seq && e.app === c.app);
    pass((e, c) => e.app === c.app && e.title === c.title);
    pass((e, c) => e.app === c.app);
    return result;
}

/** A frame around `rects`, `pad` out on every side; null around nothing. */
export function frameAround(rects, pad) {
    const u = union(rects);
    return u && {x: u.x - pad, y: u.y - pad, w: u.w + 2 * pad, h: u.h + 2 * pad};
}

/** The windows a frame carries when it moves: those with their middle inside it. */
export function insideFrame(frame, r) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    return cx >= frame.x && cx < frame.x + frame.w && cy >= frame.y && cy < frame.y + frame.h;
}
