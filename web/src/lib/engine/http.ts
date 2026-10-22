// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * The `ankiweb.http_*` imports used by web/wasi-http. Requests run as
 * synchronous XMLHttpRequests, which block only the engine worker.
 *
 * Media sync's file downloads are the exception when it runs in the
 * background: the IO worker fetches them, so that a request from the app can
 * interrupt the sync without waiting for the download, which carries on and
 * is picked up when the sync resumes and asks for the same files.
 *
 * AnkiWeb does not allow cross-origin requests, so its hosts are rewritten to
 * a same-origin proxy path (see web/vercel.json and vite.config.ts).
 */

import type { BridgeClient } from "./bridge";

interface HostRequest {
    method: string;
    url: string;
    headers: [string, string][];
    timeout_ms: number;
}

interface HostResponse {
    meta: Uint8Array;
    body: Uint8Array;
}

const PROXIED_HOST = /(^|\.)ankiweb\.net$/;
export const PROXY_PREFIX = "/ankiweb-proxy/";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Header names XMLHttpRequest refuses to set. */
const FORBIDDEN = new Set([
    "accept-encoding",
    "connection",
    "content-length",
    "cookie",
    "host",
    "keep-alive",
    "origin",
    "referer",
    "user-agent",
]);

export function proxiedUrl(url: string): string {
    const parsed = new URL(url);
    if (PROXIED_HOST.test(parsed.hostname) && parsed.protocol === "https:") {
        return `${self.location.origin}${PROXY_PREFIX}${parsed.hostname}${parsed.pathname}${parsed.search}`;
    }
    return url;
}

/** Maps a proxied response URL back to the URL the module asked for. */
function unproxiedUrl(url: string): string {
    const prefix = `${self.location.origin}${PROXY_PREFIX}`;
    return url.startsWith(prefix) ? `https://${url.slice(prefix.length)}` : url;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function failure(kind: "timeout" | "connect" | "request", message: string): HostResponse {
    return { meta: encoder.encode(JSON.stringify({ error: { kind, message } })), body: new Uint8Array() };
}

/** The response metadata web/wasi-http reads, from a status and lowercase headers. */
export function responseMeta(status: number, url: string, headers: [string, string][]): object {
    // The proxy reports redirects this way, as the browser would follow them.
    const header = (name: string) => headers.find(([key]) => key === name)?.[1];
    const redirect = header("x-ankiweb-redirect");
    const location = header("x-ankiweb-location");
    if (redirect && location) {
        status = Number(redirect);
        headers = [...headers, ["location", location]];
    }
    return { status, url: unproxiedUrl(url), headers };
}

export function requestHeaders(req: HostRequest): [string, string][] {
    return req.headers.filter(([key]) => !FORBIDDEN.has(key.toLowerCase()));
}

export function sendSync(req: HostRequest, body: Uint8Array): HostResponse {
    const xhr = new XMLHttpRequest();
    try {
        xhr.open(req.method, proxiedUrl(req.url), false);
        xhr.responseType = "arraybuffer";
        // The engine's own stall detection cannot run while a synchronous
        // request blocks it, so never wait forever.
        xhr.timeout = req.timeout_ms || DEFAULT_TIMEOUT_MS;
        for (const [key, value] of requestHeaders(req)) {
            xhr.setRequestHeader(key, value);
        }
        xhr.send(body.length || req.method !== "GET" ? body : null);
    } catch (err) {
        const name = (err as DOMException)?.name;
        if (name === "TimeoutError") {
            return failure("timeout", "timed out");
        }
        return failure(navigator.onLine ? "request" : "connect", `${err} (network unreachable?)`);
    }
    if (xhr.status === 0) {
        return failure("connect", "network unreachable");
    }
    const headers: [string, string][] = [];
    for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
        const idx = line.indexOf(":");
        if (idx > 0) {
            headers.push([line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()]);
        }
    }
    const meta = responseMeta(xhr.status, xhr.responseURL || req.url, headers);
    return {
        meta: encoder.encode(JSON.stringify(meta)),
        body: new Uint8Array((xhr.response as ArrayBuffer | null) ?? new ArrayBuffer(0)),
    };
}

/** What the engine worker tells the background download path. */
export interface Background {
    io: BridgeClient;
    /** Media sync is running between the app's requests. */
    running(): boolean;
    /** A request from the app is waiting for it to stop. */
    wanted(): boolean;
}

/**
 * Stands in for a cancelled request: web/wasi-http reports it as a request
 * error with this text, which rslib's error conversion (`guess_reqwest_error`)
 * turns into an interruption, as it does when an abort cancels a request.
 */
const GAVE_WAY = "dns error: cancelled";

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fetches through the IO worker, giving way to the app's requests. */
function sendInBackground(req: HostRequest, body: Uint8Array, bg: Background): HostResponse {
    // the same files asked for again, by the next run, share the download
    const key = `${req.method} ${req.url} ${hex(body)}`;
    const copy = body.slice();
    bg.io.call({
        op: "fetchStart",
        key,
        url: proxiedUrl(req.url),
        method: req.method,
        headers: requestHeaders(req),
        body: copy,
        timeoutMs: req.timeout_ms || DEFAULT_TIMEOUT_MS,
    }, [copy.buffer]);
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
        const { payload, total } = bg.io.call({ op: "fetchPoll", key });
        const state = JSON.parse(decoder.decode(payload)) as { pending?: boolean };
        if (!state.pending) {
            const out = new Uint8Array(total);
            let offset = 0;
            while (offset < total) {
                const chunk = bg.io.call({ op: "fetchRead", key, offset }).payload;
                if (!chunk.length) {
                    break;
                }
                out.set(chunk, offset);
                offset += chunk.length;
            }
            return { meta: payload, body: out.subarray(0, offset) };
        }
        if (bg.wanted()) {
            return failure("request", GAVE_WAY);
        }
        Atomics.wait(pause, 0, 0, 50);
    }
}

function isMediaDownload(url: string): boolean {
    try {
        return new URL(url).pathname.endsWith("/msync/downloadFiles");
    } catch {
        return false;
    }
}

/** Builds the import object; `memory` is read lazily as it can grow. */
export function httpImports(
    memory: () => WebAssembly.Memory,
    background?: Background,
): Record<string, (...args: number[]) => number | void> {
    const responses = new Map<number, HostResponse>();
    let next = 1;
    const bytes = () => new Uint8Array(memory().buffer);
    return {
        http_send(reqPtr: number, reqLen: number, bodyPtr: number, bodyLen: number): number {
            const req = JSON.parse(decoder.decode(bytes().subarray(reqPtr, reqPtr + reqLen))) as HostRequest;
            const body = bytes().slice(bodyPtr, bodyPtr + bodyLen);
            const handle = next++;
            let response: HostResponse;
            if (background?.running() && isMediaDownload(req.url)) {
                try {
                    response = sendInBackground(req, body, background);
                } catch (err) {
                    // an exception here would stop the engine
                    response = failure("request", String(err));
                }
            } else {
                response = sendSync(req, body);
            }
            responses.set(handle, response);
            return handle;
        },
        http_meta_len: (handle: number) => responses.get(handle)!.meta.length,
        http_meta(handle: number, ptr: number) {
            bytes().set(responses.get(handle)!.meta, ptr);
        },
        http_body_len: (handle: number) => responses.get(handle)!.body.length,
        http_body(handle: number, ptr: number) {
            bytes().set(responses.get(handle)!.body, ptr);
        },
        http_free(handle: number) {
            responses.delete(handle);
        },
    };
}
