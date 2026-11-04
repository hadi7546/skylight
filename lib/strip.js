// Strip mode: every window on one endless
// horizontal strip, one column per app, the app used last on the left and
// each one used before it further right; inside a column the app's windows
// stacked top to bottom, the one used last on top. Nothing is resized.
// Pure: items in, columns and rects out; the controller gathers the windows
// and animates.

/**
 * The columns, left to right, each a list of item indices top to bottom. An
 * app's column goes by its most recently used window, a column by its
 * windows' recency; apps and windows never used come after, in the order
 * they sit now (left to right, top to bottom).
 * @param {Array<{rect, app, recency: number|null}>} items
 */
export function columns(items) {
    const byApp = new Map();
    items.forEach((item, i) => {
        if (!byApp.has(item.app))
            byApp.set(item.app, []);
        byApp.get(item.app).push(i);
    });
    const rank = i => items[i].recency ?? Infinity;
    const cols = [...byApp.values()].map(col => col.sort((a, b) =>
        rank(a) - rank(b) || items[a].rect.y - items[b].rect.y || items[a].rect.x - items[b].rect.x || a - b));
    const key = col => [Math.min(...col.map(rank)), Math.min(...col.map(i => items[i].rect.x))];
    return cols
        .map((col, order) => ({col, key: key(col), order}))
        .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.order - b.order)
        .map(c => c.col);
}

/**
 * `cols` laid out from `origin` (the top-left of the first window): each
 * column as wide as its widest window, `gap` between columns and between the
 * windows stacked in one, every window at the left of its column.
 * @returns {{rects, bounds}} - rects indexed like the items
 */
export function layout(items, cols, origin, gap) {
    const rects = items.map(i => ({...i.rect}));
    let x = origin.x, bottom = origin.y;
    for (const col of cols) {
        if (col.length === 0)
            continue;
        let y = origin.y, width = 0;
        for (const i of col) {
            rects[i].x = Math.round(x);
            rects[i].y = Math.round(y);
            y += items[i].rect.h + gap;
            width = Math.max(width, items[i].rect.w);
        }
        bottom = Math.max(bottom, y - gap);
        x += width + gap;
    }
    const bounds = {x: origin.x - gap, y: origin.y - gap, w: x - origin.x + gap, h: bottom - origin.y + 2 * gap};
    return {rects, bounds};
}

/**
 * The order after item `dropped` was let go at `rects[dropped]`: its column
 * goes where it was dropped, past a neighbouring column once its middle is
 * past that column's middle, and inside its column it takes the place its
 * middle is at. Every other rect is where it sits on the strip.
 */
export function reordered(cols, rects, dropped) {
    const middleX = col => {
        if (col.includes(dropped))
            return rects[dropped].x + rects[dropped].w / 2;
        const x1 = Math.min(...col.map(i => rects[i].x));
        const x2 = Math.max(...col.map(i => rects[i].x + rects[i].w));
        return (x1 + x2) / 2;
    };
    const keys = cols.map(middleX);
    const order = cols.map((_, i) => i).sort((a, b) => keys[a] - keys[b] || a - b);
    return order.map(c => {
        const col = cols[c];
        if (!col.includes(dropped))
            return col;
        const rest = col.filter(i => i !== dropped);
        const mid = rects[dropped].y + rects[dropped].h / 2;
        let at = rest.findIndex(i => mid < rects[i].y + rects[i].h / 2);
        if (at < 0)
            at = rest.length;
        return [...rest.slice(0, at), dropped, ...rest.slice(at)];
    });
}

/**
 * Where the arrow keys go from `item`: left and right the top window of the
 * next column that has one present, up and down the next one in its own
 * column. `away` (minimised) windows are skipped; null at either end.
 */
export function neighbour(item, cols, away, direction) {
    const c = cols.findIndex(col => col.includes(item));
    if (c < 0)
        return null;
    const present = i => !away[i];
    if (direction === 'left' || direction === 'right') {
        const step = direction === 'left' ? -1 : 1;
        for (let n = c + step; n >= 0 && n < cols.length; n += step) {
            const top = cols[n].find(present);
            if (top !== undefined)
                return top;
        }
        return null;
    }
    const col = cols[c];
    const step = direction === 'up' ? -1 : 1;
    for (let r = col.indexOf(item) + step; r >= 0 && r < col.length; r += step) {
        if (present(col[r]))
            return col[r];
    }
    return null;
}
