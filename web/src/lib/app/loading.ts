// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** What startup is doing, for the loading screen (App.svelte). */

import { writable } from "svelte/store";

export interface LoadingStage {
    label: string;
    /** Bytes so far and expected, for a download; total is 0 if unknown. */
    loaded?: number;
    total?: number;
}

export const loadingStage = writable<LoadingStage>({ label: "Loading…" });

export function setLoadingStage(label: string, loaded?: number, total?: number): void {
    loadingStage.set({ label, loaded, total });
}
