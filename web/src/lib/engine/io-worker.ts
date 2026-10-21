// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/// <reference lib="webworker" />

/**
 * Performs OPFS operations for the engine worker. Synchronous requests answer
 * through shared memory, because the engine is blocked waiting for them.
 */

import { Errno } from "./errno";
import { Ctl, type DirEntry, IO_CHUNK, type IoRequest, type ListReply, State } from "./io-protocol";

let ctl: Int32Array | null = null;
let data: Uint8Array | null = null;
let port: MessagePort | null = null;
const dirCache = new Map<string, FileSystemDirectoryHandle>();

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

async function handleSync(req: Exclude<IoRequest, { op: "channel" } | { op: "list" }>): Promise<void> {
    switch (req.op) {
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

function onRequest(req: IoRequest): void {
    if (req.op === "channel") {
        ctl = new Int32Array(req.ctl);
        data = new Uint8Array(req.data);
        return;
    }
    if (req.op === "list") {
        list(req.dir, req.create).then(
            (entries) => port!.postMessage({ id: req.id, entries } satisfies ListReply),
            (err) => port!.postMessage({ id: req.id, error: String(err) } satisfies ListReply),
        );
        return;
    }
    handleSync(req).catch((err) => {
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
