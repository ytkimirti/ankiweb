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
import { type MediaFile, mimeType, readMediaFile } from "./lib/media-file";

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
/**
 * SHA-256 (base64) of each built file, written in by scripts/sw-integrity.mjs.
 * Card scripts run on the card origin and can write to its caches, so there
 * cached files are checked before they are served.
 */
const INTEGRITY_JSON: string = "__ANKIWEB_INTEGRITY__";
const hashes = INTEGRITY_JSON.startsWith("{") ? (JSON.parse(INTEGRITY_JSON) as Record<string, string>) : null;
/** Bytes in each built file, written in alongside the hashes, for install progress. */
const SIZES_JSON: string = "__ANKIWEB_SIZES__";
const sizes = SIZES_JSON.startsWith("{") ? (JSON.parse(SIZES_JSON) as Record<string, number>) : null;
/**
 * Every built file but the shell, written in alongside the hashes: SvelteKit's
 * lists leave out the engine's worker scripts, which a page from the previous
 * version still asks for after the server has dropped them.
 */
const FILES_JSON: string = "__ANKIWEB_FILES__";
const builtFiles = FILES_JSON.startsWith("[") ? (JSON.parse(FILES_JSON) as string[]) : [];
const WORKERS = "/_app/immutable/workers/";
/** Card frames do not run the engine. */
const CARD_SKIPPED = ["/engine/", "/icons/", WORKERS];

const precached = new Set([
    ...[...build, ...files, ...builtFiles].filter((f) =>
        !RUNTIME_PREFIXES.some((p) => f.startsWith(p)) && !(cardMode && CARD_SKIPPED.some((p) => f.startsWith(p)))
    ),
    INDEX,
]);

// Safari (and so every iOS browser) has no COEP credentialless; require-corp
// blocks cross-origin images without CORP headers there, which is the best it
// supports. As in vercel.json and vite.config.ts.
const coep = /(Chrome|Firefox)\//.test(navigator.userAgent) ? "credentialless" : "require-corp";

let mediaProfile: string | null | undefined;
/** Taking over from a version whose pages could not start (see replacingStrandedVersion). */
let reloadStranded = false;

sw.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            try {
                await precache();
            } catch (err) {
                await broadcast({ type: "install-failed", message: String(err) });
                throw err;
            }
            await carryOverRuntime().catch((err) => console.warn("keeping cached MathJax failed", err));
            reloadStranded = await replacingStrandedVersion();
            // the card origin keeps no state, and card frames match the app's version best
            if (cardMode || reloadStranded) {
                await sw.skipWaiting();
            }
        })(),
    );
});

/**
 * Versions before this one did not cache the engine's workers, so their
 * pages fail to start once the server has a newer version, and reloading
 * stays with their worker while this one waits. Takes over at once when that
 * has happened, no page of the old version having its engine running, and
 * then reloads those pages.
 */
async function replacingStrandedVersion(): Promise<boolean> {
    if (cardMode || !sw.registration.active) {
        return false;
    }
    const previous = (await caches.keys()).filter((key) => key.startsWith("ankiweb-app-") && key !== APP_CACHE);
    for (const key of previous) {
        const requests = await (await caches.open(key)).keys();
        if (requests.some((r) => new URL(r.url).pathname.startsWith(WORKERS))) {
            return false;
        }
    }
    if (!previous.length) {
        return false;
    }
    // time for a page still starting to start its engine
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const clients = await sw.clients.matchAll({ includeUncontrolled: true, type: "all" });
    return !clients.some((c) => c.type === "worker" && new URL(c.url).pathname.startsWith(`${WORKERS}worker-`));
}

/** Tells every page of this origin, controlled yet or not. */
async function broadcast(message: unknown): Promise<void> {
    for (const client of await sw.clients.matchAll({ includeUncontrolled: true, type: "window" })) {
        client.postMessage(message);
    }
}

/**
 * Caches the app for offline use, as cache.addAll would (all or nothing), but
 * reporting progress to the pages waiting on it. Each file must be the one
 * this version was built with: once a newer version is deployed, the server
 * no longer has this one's files, and may answer with something else.
 */
async function precache(): Promise<void> {
    const cache = await caches.open(APP_CACHE);
    const paths = [...precached];
    const total = sizes ? paths.reduce((sum, path) => sum + (sizes[path] ?? 0), 0) : 0;
    let loaded = 0;
    let reported = 0;
    const report = (force = false) => {
        const now = Date.now();
        if (force || now - reported > 250) {
            reported = now;
            void broadcast({ type: "install-progress", loaded, total });
        }
    };
    const aborter = new AbortController();
    let next = 0;
    const download = async () => {
        while (next < paths.length && !aborter.signal.aborted) {
            const path = paths[next++];
            const response = await fetch(path, { signal: aborter.signal });
            if (!response.ok || !response.body) {
                throw new Error(`${path}: ${response.status}`);
            }
            const expected = hashes?.[path];
            const chunks: Uint8Array[] = [];
            const counter = new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                    loaded += chunk.length;
                    report();
                    if (expected) {
                        chunks.push(chunk);
                    }
                    controller.enqueue(chunk);
                },
            });
            // the body is decoded, so its encoding and length no longer apply
            const headers = new Headers(response.headers);
            headers.delete("Content-Encoding");
            headers.delete("Content-Length");
            const body = response.body.pipeThrough(counter);
            await cache.put(path, new Response(body, { status: response.status, headers }));
            if (expected && (await sha256(await new Blob(chunks).arrayBuffer())) !== expected) {
                throw new Error(`${path}: not the file this version was built with`);
            }
        }
    };
    const downloads = Array.from({ length: 6 }, download);
    try {
        await Promise.all(downloads);
    } catch (err) {
        // stop the other downloads, and leave nothing half cached
        aborter.abort();
        await Promise.allSettled(downloads);
        await caches.delete(APP_CACHE);
        throw err;
    }
    report(true);
}

/**
 * Keeps the MathJax files earlier versions cached on first use that this
 * version has unchanged, so cards still show their maths offline after an
 * update.
 */
async function carryOverRuntime(): Promise<void> {
    if (!hashes) {
        return;
    }
    const runtime = await caches.open(RUNTIME_CACHE);
    for (const key of await caches.keys()) {
        if (!key.startsWith("ankiweb-runtime-") || key === RUNTIME_CACHE) {
            continue;
        }
        const previous = await caches.open(key);
        for (const request of await previous.keys()) {
            const path = new URL(request.url).pathname;
            const response = hashes[path] && !(await runtime.match(path)) ? await previous.match(request) : undefined;
            if (!response?.ok) {
                continue;
            }
            const body = await response.arrayBuffer();
            if ((await sha256(body)) === hashes[path]) {
                const headers = new Headers(response.headers);
                headers.delete("Content-Encoding");
                headers.delete("Content-Length");
                await runtime.put(path, new Response(body, { headers }));
            }
        }
    }
}

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
            if (reloadStranded) {
                // not awaited: the reload's requests wait for this worker to finish activating
                for (const client of await sw.clients.matchAll({ type: "window" })) {
                    void client.navigate(client.url).catch(() => {});
                }
            }
        })(),
    );
});

sw.addEventListener("message", (event) => {
    const data = event.data as { type?: string; name?: string | null } | undefined;
    if (data?.type === "mediaProfile") {
        mediaProfile = data.name ?? null;
    } else if (data?.type === "skipWaiting") {
        void sw.skipWaiting();
    } else if (data?.type === "claim") {
        event.waitUntil(sw.clients.claim());
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
    // media names have no "/"; anything deeper (an old build's chunk after an
    // update, say) is not media, and asking a frame that is still loading
    // would stall it until the relay times out
    const media = cardMode
        ? path.indexOf("/", 1) === -1 ? await relayedMedia(clientId, path, request.headers.get("Range")) : null
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
    if (hit && (await trusted(key, hit))) {
        // card scripts could also have stored misleading headers with a genuine body
        return cardMode ? new Response(hit.body, { headers: { "Content-Type": mimeType(key === INDEX ? "index.html" : key) } }) : hit;
    }
    const response = await fetch(request);
    // hit is set when a modified entry was dropped
    if ((store || hit) && response.ok && (await built(key, response))) {
        await cache.put(key, response.clone());
    }
    return response;
}

/** Whether a response is the file this version built, as far as is known. */
async function built(key: string, response: Response): Promise<boolean> {
    const expected = hashes?.[key];
    return !expected || (await sha256(await response.clone().arrayBuffer())) === expected;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return btoa(String.fromCharCode(...digest));
}

/** On the card origin, whether a cached file is the one that was built. */
async function trusted(key: string, response: Response): Promise<boolean> {
    if (!cardMode) {
        return true;
    }
    const expected = hashes?.[key];
    if (!expected) {
        // without hashes (a dev build) nothing can be checked, so nothing is trusted
        return false;
    }
    if ((await sha256(await response.clone().arrayBuffer())) === expected) {
        return true;
    }
    console.warn("dropping modified cache entry", key);
    await (await caches.open(APP_CACHE)).delete(key);
    await (await caches.open(RUNTIME_CACHE)).delete(key);
    return false;
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
