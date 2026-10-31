// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

// Run with: make test. After Sunlight's StripTests.swift.
import test from 'node:test';
import assert from 'node:assert/strict';

import * as S from '../lib/strip.js';

const item = (app, x = 0, y = 0, {w = 400, h = 300, recency = null} = {}) =>
    ({rect: {x, y, w, h}, app, recency});

test('the most recent app is the first column', () => {
    const items = [item('Mail', 0, 0, {recency: 2}), item('Safari', 0, 0, {recency: 0}), item('Xcode', 0, 0, {recency: 1})];
    assert.deepEqual(S.columns(items), [[1], [2], [0]]);
});

test("an app's windows share a column, the most recent on top", () => {
    const items = [item('Safari', 0, 0, {recency: 3}), item('Mail', 0, 0, {recency: 1}), item('Safari', 0, 0, {recency: 0})];
    assert.deepEqual(S.columns(items), [[2, 0], [1]]);
});

test('never used come after, in the order they sit', () => {
    const items = [item('Notes', 900), item('Mail', 0, 0, {recency: 0}), item('Finder', 100), item('Music', 500)];
    assert.deepEqual(S.columns(items), [[1], [2], [3], [0]]);
    const stacked = [item('Safari', 0, 600), item('Safari', 0, 40), item('Safari', 0, 300, {recency: 4})];
    assert.deepEqual(S.columns(stacked), [[2, 1, 0]]);
});

test('columns are as wide as their widest window, with the gap between; nothing resized', () => {
    const items = [item('Safari', 0, 0, {w: 600, h: 400, recency: 0}), item('Safari', 0, 0, {w: 300, h: 200, recency: 1}),
        item('Mail', 0, 0, {w: 500, h: 700, recency: 2})];
    const placed = S.layout(items, S.columns(items), {x: 32, y: 57}, 32);
    assert.deepEqual(placed.rects[0], {x: 32, y: 57, w: 600, h: 400});
    assert.deepEqual(placed.rects[1], {x: 32, y: 489, w: 300, h: 200});
    assert.deepEqual(placed.rects[2], {x: 664, y: 57, w: 500, h: 700});
    assert.deepEqual(placed.bounds, {x: 0, y: 25, w: 1196, h: 764});
});

test("dropping past a neighbour's middle swaps the columns; within a column, the place its middle is at", () => {
    const items = [item('A', 0, 0, {recency: 0}), item('B', 0, 0, {recency: 1}), item('C', 0, 0, {recency: 2})];
    const cols = S.columns(items);
    const rects = S.layout(items, cols, {x: 0, y: 0}, 20).rects;
    const midB = rects[1].x + rects[1].w / 2;
    assert.deepEqual(S.reordered(cols, rects.map((r, i) => i === 0 ? {...r, x: midB + 10 - r.w / 2} : r), 0), [[1], [0], [2]]);
    assert.deepEqual(S.reordered(cols, rects.map((r, i) => i === 0 ? {...r, x: midB - 10 - r.w / 2} : r), 0), [[0], [1], [2]]);

    const stack = [item('A', 0, 0, {recency: 0}), item('A', 0, 0, {recency: 1})];
    const sc = S.columns(stack);
    const sr = S.layout(stack, sc, {x: 0, y: 0}, 20).rects;
    assert.deepEqual(S.reordered(sc, sr.map((r, i) => i === 0 ? {...r, y: sr[1].y + 10} : r), 0), [[1, 0]]);
});

test('the arrow keys: the next column with a window present, the next in the column; null at the ends', () => {
    const cols = [[0, 1], [2], [3]];
    const away = [false, false, true, false];
    assert.equal(S.neighbour(0, cols, away, 'right'), 3);
    assert.equal(S.neighbour(3, cols, away, 'left'), 0);
    assert.equal(S.neighbour(0, cols, away, 'down'), 1);
    assert.equal(S.neighbour(1, cols, away, 'up'), 0);
    assert.equal(S.neighbour(0, cols, away, 'left'), null);
    assert.equal(S.neighbour(1, cols, away, 'down'), null);
});
