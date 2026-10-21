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
 */

import { build, files, version } from "$service-worker";

const sw = self as unknown as ServiceWorkerGlobalScope;

const APP_CACHE = `ankiweb-app-${version}`;
const RUNTIME_CACHE = "ankiweb-runtime";
const STATE_CACHE = "ankiweb-state";
const PROFILE_KEY = "/__ankiweb/media-profile";
const INDEX = "/index.html";
/** Large and only needed by cards that use MathJax, so cached on first use. */
const RUNTIME_PREFIXES = ["/_anki/js/vendor/"];

const precached = new Set([
    ...build,
    ...files.filter((f) => !RUNTIME_PREFIXES.some((p) => f.startsWith(p))),
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
                if (key.startsWith("ankiweb-app-") && key !== APP_CACHE) {
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
    event.respondWith(respond(request, url));
});

async function respond(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (precached.has(path)) {
        return isolate(await fromCache(APP_CACHE, path, request));
    }
    if (request.mode === "navigate") {
        // every page is the single-page app
        return isolate(await fromCache(APP_CACHE, INDEX, new Request(INDEX)));
    }
    if (RUNTIME_PREFIXES.some((p) => path.startsWith(p))) {
        return isolate(await fromCache(RUNTIME_CACHE, path, request, true));
    }
    const media = await mediaResponse(request, path);
    if (media) {
        return isolate(media);
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
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function currentProfile(): Promise<string | null> {
    if (mediaProfile === undefined) {
        const stored = await (await caches.open(STATE_CACHE)).match(PROFILE_KEY);
        mediaProfile = stored ? await stored.text() : null;
    }
    return mediaProfile;
}

const MIME: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
    tif: "image/tiff",
    tiff: "image/tiff",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/ogg",
    wav: "audio/wav",
    flac: "audio/flac",
    m4a: "audio/mp4",
    aac: "audio/aac",
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    ogv: "video/ogg",
    mov: "video/quicktime",
    css: "text/css",
    js: "text/javascript",
    json: "application/json",
    html: "text/html",
    htm: "text/html",
    txt: "text/plain",
    ttf: "font/ttf",
    otf: "font/otf",
    woff: "font/woff",
    woff2: "font/woff2",
    pdf: "application/pdf",
};

/** A file from the media folder; supports Range requests, which Safari needs for audio and video. */
async function mediaResponse(request: Request, path: string): Promise<Response | null> {
    const profile = await currentProfile();
    let name: string;
    try {
        name = decodeURIComponent(path.slice(1));
    } catch {
        return null;
    }
    if (!profile || !name || name.includes("/")) {
        return null;
    }
    let file: File;
    try {
        const root = await navigator.storage.getDirectory();
        const profiles = await root.getDirectoryHandle("profiles");
        const dir = await (await profiles.getDirectoryHandle(profile)).getDirectoryHandle("collection.media");
        file = await (await dir.getFileHandle(name.normalize("NFC"))).getFile();
    } catch {
        return null;
    }
    const type = MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
    const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" };
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") ?? "");
    if (range && (range[1] || range[2])) {
        const size = file.size;
        let start: number;
        let end: number;
        if (range[1]) {
            start = Number(range[1]);
            end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        } else {
            start = Math.max(0, size - Number(range[2]));
            end = size - 1;
        }
        if (start >= size || start > end) {
            return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
        }
        return new Response(file.slice(start, end + 1), {
            status: 206,
            headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
        });
    }
    return new Response(file, { headers: { ...headers, "Content-Length": String(file.size) } });
}
