// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as E from '../lib/windowEffects.js';

test('styleFor: none and reduce-motion', () => {
    assert.equal(E.styleFor('none', {source: {x: 1, y: 2}}), null);
    assert.equal(E.styleFor('bloom', {}, true), 'dissolve');
    assert.equal(E.styleFor('automatic', {}, true), 'dissolve');
});

test('styleFor: automatic picks from context', () => {
    assert.equal(E.styleFor('automatic', {attached: true}), 'unfold');
    assert.equal(E.styleFor('automatic', {source: {x: 0, y: 0}}), 'source');
    assert.equal(E.styleFor('automatic', {neighbour: {x: 0, y: 0, w: 10, h: 10}}), 'dealt');
    assert.equal(E.styleFor('automatic', {}), 'sunrise');
    assert.equal(E.styleFor('bloom', {}), 'bloom');
});

test('usable: missing geometry falls back to sunrise', () => {
    assert.equal(E.usable('source', {}), 'sunrise');
    assert.equal(E.usable('dealt', {}), 'sunrise');
    assert.equal(E.usable('source', {toSource: {dx: 1, dy: 2}}), 'source');
    assert.equal(E.usable('bloom', {}), 'bloom');
});

test('geometryFrom: vectors from window centre', () => {
    const g = E.geometryFrom({x: 0, y: 0, w: 200, h: 100}, {
        source: {x: 100, y: 0},
        neighbour: {x: 300, y: 0, w: 100, h: 100},
    });
    assert.deepEqual(g.toSource, {dx: 0, dy: -50});
    assert.deepEqual(g.toNeighbour, {dx: 250, dy: 0});
});

test('frame: opening sunrise ends at identity', () => {
    const end = E.frame('sunrise', true, 1);
    assert.equal(end.scaleX, 1);
    assert.equal(end.opacity, 1);
    assert.equal(end.offsetY, 0);
    const mid = E.frame('sunrise', true, 0.1);
    assert.ok(mid.opacity < 1);
    assert.ok(mid.offsetY > 0);
});

test('frame: closing dissolve fades out', () => {
    const start = E.frame('dissolve', false, 0);
    const end = E.frame('dissolve', false, 1);
    assert.equal(start.opacity, 1);
    assert.ok(end.opacity < 0.01);
});

test('frame: source uses toSource offset', () => {
    const g = {toSource: {dx: 40, dy: -20}};
    const start = E.frame('source', true, 0, g);
    assert.ok(Math.abs(start.offsetX - 40) < 1);
    assert.ok(Math.abs(start.offsetY - -20) < 1);
    assert.ok(start.scaleX < 0.3);
});

test('durationMs: close shorter than open for bloom', () => {
    assert.ok(E.durationMs('bloom', true) > E.durationMs('bloom', false));
});
