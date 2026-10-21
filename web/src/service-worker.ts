// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

/**
 * Makes the app work offline, keeps it cross-origin isolated when the server
 * does not send COOP/COEP headers, and serves media files at the site root
 * from the open profile's media folder in OPFS, the way desktop's media
 * server serves collection.media.
 *
 * The same worker runs on the card origin (see lib/config.ts), where it serves
 * only the card frame: it asks the frame, which asks the app, for media files,
 * since the media folder belongs to the app's origin.
 */

import { build, files, version } from "$service-worker";

import { isCardOrigin } from "./lib/config";
import { type MediaFile, readMediaFile } from "./lib/media-file";

const sw = self as unknown as ServiceWorkerGlobalScope;

const APP_CACHE = `ankiweb-app-${version}`;
const RUNTIME_CACHE = `ankiweb-runtime-${version}`;
const STATE_CACHE = "ankiweb-state";
const PROFILE_KEY = "/__ankiweb/media-profile";
/** The app shell; every page is the single-page app (adapter-static's fallback). */
const INDEX = "/";
/** Large and only needed by cards that use MathJax, so cached on first use. */
const RUNTIME_PREFIXES = ["/_anki/js/vendor/"];

const cardMode = isCardOrigin();
/** Card frames do not run the engine. */
const CARD_SKIPPED = ["/engine/", "/icons/"];

const precached = new Set([
    ...build,
    ...files.filter((f) =>
        !RUNTIME_PREFIXES.some((p) => f.startsWith(p)) && !(cardMode && CARD_SKIPPED.some((p) => f.startsWith(p)))
    ),
    INDEX,
]);

// Safari has no COEP credentialless; require-corp blocks cross-origin images
// without CORP headers there, which is the best it supports.
const coep = /Version\/[\d.]+.*Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent)
    ? "require-corp"
    : "credentialless";

let mediaProfile: string | null | undefined;

sw.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(APP_CACHE);
            await cache.addAll([...precached]);
        })(),
    );
});

sw.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            for (const key of await caches.keys()) {
                const versioned = key.startsWith("ankiweb-app-") || key.startsWith("ankiweb-runtime");
                if (versioned && key !== APP_CACHE && key !== RUNTIME_CACHE) {
                    await caches.delete(key);
                }
            }
            await sw.clients.claim();
        })(),
    );
});

sw.addEventListener("message", (event) => {
    const data = event.data as { type?: string; name?: string | null } | undefined;
    if (data?.type === "mediaProfile") {
        mediaProfile = data.name ?? null;
    } else if (data?.type === "skipWaiting") {
        void sw.skipWaiting();
    }
});

sw.addEventListener("fetch", (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== "GET" || url.origin !== sw.location.origin || url.pathname.startsWith("/ankiweb-proxy/")) {
        return;
    }
    event.respondWith(respond(request, url, event.clientId));
});

async function respond(request: Request, url: URL, clientId: string): Promise<Response> {
    const path = url.pathname;
    if (precached.has(path)) {
        return isolate(await fromCache(APP_CACHE, path, request));
    }
    if (request.mode === "navigate") {
        return isolate(await fromCache(APP_CACHE, INDEX, new Request(INDEX)));
    }
    if (RUNTIME_PREFIXES.some((p) => path.startsWith(p))) {
        return isolate(await fromCache(RUNTIME_CACHE, path, request, true));
    }
    const media = cardMode
        ? await relayedMedia(clientId, path, request.headers.get("Range"))
        : await readMediaFile(await currentProfile(), path, request.headers.get("Range"));
    if (media) {
        return isolate(new Response(media.body, { status: media.status, headers: media.headers }));
    }
    try {
        return isolate(await fetch(request));
    } catch {
        return new Response("offline", { status: 503 });
    }
}

/** Cache first, falling back to the network (and storing the result if asked). */
async function fromCache(cacheName: string, key: string, request: Request, store = false): Promise<Response> {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) {
        return hit;
    }
    const response = await fetch(request);
    if (store && response.ok) {
        await cache.put(key, response.clone());
    }
    return response;
}

/** Adds the headers that make pages and workers cross-origin isolated. */
function isolate(response: Response): Response {
    if (response.type === "opaque" || response.status === 0) {
        return response;
    }
    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", coep);
    // the card origin's pages are embedded by the app's origin
    headers.set("Cross-Origin-Resource-Policy", cardMode ? "cross-origin" : "same-origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function currentProfile(): Promise<string | null> {
    if (mediaProfile === undefined) {
        const stored = await (await caches.open(STATE_CACHE)).match(PROFILE_KEY);
        mediaProfile = stored ? await stored.text() : null;
    }
    return mediaProfile;
}

/** Asks the card frame that made the request to fetch a media file from the app. */
async function relayedMedia(clientId: string, path: string, range: string | null): Promise<MediaFile | null> {
    const client = clientId ? await sw.clients.get(clientId) : undefined;
    if (!client) {
        return null;
    }
    const channel = new MessageChannel();
    const reply = new Promise<MediaFile | null>((resolve) => {
        channel.port1.onmessage = (event) => resolve((event.data as MediaFile | null) ?? null);
        setTimeout(() => resolve(null), 30_000);
    });
    client.postMessage({ type: "media", path, range }, [channel.port2]);
    const file = await reply;
    channel.port1.close();
    return file;
}
