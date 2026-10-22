// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * The `ankiweb.http_*` imports used by web/wasi-http. The module sees each
 * request as one blocking call; the IO worker performs it, while the engine
 * worker waits for it in short steps, so that it can:
 *
 * - give way to the app's requests when media sync runs in the background:
 *   the request is cut short (an interruption to the sync), while the
 *   transfer carries on and is picked up when the sync resumes and asks for
 *   the same thing again;
 * - cancel it when the user cancels the operation (a full sync, say);
 * - fail it once nothing has moved for the sync's io timeout, as desktop's
 *   stall detection does, rather than after a fixed time;
 * - report a full sync's progress, which the module cannot while it waits.
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
    /** The body's size; it is read from the IO worker when the module asks for it. */
    size: number;
    /** The transfer the body is read from, until it has all been read. */
    key: string | null;
}

const PROXIED_HOST = /(^|\.)ankiweb\.net$/;
export const PROXY_PREFIX = "/ankiweb-proxy/";

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
    return { meta: encoder.encode(JSON.stringify({ error: { kind, message } })), size: 0, key: null };
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

/** Headers as XMLHttpRequest.getAllResponseHeaders gives them, with lowercase names. */
export function parseHeaders(raw: string): [string, string][] {
    const headers: [string, string][] = [];
    for (const line of raw.trim().split(/[\r\n]+/)) {
        const idx = line.indexOf(":");
        if (idx > 0) {
            headers.push([line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()]);
        }
    }
    return headers;
}

export function requestHeaders(req: HostRequest): [string, string][] {
    return req.headers.filter(([key]) => !FORBIDDEN.has(key.toLowerCase()));
}

/** What the engine worker tells the request path. */
export interface Host {
    io: BridgeClient;
    /** Media sync is running between the app's requests. */
    background(): boolean;
    /** A request from the app is waiting for the background work to stop. */
    wanted(): boolean;
    /** True, once, when the user has asked to cancel the running operation. */
    takeAbort(): boolean;
    /** How long a request may go without traffic before it fails (the sync's io timeout). */
    stallMs(): number;
    /** Reports how far a full sync's transfer has got. */
    fullSyncProgress(transferred: number, total: number): void;
}

/** The transfer's state while it runs (see io-worker.ts). */
interface Pending {
    pending: true;
    sent: number;
    sendTotal: number;
    received: number;
    receiveTotal: number;
}

/**
 * Stands in for a cancelled request: web/wasi-http reports it as a request
 * error with this text, which rslib's error conversion (`guess_reqwest_error`)
 * turns into an interruption, as it does when an abort cancels a request.
 */
const GAVE_WAY = "dns error: cancelled";

/** The account a sync request is for (its sync key), without the per-run session key. */
function account(req: HostRequest): string {
    const header = req.headers.find(([key]) => key.toLowerCase() === "anki-sync")?.[1];
    try {
        return String(JSON.parse(header ?? "{}").k ?? "");
    } catch {
        return "";
    }
}

/**
 * Tells request bodies apart: small ones as they are, large ones (a zip of
 * media to upload) by their size and two 32-bit hashes.
 */
export function bodyKey(bytes: Uint8Array): string {
    if (bytes.length <= 1024) {
        return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    let fnv = 0x811c9dc5;
    let djb = 5381;
    for (let i = 0; i < bytes.length; i++) {
        fnv = Math.imul(fnv ^ bytes[i], 0x01000193);
        djb = (Math.imul(djb, 33) + bytes[i]) | 0;
    }
    return `${bytes.length}:${(fnv >>> 0).toString(16)}:${(djb >>> 0).toString(16)}`;
}

function isFullSync(url: string): "upload" | "download" | null {
    try {
        const path = new URL(url).pathname;
        return path.endsWith("/sync/upload") ? "upload" : path.endsWith("/sync/download") ? "download" : null;
    } catch {
        return null;
    }
}

let nextKey = 1;

/** Performs a request through the IO worker, waiting for it in short steps. */
function send(req: HostRequest, body: Uint8Array, host: Host): HostResponse {
    const background = host.background();
    // in the background, a sync that resumes and asks again shares the transfer
    const key = background
        ? `background ${req.method} ${req.url} ${account(req)} ${bodyKey(body)}`
        : `request ${nextKey++}`;
    const copy = body.slice();
    host.io.call({
        op: "fetchStart",
        key,
        url: proxiedUrl(req.url),
        method: req.method,
        headers: requestHeaders(req),
        body: copy,
        timeoutMs: req.timeout_ms,
        stallMs: host.stallMs(),
    }, [copy.buffer]);
    const fullSync = isFullSync(req.url);
    const pause = new Int32Array(new SharedArrayBuffer(4));
    let reported = 0;
    for (;;) {
        const { payload, total } = host.io.call({ op: "fetchPoll", key });
        const state = JSON.parse(decoder.decode(payload)) as Partial<Pending>;
        if (!state.pending) {
            return { meta: payload, size: total, key: total ? key : null };
        }
        if (background ? host.wanted() : host.takeAbort()) {
            if (!background) {
                host.io.call({ op: "fetchAbort", key });
            }
            return failure("request", GAVE_WAY);
        }
        if (fullSync && performance.now() - reported > 200) {
            reported = performance.now();
            const s = state as Pending;
            if (fullSync === "upload") {
                host.fullSyncProgress(s.sent, s.sendTotal || copy.length);
            } else {
                host.fullSyncProgress(s.received, s.receiveTotal);
            }
        }
        Atomics.wait(pause, 0, 0, 50);
    }
}

/** Builds the import object; `memory` is read lazily as it can grow. */
export function httpImports(
    memory: () => WebAssembly.Memory,
    host: Host,
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
            try {
                response = send(req, body, host);
            } catch (err) {
                // an exception here would stop the engine
                response = failure("request", String(err));
            }
            responses.set(handle, response);
            return handle;
        },
        http_meta_len: (handle: number) => responses.get(handle)!.meta.length,
        http_meta(handle: number, ptr: number) {
            bytes().set(responses.get(handle)!.meta, ptr);
        },
        http_body_len: (handle: number) => responses.get(handle)!.size,
        http_body(handle: number, ptr: number) {
            // straight into the module's memory, so a large body is not copied twice
            const response = responses.get(handle)!;
            let offset = 0;
            try {
                while (response.key && offset < response.size) {
                    const chunk = host.io.call({ op: "fetchRead", key: response.key, offset }).payload;
                    if (!chunk.length) {
                        break;
                    }
                    bytes().set(chunk.subarray(0, response.size - offset), ptr + offset);
                    offset += chunk.length;
                }
            } catch (err) {
                // an exception here would stop the engine; the short body fails to decode instead
                console.error("reading a response failed", err);
            }
            response.key = null;
        },
        http_free(handle: number) {
            const response = responses.get(handle);
            if (response?.key) {
                host.io.call({ op: "fetchAbort", key: response.key });
            }
            responses.delete(handle);
        },
    };
}
