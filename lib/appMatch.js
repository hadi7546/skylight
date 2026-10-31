// Picking apps for Open Here…, after Sunlight's AppCatalog: a small fuzzy
// matcher over app names, with the apps you open often floating to the top.
// Pure, so it can be unit-tested outside GNOME Shell.

export const RECENTS_LIMIT = 20;

/** Prefix beats word start beats substring beats a scattered subsequence; null for no match. */
export function score(query, name) {
    if (name.startsWith(query))
        return 100;
    const words = name.split(/[\s\-._]+/);
    if (words.some(w => w.startsWith(query)))
        return 80;
    if (name.includes(query))
        return 60;
    let at = 0, gaps = 0;
    for (let i = 0; i < query.length; i++) {
        const found = name.indexOf(query[i], at);
        if (found < 0)
            return null;
        if (i > 0)
            gaps += found - at;
        at = found + 1;
    }
    return Math.max(1, 40 - gaps);
}

/**
 * @param {Array<{id, name, terms?: string[]}>} apps - in display order (alphabetical)
 * @param {string} query
 * @param {string[]} recents - app ids, most recent first
 * @param {number} limit
 * @returns the apps to list: with no query recents first, then everything;
 *   otherwise the best matches. The name counts fully, other terms (generic
 *   name, keywords, command) at half.
 */
export function search(apps, query, recents, limit = 40) {
    const q = query.trim().toLowerCase();
    if (!q) {
        const byId = new Map(apps.map(a => [a.id, a]));
        const first = recents.map(id => byId.get(id)).filter(Boolean);
        const seen = new Set(first);
        return [...first, ...apps.filter(a => !seen.has(a))].slice(0, limit);
    }
    const rank = new Map(recents.map((id, i) => [id, i]));
    const scored = [];
    for (const app of apps) {
        let s = score(q, app.name.toLowerCase());
        for (const term of app.terms ?? []) {
            const t = score(q, term.toLowerCase());
            if (t !== null && (s === null || t / 2 > s))
                s = t / 2;
        }
        if (s === null)
            continue;
        if (rank.has(app.id))
            s += Math.max(0, 20 - rank.get(app.id));
        scored.push([app, s]);
    }
    scored.sort((a, b) => b[1] - a[1] || a[0].name.localeCompare(b[0].name));
    return scored.slice(0, limit).map(([app]) => app);
}

/** The recents list after opening `id`. */
export function noteLaunch(recents, id) {
    return [id, ...recents.filter(r => r !== id)].slice(0, RECENTS_LIMIT);
}

/**
 * Things with names (windows: title and app; frames: their name) matching
 * `query`, best first; each counts its best name. Ties keep the given order.
 * @param {Array<{id, names: string[]}>} items
 * @returns the matching ids
 */
export function rankByNames(items, query) {
    const q = query.trim().toLowerCase();
    if (!q)
        return [];
    const scored = [];
    items.forEach((item, i) => {
        let best = null;
        for (const name of item.names) {
            const s = name ? score(q, name.toLowerCase()) : null;
            if (s !== null && (best === null || s > best))
                best = s;
        }
        if (best !== null)
            scored.push([item.id, best, i]);
    });
    scored.sort((a, b) => b[1] - a[1] || a[2] - b[2]);
    return scored.map(([id]) => id);
}
