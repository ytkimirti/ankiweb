// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { get } from "svelte/store";

import type { PluginApi } from "$web/plugins/loader";

/**
 * Runs `fn` each time a profile opens, once the sync it opens with has
 * finished, as Enhanced Cloze does: a note type added before that sync would
 * be added again by every other device that has not synced it yet. When the
 * plugin starts with a profile open (installed or enabled now), it also runs
 * once any sync running is done.
 */
export function afterStartupSync(api: PluginApi, fn: () => void): void {
    let removed = false;
    api.onUnload(() => (removed = true));
    let syncing = false;
    let afterSync = false;
    let opening = false;
    const whenNotSyncing = () => {
        if (removed) {
            return;
        }
        if (syncing) {
            afterSync = true;
        } else {
            fn();
        }
    };
    api.hooks.syncWillStart.append(() => {
        syncing = true;
    });
    api.hooks.syncDidFinish.append(() => {
        syncing = false;
        if (afterSync) {
            afterSync = false;
            fn();
        }
    });
    api.hooks.profileDidOpen.append(() => {
        opening = true;
    });
    api.hooks.stateDidChange.append((state) => {
        if (opening && state === "deckBrowser") {
            opening = false;
            // the automatic sync starts right after the deck list shows
            setTimeout(whenNotSyncing, 0);
        }
    });
    if (["deckBrowser", "overview", "review"].includes(get(api.main.mainState))) {
        void import("../../lib/app/sync").then(({ syncState }) => {
            syncing ||= get(syncState).syncing;
            whenNotSyncing();
        });
    }
}
