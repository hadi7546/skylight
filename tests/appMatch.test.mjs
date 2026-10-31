// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

// Run with: make test
import test from 'node:test';
import assert from 'node:assert/strict';

import * as M from '../lib/appMatch.js';

const apps = [
    {id: 'org.gnome.Calculator.desktop', name: 'Calculator', terms: ['math']},
    {id: 'code.desktop', name: 'Visual Studio Code', terms: ['editor', 'code']},
    {id: 'firefox.desktop', name: 'Firefox', terms: ['Web Browser', 'internet']},
    {id: 'org.gnome.Nautilus.desktop', name: 'Files', terms: ['File Manager', 'nautilus']},
    {id: 'org.gnome.TextEditor.desktop', name: 'Text Editor', terms: ['gnome-text-editor']},
];
const names = list => list.map(a => a.name);

test('score: prefix > word start > substring > subsequence', () => {
    assert.equal(M.score('vis', 'visual studio code'), 100);
    assert.equal(M.score('stu', 'visual studio code'), 80);
    assert.equal(M.score('ual', 'visual studio code'), 60);
    const s = M.score('vsc', 'visual studio code');
    assert.ok(s > 0 && s < 60);
    assert.equal(M.score('xyz', 'visual studio code'), null);
});

test('search: empty query lists recents first, then the rest in order', () => {
    const r = M.search(apps, '', ['firefox.desktop', 'gone.desktop']);
    assert.deepEqual(names(r), ['Firefox', 'Calculator', 'Visual Studio Code', 'Files', 'Text Editor']);
});

test('search: names beat other terms, recents break near-ties', () => {
    assert.deepEqual(names(M.search(apps, 'edi', [])), ['Text Editor', 'Visual Studio Code']);
    assert.deepEqual(names(M.search(apps, 'browser', [])), ['Firefox']);
    assert.deepEqual(names(M.search(apps, 'vsc', [])), ['Visual Studio Code']);
    // "f" is a prefix of both Files and Firefox; the recent one wins.
    assert.deepEqual(names(M.search(apps, 'f', ['org.gnome.Nautilus.desktop'])).slice(0, 2), ['Files', 'Firefox']);
    assert.deepEqual(names(M.search(apps, 'f', ['firefox.desktop'])).slice(0, 2), ['Firefox', 'Files']);
});

test('noteLaunch: most recent first, no duplicates, bounded', () => {
    let r = [];
    for (let i = 0; i < 30; i++)
        r = M.noteLaunch(r, `a${i % 25}`);
    r = M.noteLaunch(r, 'a3');
    assert.equal(r[0], 'a3');
    assert.equal(r.length, M.RECENTS_LIMIT);
    assert.equal(new Set(r).size, r.length);
});

test('rankByNames: any name counts, best first, nothing for an empty query', () => {
    const items = [
        {id: 'term', names: ['~/src/skylight — bash', 'Terminal']},
        {id: 'firefox', names: ['GNOME Shell Extensions — Mozilla Firefox', 'Firefox']},
        {id: 'files', names: ['Downloads', 'Files']},
        {id: 'frame', names: ['Work']},
    ];
    assert.deepEqual(M.rankByNames(items, 'fire'), ['firefox']);
    assert.deepEqual(M.rankByNames(items, 'sky'), ['term']);
    assert.deepEqual(M.rankByNames(items, 'f').slice(0, 2), ['firefox', 'files']);
    assert.deepEqual(M.rankByNames(items, 'work'), ['frame']);
    assert.deepEqual(M.rankByNames(items, '  '), []);
});
