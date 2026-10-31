// Run with: make test
import test from 'node:test';
import assert from 'node:assert/strict';

import * as G from '../lib/geometry.js';

const vp = {x: 0, y: 32, w: 1600, h: 968};
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('canvas <-> screen round trip', () => {
    const cam = {cx: 120, cy: -40, zoom: 0.25};
    const [sx, sy] = G.canvasToScreen(cam, vp, 500, 700);
    const [x, y] = G.screenToCanvas(cam, vp, sx, sy);
    assert.ok(close(x, 500) && close(y, 700));
});

test('zoomAround keeps the anchor fixed and clamps', () => {
    const cam = {cx: 0, cy: 0, zoom: 1};
    const before = G.screenToCanvas(cam, vp, 200, 300);
    const z = G.zoomAround(cam, vp, 200, 300, 0.3);
    const after = G.screenToCanvas(z, vp, 200, 300);
    assert.ok(close(before[0], after[0]) && close(before[1], after[1]));
    assert.equal(G.zoomAround(cam, vp, 0, 0, 5).zoom, G.MAX_ZOOM);
    assert.equal(G.zoomAround(cam, vp, 0, 0, 0).zoom, G.MIN_ZOOM);
});

test('lerpCamera is a pure zoom about a fixed point', () => {
    const a = {cx: 0, cy: 0, zoom: 0.2};
    const b = {cx: 1000, cy: 500, zoom: 1};
    const k = (b.cx - a.cx) / (1 / a.zoom - 1 / b.zoom);
    const p = a.cx + k / a.zoom;
    const s = (cam, q) => (q - cam.cx) * cam.zoom;
    const mid = G.lerpCamera(a, b, 0.5);
    assert.ok(close(s(a, p), s(mid, p)) && close(s(b, p), s(mid, p)));
});

test('cameraPath goes from one camera to the other, pulling back on the way', () => {
    const a = {cx: 0, cy: 0, zoom: 1};
    const b = {cx: 6000, cy: 0, zoom: 1};
    const path = G.cameraPath(a, b, vp);
    const s = path.at(0), e = path.at(1), m = path.at(0.5);
    assert.ok(close(s.cx, 0, 1e-3) && close(s.zoom, 1, 1e-6));
    assert.ok(close(e.cx, 6000, 1e-3) && close(e.zoom, 1, 1e-6));
    assert.ok(m.zoom < 0.9, `midpoint zoom ${m.zoom} should pull back`);
    // Pure zoom (no pan) works too.
    const z = G.cameraPath(a, {cx: 0, cy: 0, zoom: 0.25}, vp);
    assert.ok(close(z.at(1).zoom, 0.25, 1e-9));
});

test('spring settles at 0 with a small overshoot', () => {
    assert.ok(close(G.spring(0).x, 1));
    let min = Infinity;
    for (let t = 0; t < 1.5; t += 0.005)
        min = Math.min(min, G.spring(t).x);
    assert.ok(min < 0 && min > -0.1, `overshoot ${min}`);
    assert.ok(Math.abs(G.spring(1.5).x) < 0.002);
});

test('clickEnterCamera keeps the clicked spot under the pointer', () => {
    const cam = {cx: 500, cy: 400, zoom: 0.25};
    const r = {x: 400, y: 300, w: 800, h: 600};
    const [sx, sy] = G.canvasToScreen(cam, vp, 600, 500); // inside r
    const target = G.clickEnterCamera(cam, vp, r, sx, sy);
    const [tx, ty] = G.canvasToScreen(target, vp, 600, 500);
    assert.equal(target.zoom, 1);
    assert.ok(Math.abs(tx - sx) <= 0.5 && Math.abs(ty - sy) <= 0.5);
});

test('clickEnterCamera keeps the title bar below the top of the work area', () => {
    const cam = {cx: 0, cy: 0, zoom: 0.25};
    const r = {x: -400, y: -300, w: 800, h: 600};
    const [sx, sy] = G.canvasToScreen(cam, vp, 0, 250); // near the bottom of the window
    const target = G.clickEnterCamera(cam, vp, r, sx, sy);
    const [, top] = G.canvasToScreen(target, vp, r.x, r.y);
    assert.ok(top >= vp.y);
});

test('inPlaceCamera keeps the title bar where it is on screen', () => {
    const cam = {cx: 0, cy: 0, zoom: 0.92};
    const r = {x: -200, y: -100, w: 800, h: 600};
    const [, before] = G.canvasToScreen(cam, vp, r.x, r.y);
    const target = G.inPlaceCamera(cam, vp, r, 700);
    const [, after] = G.canvasToScreen(target, vp, r.x, r.y);
    assert.ok(Math.abs(after - Math.max(vp.y, before)) <= 0.5);
});

test('fitCamera shows all bounds', () => {
    const bounds = {x: -2000, y: -1000, w: 6000, h: 3000};
    const cam = G.fitCamera(bounds, vp, {margin: 50});
    const view = G.visibleCanvasRect(cam, vp);
    assert.ok(view.x <= bounds.x && view.y <= bounds.y);
    assert.ok(view.x + view.w >= bounds.x + bounds.w && view.y + view.h >= bounds.y + bounds.h);
});

test('cameraToReveal pans minimally, null when visible', () => {
    const cam = {cx: 0, cy: 0, zoom: 1};
    assert.equal(G.cameraToReveal(cam, vp, {x: -100, y: -100, w: 200, h: 200}), null);
    const moved = G.cameraToReveal(cam, vp, {x: 900, y: -100, w: 300, h: 200}, 0);
    const view = G.visibleCanvasRect(moved, vp);
    assert.equal(view.x + view.w, 1200);
    assert.equal(moved.cy, 0);
});

test('placeableOnScreen mirrors mutter constraint', () => {
    assert.ok(G.placeableOnScreen({x: 1500, y: 100, w: 800, h: 600}, vp)); // 100px visible
    assert.ok(!G.placeableOnScreen({x: 1560, y: 100, w: 800, h: 600}, vp)); // 40px visible
    assert.ok(!G.placeableOnScreen({x: 3000, y: 100, w: 800, h: 600}, vp));
});

test('align: edges, centres and the gap beside a neighbour', () => {
    const o = {x: 0, y: 0, w: 400, h: 300};
    // Beside o, a gap away, tops lined up.
    let a = G.align({x: 445, y: 5, w: 200, h: 200}, [o], {threshold: 8, gap: 40});
    assert.deepEqual([a.x, a.y, a.snappedX, a.snappedY], [440, 0, true, true]);
    assert.ok(a.guides.some(g => g.kind === 'gap'));
    assert.ok(a.guides.some(g => g.kind === 'line'));
    // Centres lined up below.
    a = G.align({x: 103, y: 500, w: 200, h: 100}, [o], {threshold: 8, gap: 40});
    assert.equal(a.x, 100);
    assert.equal(a.snappedY, false);
    // Far away: nothing.
    a = G.align({x: 900, y: 900, w: 200, h: 200}, [o], {threshold: 8, gap: 40});
    assert.deepEqual([a.x, a.y, a.snappedX, a.snappedY, a.guides.length], [900, 900, false, false, 0]);
});

test('gridSnap leaves held axes alone', () => {
    assert.deepEqual(G.gridSnap(57, 81, 40), {x: 40, y: 80});
    assert.deepEqual(G.gridSnap(57, 81, 40, true, false), {x: 57, y: 80});
    assert.deepEqual(G.gridSnap(57, 81, 0), {x: 57, y: 81});
});

test('resizeEdges finds edges and generous corners', () => {
    const r = {x: 100, y: 100, w: 400, h: 300};
    assert.deepEqual(G.resizeEdges(102, 250, r), {left: true, right: false, top: false, bottom: false});
    assert.deepEqual(G.resizeEdges(102, 110, r), {left: true, right: false, top: true, bottom: false});
    assert.deepEqual(G.resizeEdges(490, 397, r), {left: false, right: true, top: false, bottom: true});
    assert.equal(G.resizeEdges(300, 250, r), null);
    assert.equal(G.resizeEdges(102, 110, {x: 100, y: 100, w: 50, h: 30}), null); // too small
});

test('resizeRect respects the minimum size and keeps the opposite edge', () => {
    const r = {x: 0, y: 0, w: 400, h: 300};
    assert.deepEqual(G.resizeRect(r, {left: true}, 1000, 0), {x: 240, y: 0, w: 160, h: 300});
    assert.deepEqual(G.resizeRect(r, {right: true, bottom: true}, 50, 20), {x: 0, y: 0, w: 450, h: 320});
});

test('resizeGrid snaps only the moved edges', () => {
    const r = {x: 13, y: 7, w: 405, h: 290};
    assert.deepEqual(G.resizeGrid(r, {right: true}, 40), {x: 13, y: 7, w: 387, h: 290}); // 418 → 400
});

test('newWindowSpot: middle when clear, else beside, in view first', () => {
    const view = {x: 0, y: 0, w: 1600, h: 1000};
    assert.deepEqual(G.newWindowSpot(400, 300, [], view, 32), {x: 600, y: 350, w: 400, h: 300});
    const others = [{x: 500, y: 300, w: 600, h: 400}];
    const s = G.newWindowSpot(400, 300, others, view, 32);
    assert.ok(G.isClear(s, others, 32));
    assert.ok(s.x >= view.x && s.y >= view.y && s.x + s.w <= view.x + view.w && s.y + s.h <= view.y + view.h);
});

test('presets, cycling and gaps', () => {
    const area = {x: 0, y: 0, w: 1200, h: 900};
    assert.deepEqual(G.presetRect('left-half', 0, 0, area, 8), {x: 8, y: 8, w: 588, h: 884});
    assert.deepEqual(G.presetRect('right-half', 0, 0, area, 8), {x: 604, y: 8, w: 588, h: 884});
    assert.deepEqual(G.presetRect('center', 500, 400, area, 8), {x: 350, y: 250, w: 500, h: 400});
    assert.equal(G.nextPreset('left-half', null), 'left-half');
    assert.equal(G.nextPreset('left-half', 'left-half'), 'left-two-thirds');
    assert.equal(G.nextPreset('left-half', 'left-two-thirds'), 'left-third');
    assert.equal(G.nextPreset('left-half', 'left-third'), 'left-half');
    assert.equal(G.nextPreset('right-half', 'left-half'), 'right-half');
    assert.deepEqual(G.presetAnchor('right-half'), {x: 1, y: 0});
});

test('pageContaining lays pages out a gutter apart', () => {
    const screen = {x: 0, y: 32, w: 1600, h: 968};
    assert.deepEqual(G.pageContaining(800, 500, screen), screen);
    assert.deepEqual(G.pageContaining(2000, 500, screen), {x: 1840, y: 32, w: 1600, h: 968});
    assert.deepEqual(G.pageContaining(-200, 500, screen), {x: -1840, y: 32, w: 1600, h: 968});
});

test('readingOrder reads rows by where windows sit', () => {
    const rects = [
        {x: 500, y: 10, w: 100, h: 100},
        {x: 0, y: 40, w: 100, h: 100}, // starts above the first row's middle: same row
        {x: 0, y: 300, w: 100, h: 100},
    ];
    assert.deepEqual(G.readingOrder([0, 1, 2], rects), [1, 0, 2]);
});

test('tidyLayout keeps sizes in a sqrt grid without overlaps', () => {
    const items = [];
    for (let i = 0; i < 7; i++)
        items.push({x: i * 37, y: (i % 3) * 400, w: 300 + (i % 3) * 120, h: 200 + (i % 2) * 150, app: `a${i % 2}`});
    const {rects, bounds} = G.tidyLayout(items, {spacing: 32}, {x: 0, y: 0});
    for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++)
            assert.ok(!G.intersects(rects[i], rects[j]), `${i} overlaps ${j}`);
        assert.equal(rects[i].w, items[i].w);
    }
    const cols = new Set(rects.map(r => r.x));
    assert.equal(cols.size, 3); // ceil(sqrt(7))
    assert.equal(Math.min(...rects.map(r => r.x)), 32);
    assert.equal(bounds.x, 0);
    // App order groups an app's windows together.
    const byApp = G.tidyLayout(items, {spacing: 32, order: 'app'}, {x: 0, y: 0});
    assert.equal(byApp.rects.length, 7);
});

test('mosaicLayout produces a non-overlapping, centred layout', () => {
    const items = [];
    for (let i = 0; i < 9; i++)
        items.push({id: i, w: 400 + (i % 3) * 200, h: 300 + (i % 2) * 250});
    const pos = G.mosaicLayout(items, 16 / 10, 16);
    const rects = items.map(i => ({...pos.get(i.id), w: i.w, h: i.h}));
    for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++)
            assert.ok(!G.intersects(rects[i], rects[j]));
    }
    const u = G.union(rects);
    assert.ok(Math.abs(u.x + u.w / 2) <= 1 && Math.abs(u.y + u.h / 2) <= 1);
});

test('clusterOf follows chains of touching windows', () => {
    const items = [
        {id: 'a', x: 0, y: 0, w: 100, h: 100},
        {id: 'b', x: 140, y: 0, w: 100, h: 100},
        {id: 'c', x: 280, y: 0, w: 100, h: 100},
        {id: 'd', x: 800, y: 0, w: 100, h: 100},
    ];
    assert.deepEqual(G.clusterOf('a', items, 40).sort(), ['a', 'b', 'c']);
    assert.deepEqual(G.clusterOf('d', items, 40), ['d']);
});

test('matchWindows: id, then app and title, then app', () => {
    const saved = [
        {seq: 7, app: 'term', title: 'one', x: 1},
        {app: 'term', title: 'two', x: 2},
        {app: 'web', title: 'old title', x: 3},
        {app: 'gone', title: 'x', x: 4},
    ];
    const current = [
        {id: 'A', seq: 7, app: 'term', title: 'renamed'},
        {id: 'B', seq: 9, app: 'term', title: 'two'},
        {id: 'C', seq: 10, app: 'web', title: 'new title'},
        {id: 'D', seq: 11, app: 'other', title: 'x'},
    ];
    const m = G.matchWindows(saved, current);
    assert.equal(m.get('A').x, 1);
    assert.equal(m.get('B').x, 2);
    assert.equal(m.get('C').x, 3);
    assert.equal(m.has('D'), false);
});

test('gridSpacing grows as we zoom out', () => {
    assert.equal(G.gridSpacing(1), 24);
    assert.ok(G.gridSpacing(0.1) * 0.1 >= 14);
});

test('newWindowSpot: Open Here… centres on the spot, else the nearest free place to it', () => {
    const view = {x: 0, y: 0, w: 1600, h: 1000};
    const free = G.newWindowSpot(400, 300, [], view, 16, {x: 300, y: 200});
    assert.deepEqual(free, {x: 100, y: 50, w: 400, h: 300});
    const busy = [{x: 0, y: 0, w: 600, h: 400}];
    const beside = G.newWindowSpot(400, 300, busy, view, 16, {x: 300, y: 200});
    assert.ok(G.isClear(beside, busy, 16));
    assert.ok(beside.x === 616 || beside.y === 416);
});

test('mergeOffsets: each canvas goes to the right of the ones before, top-aligned, arrangement kept', () => {
    const groups = [
        [{x: 0, y: 0, w: 100, h: 100}, {x: 120, y: 50, w: 80, h: 80}],
        [],
        [{x: -500, y: 300, w: 50, h: 60}, {x: -400, y: 320, w: 50, h: 60}],
    ];
    const off = G.mergeOffsets(groups, 240);
    assert.deepEqual(off[0], [0, 0]);
    assert.deepEqual(off[1], [0, 0]);
    assert.deepEqual(off[2], [200 + 240 + 500, -300]);
    const moved = groups[2].map(r => ({...r, x: r.x + off[2][0], y: r.y + off[2][1]}));
    assert.equal(moved[1].x - moved[0].x, 100);
    assert.ok(moved.every(r => G.isClear(r, groups[0], 240)));
});

test('cameraToReveal: no flight for a window nearly in view (tall windows used to creep)', () => {
    const cam = {cx: 800, cy: 516, zoom: 1};
    const view = G.visibleCanvasRect(cam, vp);
    // As tall as the view less a few px, two px off its centre.
    const tall = {x: 300, y: view.y + 2, w: 900, h: view.h - 4};
    assert.equal(G.cameraToReveal(cam, vp, {...tall, y: tall.y - 2}, 32), null);
    // 30 px past the right edge: close enough.
    assert.equal(G.cameraToReveal(cam, vp, {x: view.x + view.w - 170, y: view.y + 100, w: 200, h: 200}, 0), null);
    // Half off screen: worth it.
    assert.ok(G.cameraToReveal(cam, vp, {x: view.x + view.w - 100, y: view.y + 100, w: 200, h: 200}, 0));
});

test('wellInView: a window mostly on screen with its top showing needs no camera move', () => {
    const cam = {cx: 800, cy: 516, zoom: 1};
    const view = G.visibleCanvasRect(cam, vp);
    // As tall as the view, 110 px past the bottom: fine.
    assert.ok(G.wellInView(cam, vp, {x: 200, y: view.y + 110, w: 1150, h: view.h}));
    // Its title bar above the top: not.
    assert.ok(!G.wellInView(cam, vp, {x: 200, y: view.y - 20, w: 1150, h: 600}));
    // Half off the side: not.
    assert.ok(!G.wellInView(cam, vp, {x: view.x + view.w - 300, y: view.y + 50, w: 600, h: 400}));
});

test('frames: around windows with padding, and which windows a frame carries', () => {
    const f = G.frameAround([{x: 100, y: 100, w: 400, h: 300}, {x: 600, y: 120, w: 300, h: 500}], 40);
    assert.deepEqual(f, {x: 60, y: 60, w: 880, h: 600});
    assert.equal(G.frameAround([], 40), null);
    assert.ok(G.insideFrame(f, {x: 100, y: 100, w: 400, h: 300}));
    // Hanging out of it, but its middle inside: carried.
    assert.ok(G.insideFrame(f, {x: 800, y: 500, w: 200, h: 200}));
    // Its middle outside: left where it is.
    assert.ok(!G.insideFrame(f, {x: 900, y: 500, w: 200, h: 200}));
});
