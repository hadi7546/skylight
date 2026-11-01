// The spotlight's app results come from GNOME's own search, the way
// itsnin/spotlight does it: the Overview's SearchResultsView (with every
// search provider GNOME has registered: apps, settings, calculator, files,
// web…) is borrowed, shown under our own entry, and handed back afterwards.
// We feed it the typed terms and forward ↑↓/Return; nothing is re-implemented.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

function resultsView() {
    return Main.overview?.searchController?._searchResults ?? null;
}

/** GNOME's search terms: whitespace-separated words. */
function termsOf(text) {
    const t = text.trim();
    return t ? t.split(/\s+/) : [];
}

export class GnomeSearch {
    /** @param {Function} onActivate - a result was activated (spotlight should close) */
    constructor(onActivate) {
        this._onActivate = onActivate;
        this._view = null;
        this._home = null; // {parent, index}
        this._origToggle = null;
        this.actor = new St.BoxLayout({style_class: 'skylight-gnome-results', visible: false, y_expand: false});
        this.actor.orientation = Clutter.Orientation.VERTICAL;
    }

    static get available() {
        return resultsView() !== null;
    }

    get attached() {
        return this._view !== null;
    }

    /** Borrow the results view from the Overview's search controller. */
    attach(maxHeight) {
        if (this._view)
            return;
        const view = resultsView();
        if (!view)
            return;
        this._view = view;
        const parent = view.get_parent();
        this._home = parent ? {parent, index: parent.get_children().indexOf(view)} : null;
        parent?.remove_child(view);
        view.set_style(`max-height: ${Math.round(maxHeight)}px;`);
        this._wasYExpand = view.y_expand;
        view.y_expand = false; // else the whole spotlight stretches down the view
        this.actor.add_child(view);
        view.highlightDefault(true);
        // Activating a result ends with Overview.toggle() — which would open
        // the Overview here. Make it close the spotlight instead.
        // Remember whether `toggle` was an own property: restoring it by
        // assignment would pin whatever wrapper was in place (e.g. Skylight's
        // own overview swap) on the instance, outliving the extension.
        this._hadOwnToggle = Object.prototype.hasOwnProperty.call(Main.overview, 'toggle');
        this._origToggle = Main.overview.toggle;
        Main.overview.toggle = () => {
            this.actor.hide(); // at once, whatever the callback does
            this._onActivate();
        };
    }

    /** Hand it back to the Overview. */
    detach() {
        const view = this._view;
        if (!view)
            return;
        this._view = null;
        view.setTerms([]);
        view.highlightDefault(false);
        view.set_style(null);
        this._maxPx = 0;
        view.y_expand = this._wasYExpand ?? true;
        this.actor.remove_child(view);
        this.actor.hide();
        if (this._home?.parent) {
            this._home.parent.insert_child_at_index(view, this._home.index);
            // The controller keeps itself hidden outside the Overview.
        }
        this._home = null;
        if (this._origToggle) {
            if (this._hadOwnToggle)
                Main.overview.toggle = this._origToggle;
            else
                delete Main.overview.toggle;
            this._origToggle = null;
        }
    }

    setMaxHeight(maxHeight) {
        // Restyling the results is not free: only when it changes.
        const px = Math.round(maxHeight);
        if (!this._view || px === this._maxPx)
            return;
        this._maxPx = px;
        this._view.set_style(`max-height: ${px}px;`);
    }

    /** Search for what's typed; nothing typed hides the results. */
    setText(text) {
        if (!this._view)
            return;
        const terms = termsOf(text);
        this._view.setTerms(terms);
        this.actor.visible = terms.length > 0;
    }

    get hasResults() {
        return this.actor.visible;
    }

    /** ↓ / Tab from the entry: onto the first result. */
    focusResults(backwards = false) {
        if (!this._view || !this.actor.visible)
            return false;
        this._view.navigateFocus(backwards ? St.DirectionType.TAB_BACKWARD : St.DirectionType.DOWN);
        return true;
    }

    /** Return in the entry: the highlighted (default) result. */
    activateDefault() {
        if (!this._view || !this.actor.visible)
            return false;
        this._view.activateDefault();
        return true;
    }

    /** Is the key focus inside the results (not the entry)? */
    containsFocus() {
        const focus = global.stage.get_key_focus();
        return !!focus && !!this._view && this._view.contains(focus);
    }

    destroy() {
        this.detach();
        this.actor.destroy();
    }
}
