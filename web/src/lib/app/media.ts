// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Media files are served at the site root by the service worker, straight
 * from the open profile's media folder in OPFS, so card HTML's relative
 * references like <img src="cat.jpg"> resolve as they do on desktop.
 */

import { writable } from "svelte/store";

export const STATE_CACHE = "ankiweb-state";
export const PROFILE_KEY = "/__ankiweb/media-profile";

export function mediaUrl(filename: string): string {
    return `/${encodeURIComponent(filename)}`;
}

/**
 * Counts media sync's downloads, so cards on screen can retry images that
 * were missing until now.
 */
export const mediaArrived = writable(0);

let current: string | null = null;

/** The profile whose media folder is served. */
export function mediaProfile(): string | null {
    return current;
}

/** Tells the service worker whose media folder to serve. */
export async function setMediaProfile(name: string | null): Promise<void> {
    current = name;
    try {
        const cache = await caches.open(STATE_CACHE);
        if (name) {
            await cache.put(PROFILE_KEY, new Response(name));
        } else {
            await cache.delete(PROFILE_KEY);
        }
    } catch (err) {
        console.warn("could not store media profile", err);
    }
    navigator.serviceWorker?.controller?.postMessage({ type: "mediaProfile", name });
}
