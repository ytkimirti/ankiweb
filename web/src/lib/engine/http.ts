// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * The `ankiweb.http_*` imports used by web/wasi-http. Requests run as
 * synchronous XMLHttpRequests, which block only the engine worker.
 *
 * AnkiWeb does not allow cross-origin requests, so its hosts are rewritten to
 * a same-origin proxy path (see web/vercel.json and vite.config.ts).
 */

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

export function sendSync(req: HostRequest, body: Uint8Array): HostResponse {
    const xhr = new XMLHttpRequest();
    try {
        xhr.open(req.method, proxiedUrl(req.url), false);
        xhr.responseType = "arraybuffer";
        if (req.timeout_ms) {
            xhr.timeout = req.timeout_ms;
        }
        for (const [key, value] of req.headers) {
            if (!FORBIDDEN.has(key.toLowerCase())) {
                xhr.setRequestHeader(key, value);
            }
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
    const meta = { status: xhr.status, url: unproxiedUrl(xhr.responseURL || req.url), headers };
    return {
        meta: encoder.encode(JSON.stringify(meta)),
        body: new Uint8Array((xhr.response as ArrayBuffer | null) ?? new ArrayBuffer(0)),
    };
}

/** Builds the import object; `memory` is read lazily as it can grow. */
export function httpImports(memory: () => WebAssembly.Memory): Record<string, (...args: number[]) => number | void> {
    const responses = new Map<number, HostResponse>();
    let next = 1;
    const bytes = () => new Uint8Array(memory().buffer);
    return {
        http_send(reqPtr: number, reqLen: number, bodyPtr: number, bodyLen: number): number {
            const req = JSON.parse(decoder.decode(bytes().subarray(reqPtr, reqPtr + reqLen))) as HostRequest;
            const body = bytes().slice(bodyPtr, bodyPtr + bodyLen);
            const handle = next++;
            responses.set(handle, sendSync(req, body));
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
