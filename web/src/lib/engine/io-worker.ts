// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/// <reference lib="webworker" />

/**
 * Performs OPFS operations for the engine worker. Synchronous requests answer
 * through shared memory, because the engine is blocked waiting for them.
 */

import { Errno } from "./errno";
import { responseMeta } from "./http";
import { Ctl, type DirEntry, IO_CHUNK, type IoRequest, type ListReply, State } from "./io-protocol";

let ctl: Int32Array | null = null;
let data: Uint8Array | null = null;
let port: MessagePort | null = null;
const dirCache = new Map<string, FileSystemDirectoryHandle>();

/**
 * Media sync's downloads, which keep going when it gives way to the app; only
 * the latest is kept, as a sync that resumes asks for it again.
 */
interface Download {
    /** The response metadata (http.ts), once it has finished. */
    meta: object | null;
    body: Uint8Array;
    ok: boolean;
    /** When it last received something. */
    activeAt: number;
    finishedAt: number;
    controller: AbortController;
}
const fetches = new Map<string, Download>();
/** How long a finished download waits to be picked up; after that it is fetched again. */
const KEEP_MS = 5 * 60_000;
/** A download that has received nothing for this long has stalled, and is started again. */
const STALL_MS = 60_000;

function startFetch(req: Extract<IoRequest, { op: "fetchStart" }>): void {
    const existing = fetches.get(req.key);
    const now = performance.now();
    // a sync that resumes takes over what is still downloading or arrived
    // fine; a failure is tried again, as a new request would be
    if (
        existing && (existing.meta
            ? existing.ok && now - existing.finishedAt < KEEP_MS
            : now - existing.activeAt < STALL_MS)
    ) {
        return;
    }
    for (const other of fetches.values()) {
        other.controller.abort();
    }
    fetches.clear();
    const controller = new AbortController();
    const entry: Download = { meta: null, body: new Uint8Array(), ok: false, activeAt: now, finishedAt: 0, controller };
    fetches.set(req.key, entry);
    const finish = (meta: object, body = new Uint8Array(), ok = false) => {
        Object.assign(entry, { meta, body, ok, finishedAt: performance.now() });
    };
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body.length || req.method !== "GET" ? req.body : undefined,
        signal: controller.signal,
    }).then(async (res) => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = res.body?.getReader();
        for (;;) {
            entry.activeAt = performance.now();
            const chunk = await reader?.read();
            if (!chunk || chunk.done) {
                break;
            }
            chunks.push(chunk.value);
            size += chunk.value.length;
        }
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.length;
        }
        finish(responseMeta(res.status, res.url || req.url, [...res.headers]), body, res.ok);
    }).catch((err) => {
        if (controller.signal.aborted) {
            finish({ error: { kind: "timeout", message: "timed out" } });
        } else {
            const kind = navigator.onLine ? "request" : "connect";
            finish({ error: { kind, message: `${err} (network unreachable?)` } });
        }
    }).finally(() => clearTimeout(timer));
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

function errnoFor(err: unknown): number {
    const name = (err as DOMException)?.name;
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
    { op: "read" | "write" | "delete" | "rename" | "mkdir" | "fetchStart" | "fetchPoll" | "fetchRead" }
>;

async function handleSync(req: SyncRequest): Promise<void> {
    switch (req.op) {
        case "fetchStart":
            startFetch(req);
            reply(0);
            return;
        case "fetchPoll": {
            const entry = fetches.get(req.key);
            if (!entry) {
                reply(Errno.NOENT, { message: "download not started" });
            } else {
                if (entry.meta && !entry.body.length) {
                    // nothing to read (a failure, say), so a retry starts afresh
                    fetches.delete(req.key);
                }
                reply(0, entry.meta ?? { pending: true }, entry.body.length);
            }
            return;
        }
        case "fetchRead": {
            const entry = fetches.get(req.key);
            if (!entry?.meta) {
                reply(Errno.NOENT, { message: "download not finished" });
                return;
            }
            const chunk = entry.body.subarray(req.offset, req.offset + IO_CHUNK);
            if (req.offset + chunk.length >= entry.body.length) {
                fetches.delete(req.key);
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
                reply(0, { mtimeMs: file.lastModified });
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
            const moved = await dest.getFileHandle(req.toName);
            reply(0, { mtimeMs: (await moved.getFile()).lastModified });
            return;
        }
        case "mkdir": {
            await dirHandle(req.dir, true);
            reply(0);
            return;
        }
    }
}

async function list(dir: string[], create: boolean): Promise<DirEntry[]> {
    const handle = await dirHandle(dir, create);
    const entries: DirEntry[] = [];
    for await (const [name, child] of handle.entries()) {
        if (child.kind === "directory") {
            entries.push({ name, size: 0, mtimeMs: 0, dir: true });
        } else {
            const file = await (child as FileSystemFileHandle).getFile();
            entries.push({ name, size: file.size, mtimeMs: file.lastModified, dir: false });
        }
    }
    return entries;
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
            answer(req.id, list(req.dir, req.create));
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
        reply(errnoFor(err), { message: String(err) });
    });
}

self.onmessage = (event: MessageEvent) => {
    if (event.data?.type === "port") {
        port = event.data.port as MessagePort;
        port.onmessage = (e) => onRequest(e.data as IoRequest);
    }
};
