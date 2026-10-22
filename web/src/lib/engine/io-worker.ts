// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/// <reference lib="webworker" />

/**
 * Performs OPFS operations for the engine worker. Synchronous requests answer
 * through shared memory, because the engine is blocked waiting for them.
 */

import { Errno } from "./errno";
import { parseHeaders, responseMeta } from "./http";
import { Ctl, type DirEntry, IO_CHUNK, type IoRequest, type ListReply, State } from "./io-protocol";

let ctl: Int32Array | null = null;
let data: Uint8Array | null = null;
let port: MessagePort | null = null;
const dirCache = new Map<string, FileSystemDirectoryHandle>();

/**
 * The engine's requests. Media sync's keep going when it gives way to the
 * app, and a sync that resumes takes them over by asking with the same key.
 */
interface Transfer {
    url: string;
    /** The response metadata (http.ts), once it has finished. */
    meta: object | null;
    body: Uint8Array;
    ok: boolean;
    /** When it last sent or received something. */
    activeAt: number;
    finishedAt: number;
    sent: number;
    sendTotal: number;
    received: number;
    receiveTotal: number;
    abort: () => void;
}
const transfers = new Map<string, Transfer>();
/** How long a finished transfer waits to be picked up; after that it is made again. */
const KEEP_MS = 5 * 60_000;

function isMediaDownload(url: string): boolean {
    return url.endsWith("/msync/downloadFiles");
}

function startFetch(req: Extract<IoRequest, { op: "fetchStart" }>): void {
    const existing = transfers.get(req.key);
    // one still running or that arrived fine is taken over; a failure is
    // tried again, as a new request would be
    if (existing && (!existing.meta || (existing.ok && performance.now() - existing.finishedAt < KEEP_MS))) {
        return;
    }
    existing?.abort();
    // a sync that asks for other files no longer wants the ones it asked for before
    if (isMediaDownload(req.url)) {
        for (const [key, other] of transfers) {
            if (other.url === req.url && !other.meta) {
                other.abort();
                transfers.delete(key);
            }
        }
    }
    const xhr = new XMLHttpRequest();
    const entry: Transfer = {
        url: req.url,
        meta: null,
        body: new Uint8Array(),
        ok: false,
        activeAt: performance.now(),
        finishedAt: 0,
        sent: 0,
        sendTotal: req.body.length,
        received: 0,
        receiveTotal: 0,
        abort: () => xhr.abort(),
    };
    transfers.set(req.key, entry);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let timedOut = false;
    const finish = (meta: object, body = new Uint8Array(), ok = false) => {
        if (entry.meta) {
            return;
        }
        if (timer) {
            clearTimeout(timer);
        }
        if (watchdog) {
            clearInterval(watchdog);
        }
        Object.assign(entry, { meta, body, ok, finishedAt: performance.now() });
        // not picked up by then, it is not wanted
        setTimeout(() => {
            if (transfers.get(req.key) === entry) {
                transfers.delete(req.key);
            }
        }, KEEP_MS);
    };
    const timeOut = () => {
        timedOut = true;
        xhr.abort();
    };
    const active = () => (entry.activeAt = performance.now());
    try {
        xhr.open(req.method, req.url);
        xhr.responseType = "arraybuffer";
        for (const [key, value] of req.headers) {
            xhr.setRequestHeader(key, value);
        }
    } catch (err) {
        transfers.delete(req.key);
        throw err;
    }
    xhr.upload.onprogress = (event) => {
        active();
        entry.sent = event.loaded;
    };
    xhr.onprogress = (event) => {
        active();
        entry.received = event.loaded;
        entry.receiveTotal = event.lengthComputable ? event.total : 0;
    };
    xhr.onreadystatechange = active;
    xhr.onload = () => {
        const meta = responseMeta(xhr.status, xhr.responseURL || req.url, parseHeaders(xhr.getAllResponseHeaders()));
        const body = new Uint8Array((xhr.response as ArrayBuffer | null) ?? new ArrayBuffer(0));
        finish(meta, body, xhr.status >= 200 && xhr.status < 300);
    };
    xhr.onerror = () => {
        const kind = navigator.onLine ? "request" : "connect";
        finish({ error: { kind, message: "the request failed (network unreachable?)" } });
    };
    xhr.onabort = () => {
        finish({ error: timedOut ? { kind: "timeout", message: "timed out" } : { kind: "request", message: "cancelled" } });
    };
    if (req.timeoutMs) {
        timer = setTimeout(timeOut, req.timeoutMs);
    }
    if (req.stallMs) {
        watchdog = setInterval(() => {
            if (performance.now() - entry.activeAt > req.stallMs) {
                timeOut();
            }
        }, 1000);
    }
    xhr.send(req.body.length || req.method !== "GET" ? req.body : null);
}

/** The file being read in chunks, kept open between round trips. */
let reading: { key: string; handle: FileSystemSyncAccessHandle; size: number } | null = null;

async function dirHandle(path: string[], create = false): Promise<FileSystemDirectoryHandle> {
    const key = path.join("/");
    const cached = dirCache.get(key);
    if (cached) {
        return cached;
    }
    let dir = await navigator.storage.getDirectory();
    for (const part of path) {
        dir = await dir.getDirectoryHandle(part, { create });
    }
    dirCache.set(key, dir);
    return dir;
}

function closeReading(): void {
    if (reading) {
        reading.handle.close();
        reading = null;
    }
}

const encoder = new TextEncoder();

function reply(status: number, payload?: Uint8Array | object, total = 0): void {
    let len = 0;
    if (payload instanceof Uint8Array) {
        data!.set(payload);
        len = payload.length;
    } else if (payload) {
        const json = encoder.encode(JSON.stringify(payload));
        data!.set(json);
        len = json.length;
    }
    Atomics.store(ctl!, Ctl.Status, status);
    Atomics.store(ctl!, Ctl.Length, len);
    Atomics.store(ctl!, Ctl.Total, total);
    Atomics.store(ctl!, Ctl.State, State.Done);
    Atomics.notify(ctl!, Ctl.State);
}

/** A file that could not be read, named so the app can say which (see BridgeClient.call). */
class UnreadableFile extends Error {
    constructor(readonly file: string, readonly reason: unknown) {
        super(`${file}: ${String(reason)}`);
    }
}

function errnoFor(err: unknown): number {
    const name = ((err instanceof UnreadableFile ? err.reason : err) as DOMException)?.name;
    if (name === "NotFoundError") {
        return Errno.NOENT;
    }
    if (name === "TypeMismatchError") {
        return Errno.ISDIR;
    }
    if (name === "QuotaExceededError") {
        return Errno.NOSPC;
    }
    return Errno.IO;
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<number> {
    const fh = await dir.getFileHandle(name, { create: true });
    const handle = await fh.createSyncAccessHandle();
    try {
        handle.truncate(0);
        let pos = 0;
        while (pos < bytes.length) {
            pos += handle.write(bytes.subarray(pos), { at: pos });
        }
        handle.flush();
    } finally {
        handle.close();
    }
    return (await fh.getFile()).lastModified;
}

type SyncRequest = Extract<
    IoRequest,
    {
        op:
            | "read"
            | "write"
            | "delete"
            | "rename"
            | "mkdir"
            | "statFile"
            | "statDir"
            | "fetchStart"
            | "fetchPoll"
            | "fetchRead"
            | "fetchAbort"
            | "fetchCancel";
    }
>;

async function handleSync(req: SyncRequest): Promise<void> {
    switch (req.op) {
        case "fetchStart":
            startFetch(req);
            reply(0);
            return;
        case "fetchCancel":
            for (const entry of transfers.values()) {
                entry.abort();
            }
            transfers.clear();
            reply(0);
            return;
        case "fetchAbort":
            transfers.get(req.key)?.abort();
            transfers.delete(req.key);
            reply(0);
            return;
        case "fetchPoll": {
            const entry = transfers.get(req.key);
            if (!entry) {
                reply(Errno.NOENT, { message: "request not started" });
            } else if (!entry.meta) {
                const { sent, sendTotal, received, receiveTotal } = entry;
                reply(0, { pending: true, sent, sendTotal, received, receiveTotal });
            } else {
                if (!entry.body.length) {
                    // nothing to read (a failure, say), so a retry starts afresh
                    transfers.delete(req.key);
                }
                reply(0, entry.meta, entry.body.length);
            }
            return;
        }
        case "fetchRead": {
            const entry = transfers.get(req.key);
            if (!entry?.meta) {
                reply(Errno.NOENT, { message: "download not finished" });
                return;
            }
            const chunk = entry.body.subarray(req.offset, req.offset + IO_CHUNK);
            if (req.offset + chunk.length >= entry.body.length) {
                transfers.delete(req.key);
            }
            reply(0, chunk, entry.body.length);
            return;
        }
        case "read": {
            const key = [...req.dir, req.name].join("/");
            if (!reading || reading.key !== key || req.offset === 0) {
                closeReading();
                const dir = await dirHandle(req.dir);
                const fh = await dir.getFileHandle(req.name);
                const handle = await fh.createSyncAccessHandle();
                reading = { key, handle, size: handle.getSize() };
            }
            const n = Math.max(0, Math.min(IO_CHUNK, reading.size - req.offset));
            const buf = new Uint8Array(n);
            let got = 0;
            while (got < n) {
                const read = reading.handle.read(buf.subarray(got), { at: req.offset + got });
                if (!read) {
                    break;
                }
                got += read;
            }
            const size = reading.size;
            if (req.offset + got >= size) {
                closeReading();
            }
            reply(0, buf.subarray(0, got), size);
            return;
        }
        case "write": {
            closeReading();
            const dir = await dirHandle(req.dir, true);
            const mtimeMs = await writeFile(dir, req.name, req.bytes);
            reply(0, { mtimeMs });
            return;
        }
        case "delete": {
            closeReading();
            const dir = await dirHandle(req.dir);
            await dir.removeEntry(req.name);
            reply(0);
            return;
        }
        case "rename": {
            closeReading();
            if (req.dir.join("/") === req.toDir.join("/") && req.name === req.toName) {
                // moving a file onto itself would delete it below
                const file = await (await (await dirHandle(req.dir)).getFileHandle(req.name)).getFile();
                reply(0, { size: file.size, mtimeMs: file.lastModified });
                return;
            }
            const src = await dirHandle(req.dir);
            const dest = await dirHandle(req.toDir, true);
            const fh = await src.getFileHandle(req.name);
            const move = (fh as unknown as { move?: (d: FileSystemDirectoryHandle, n: string) => Promise<void> })
                .move;
            if (move) {
                try {
                    await dest.removeEntry(req.toName);
                } catch {
                    // target absent
                }
                await move.call(fh, dest, req.toName);
            } else {
                const bytes = new Uint8Array(await (await fh.getFile()).arrayBuffer());
                await writeFile(dest, req.toName, bytes);
                await src.removeEntry(req.name);
            }
            const moved = await (await dest.getFileHandle(req.toName)).getFile();
            reply(0, { size: moved.size, mtimeMs: moved.lastModified });
            return;
        }
        case "mkdir": {
            await dirHandle(req.dir, true);
            reply(0);
            return;
        }
        case "statFile": {
            const file = await (await (await dirHandle(req.dir)).getFileHandle(req.name)).getFile();
            reply(0, { size: file.size, mtimeMs: file.lastModified });
            return;
        }
        case "statDir": {
            const key = req.dir.join("/");
            if (req.offset === 0 || statting?.key !== key) {
                statting = { key, bytes: await statDir(req.dir) };
            }
            const bytes = statting.bytes;
            const chunk = bytes.subarray(req.offset, req.offset + IO_CHUNK);
            if (req.offset + chunk.length >= bytes.length) {
                statting = null;
            }
            reply(0, chunk, bytes.length);
            return;
        }
    }
}

async function list(dir: string[], create: boolean, stat: boolean): Promise<DirEntry[]> {
    const handle = await dirHandle(dir, create);
    const entries: DirEntry[] = [];
    for await (const [name, child] of handle.entries()) {
        if (child.kind === "directory") {
            entries.push({ name, size: 0, mtimeMs: 0, dir: true });
        } else if (!stat) {
            entries.push({ name, size: NaN, mtimeMs: NaN, dir: false });
        } else {
            const file = await (child as FileSystemFileHandle).getFile();
            entries.push({ name, size: file.size, mtimeMs: file.lastModified, dir: false });
        }
    }
    return entries;
}

async function readJson(dir: string[], name: string): Promise<unknown> {
    try {
        const file = await (await (await dirHandle(dir)).getFileHandle(name)).getFile();
        return JSON.parse(await file.text());
    } catch {
        return null;
    }
}

/** A directory's file stats being read in chunks, encoded. */
let statting: { key: string; bytes: Uint8Array } | null = null;

async function statDir(dir: string[]): Promise<Uint8Array> {
    const handles: FileSystemFileHandle[] = [];
    for await (const [, child] of (await dirHandle(dir)).entries()) {
        if (child.kind === "file") {
            handles.push(child as FileSystemFileHandle);
        }
    }
    const stats: [string, number, number][] = [];
    // many at a time, which is several times faster than one by one
    for (let i = 0; i < handles.length; i += 64) {
        const files = await Promise.all(
            handles.slice(i, i + 64).map((h) =>
                h.getFile().catch((err) => {
                    // gone since it was listed; other failures fail the listing, as a
                    // file left out would count as deleted
                    if ((err as DOMException)?.name === "NotFoundError") {
                        return null;
                    }
                    throw new UnreadableFile(h.name, err);
                })
            ),
        );
        for (const file of files) {
            if (file) {
                stats.push([file.name, file.size, file.lastModified]);
            }
        }
    }
    return encoder.encode(JSON.stringify(stats));
}

async function copyDir(src: FileSystemDirectoryHandle, dest: FileSystemDirectoryHandle): Promise<void> {
    for await (const [name, child] of src.entries()) {
        if (child.kind === "directory") {
            await copyDir(
                child as FileSystemDirectoryHandle,
                await dest.getDirectoryHandle(name, { create: true }),
            );
        } else {
            const bytes = new Uint8Array(await (await (child as FileSystemFileHandle).getFile()).arrayBuffer());
            await writeFile(dest, name, bytes);
        }
    }
}

async function renameDir(dir: string[], name: string, toName: string): Promise<void> {
    const parent = await dirHandle(dir, true);
    let src: FileSystemDirectoryHandle;
    try {
        src = await parent.getDirectoryHandle(name);
    } catch {
        return;
    }
    const move = (src as unknown as { move?: (n: string) => Promise<void> }).move;
    dirCache.clear();
    if (move) {
        try {
            await move.call(src, toName);
            return;
        } catch {
            // fall back to copying
        }
    }
    await copyDir(src, await parent.getDirectoryHandle(toName, { create: true }));
    await parent.removeEntry(name, { recursive: true });
}

async function removeDir(dir: string[], name: string): Promise<void> {
    dirCache.clear();
    try {
        await (await dirHandle(dir, true)).removeEntry(name, { recursive: true });
    } catch (err) {
        if ((err as DOMException)?.name !== "NotFoundError") {
            throw err;
        }
    }
}

function answer(id: number, work: Promise<DirEntry[] | void>): void {
    work.then(
        (entries) => port!.postMessage({ id, entries: entries ?? [] } satisfies ListReply),
        (err) => port!.postMessage({ id, error: String(err) } satisfies ListReply),
    );
}

function onRequest(req: IoRequest): void {
    switch (req.op) {
        case "channel":
            ctl = new Int32Array(req.ctl);
            data = new Uint8Array(req.data);
            return;
        case "list":
            answer(req.id, list(req.dir, req.create, req.stat));
            return;
        case "readJson":
            readJson(req.dir, req.name).then((value) => port!.postMessage({ id: req.id, value } satisfies ListReply));
            return;
        case "removeDir":
            answer(req.id, removeDir(req.dir, req.name));
            return;
        case "renameDir":
            answer(req.id, renameDir(req.dir, req.name, req.toName));
            return;
    }
    handleSync(req as SyncRequest).catch((err) => {
        closeReading();
        const errno = errnoFor(err);
        // a file there but unreadable is named, as it stops the media scan
        const named = errno === Errno.IO && (req.op === "read" || req.op === "statFile") ? req.name : undefined;
        reply(errno, { message: String(err), file: err instanceof UnreadableFile ? err.file : named });
    });
}

self.onmessage = (event: MessageEvent) => {
    if (event.data?.type === "port") {
        port = event.data.port as MessagePort;
        port.onmessage = (e) => onRequest(e.data as IoRequest);
    }
};
