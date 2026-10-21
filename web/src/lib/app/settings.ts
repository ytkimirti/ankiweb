// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** Settings shared by all profiles (desktop's pm.meta), as stores. */

import { writable, type Writable } from "svelte/store";

import { getMeta, setMeta } from "./profiles";

function metaStore<T>(key: string, fallback: T): Writable<T> {
    const store = writable<T>(getMeta<T>(key, fallback));
    let first = true;
    store.subscribe((value) => {
        if (!first) {
            setMeta(key, value);
        }
        first = false;
    });
    return store;
}

export const reduceMotion = metaStore("reduceMotion", false);
/** 1 is 100%. */
export const uiScale = metaStore("uiScale", 1);
export const hideTopBar = metaStore("hideTopBar", false);
export const hideBottomBar = metaStore("hideBottomBar", false);
/** 0: only in full screen, 1: always. */
export const topBarHideMode = metaStore<0 | 1>("topBarHideMode", 0);
export const bottomBarHideMode = metaStore<0 | 1>("bottomBarHideMode", 0);

export const fullScreen = writable(!!document.fullscreenElement);
document.addEventListener("fullscreenchange", () => fullScreen.set(!!document.fullscreenElement));

export function toggleFullScreen(): void {
    if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
    } else {
        void document.documentElement.requestFullscreen?.().catch(() => {});
    }
}

reduceMotion.subscribe((on) => document.body?.classList.toggle("reduce-motion", on));
uiScale.subscribe((scale) => {
    document.documentElement.style.setProperty("zoom", scale === 1 ? "" : String(scale));
});

export function zoomBy(step: number): void {
    uiScale.update((scale) => Math.min(2, Math.max(0.5, Math.round((scale + step) * 10) / 10)));
}
