// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/// <reference lib="webworker" />

/**
 * Hosts Anki's Rust backend (web/wasm) in a WASI runtime. Requests are run
 * one at a time; between them the worker runs queued background tasks (media
 * sync, backups) and replenishes the OPFS file pool.
 */

import { BackendError, BackendError_Kind } from "@generated/anki/backend_pb";
import { Progress } from "@generated/anki/collection_pb";

import { BridgeClient, BridgeDir, BridgeFile } from "./bridge";
import { Errno, WasiError } from "./errno";
import { IO_CHUNK } from "./io-protocol";
import { httpImports } from "./http";
import { Pool, PoolDir } from "./pool";
import { type EngineInit, type EngineRequest, type EngineResponse, OPFS, profilePaths, VFS } from "./protocol";
import { BlobFile, lookup, lookupParent, MemDir, mkdirp, readAll, splitPath, type VFile } from "./vfs";
import { ExitStatus, Wasi } from "./wasi";

interface Exports {
    memory: WebAssembly.Memory;
    _initialize?: () => void;
    anki_alloc(len: number): number;
    anki_free(ptr: number, len: number): void;
    anki_result_ptr(): number;
    anki_result_len(): number;
    anki_init(ptr: number, len: number): number;
    anki_command(service: number, method: number, ptr: number, len: number): number;
    anki_db_command(ptr: number, len: number): number;
    anki_run_deferred(): number;
}

let exports: Exports | null = null;
let pool: Pool | null = null;
let opfs: FileSystemDirectoryHandle | null = null;
let bridge: BridgeClient | null = null;
/**
 * [0]: abort requested; [1]: requests the client has sent; [2]: the network
 * timeout in seconds (see client.ts).
 */
let abortFlag: Int32Array | null = null;
/** Requests received, so a higher count in abortFlag[1] means one is waiting. */
let received = 0;
/** Background tasks are running, and give way to waiting requests. */
let inBackground = false;
let crashed: string | null = null;
const root = new MemDir();
const profilesDir = mkdirp(root, VFS.profiles) as MemDir;
/** Each mounted profile's media folder, whose marker is written when it closes. */
const mediaDirs = new Map<string, BridgeDir>();
mkdirp(root, VFS.imports);
/** Finished exports are kept this long for their downloads to read, then removed. */
const KEEP_EXPORTS_MS = 10 * 60_000;

function post(message: EngineResponse, transfer: Transferable[] = []): void {
    self.postMessage(message, transfer);
}

function withInput<T>(input: Uint8Array, fn: (ptr: number, len: number) => T): T {
    const ex = exports!;
    const ptr = ex.anki_alloc(input.length);
    new Uint8Array(ex.memory.buffer).set(input, ptr);
    try {
        return fn(ptr, input.length);
    } finally {
        ex.anki_free(ptr, input.length);
    }
}

function takeResult(): Uint8Array {
    const ex = exports!;
    const ptr = ex.anki_result_ptr();
    return new Uint8Array(ex.memory.buffer, ptr, ex.anki_result_len()).slice();
}

/** The origin private file system, which holds every profile. */
async function openStorage(): Promise<FileSystemDirectoryHandle> {
    if (!navigator.storage?.getDirectory) {
        throw new Error("This browser can't store Anki's data here. Update it, or try another browser.");
    }
    try {
        return await navigator.storage.getDirectory();
    } catch (err) {
        // Safari's private browsing, for one
        throw new Error(`This browser won't let Anki store its data (${String(err)}). Private browsing can cause this.`);
    }
}

/**
 * Compiles the engine as it downloads, reporting progress (in decoded bytes)
 * as the compiler takes them, so no copy of the bytes is kept in JS.
 */
async function compileEngine(url: string): Promise<WebAssembly.Module> {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
        throw new Error(`the engine could not be downloaded (${response.status})`);
    }
    let loaded = 0;
    let reported = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            loaded += chunk.length;
            if (performance.now() - reported > 100) {
                reported = performance.now();
                post({ type: "loading", loaded, done: false });
            }
            controller.enqueue(chunk);
        },
        flush() {
            post({ type: "loading", loaded, done: true });
        },
    });
    const counted = new Response(response.body.pipeThrough(counter), {
        headers: { "Content-Type": "application/wasm" },
    });
    return await WebAssembly.compileStreaming(counted);
}

async function init(config: EngineInit, ioPort: MessagePort): Promise<void> {
    abortFlag = new Int32Array(config.abortFlag);
    bridge = new BridgeClient(ioPort);
    opfs = await openStorage();
    pool = await Pool.open(await opfs.getDirectoryHandle(OPFS.pool, { create: true }));
    // what an earlier session left in the temporary folders is not wanted
    pool.removeUnder(VFS.tmp);
    const [tmp, exportsName] = lookupParent(root, splitPath(VFS.exports));
    (tmp as MemDir).mount(exportsName, new PoolDir(pool, VFS.exports));
    await removeOldExports();

    const wasi = new Wasi({
        root,
        env: { TMPDIR: VFS.tmp, HOME: VFS.profiles, RUST_BACKTRACE: "1" },
        log: (stream, line) => (stream === "stderr" ? console.warn : console.log)(`[anki] ${line}`),
    });
    const module = await compileEngine(config.wasmUrl);
    const instance = await WebAssembly.instantiate(module, {
        wasi_snapshot_preview1: wasi.imports(),
        ankiweb: {
            ...httpImports(() => wasi.memory, {
                io: bridge!,
                background: () => inBackground,
                wanted: () => Atomics.load(abortFlag!, 1) !== received,
                takeAbort: () => Atomics.exchange(abortFlag!, 0, 0) !== 0,
                stallMs: () => Atomics.load(abortFlag!, 2) * 1000,
                fullSyncProgress: (transferred, total) => {
                    const progress = new Progress({ value: { case: "fullSync", value: { transferred, total } } });
                    const bytes = progress.toBinary();
                    post({ type: "progress", progress: bytes }, [bytes.buffer]);
                },
            }),
            progress(ptr: number, len: number): number {
                const bytes = new Uint8Array(wasi.memory.buffer, ptr, len).slice();
                post({ type: "progress", progress: bytes }, [bytes.buffer]);
                const abort = Atomics.exchange(abortFlag!, 0, 0);
                if (inBackground && Atomics.load(abortFlag!, 1) !== received) {
                    // media sync resumes where it stopped, so interrupt it
                    // rather than keep the app waiting (see app/sync.ts)
                    return 1;
                }
                return abort;
            },
        },
    });
    exports = instance.exports as unknown as Exports;
    wasi.memory = exports.memory;
    exports._initialize?.();
    const code = withInput(config.backendInit, (ptr, len) => exports!.anki_init(ptr, len));
    if (code) {
        throw new Error(new TextDecoder().decode(takeResult()));
    }
}

async function mountProfile(name: string): Promise<void> {
    if (profilesDir.get(name)) {
        return;
    }
    const paths = profilePaths(name);
    // temporary files an interrupted full sync or import left behind
    pool!.removeUnder(paths.dir, (leaf) => leaf.startsWith(".tmp"));
    const dir = new PoolDir(pool!, paths.dir);
    const media = await BridgeDir.open(bridge!, [OPFS.profiles, name, "collection.media"], "collection.media.state");
    mediaDirs.set(name, media);
    dir.mount("collection.media", media);
    dir.mount("backups", await BridgeDir.open(bridge!, [OPFS.profiles, name, "backups"]));
    // media check and media sync move deleted files here
    dir.mount("media.trash", await BridgeDir.open(bridge!, [OPFS.profiles, name, "media.trash"]));
    profilesDir.mount(name, dir);
}

function fileAt(path: string): VFile {
    const node = lookup(root, splitPath(path));
    if (!node || node.kind !== "file") {
        throw new WasiError(Errno.NOENT, `${path} not found`);
    }
    return node;
}

async function removeOldExports(): Promise<void> {
    const dir = await opfs!.getDirectoryHandle(OPFS.exports, { create: true });
    for await (const [name, handle] of dir.entries()) {
        try {
            const file = await (handle as FileSystemFileHandle).getFile();
            if (Date.now() - file.lastModified > KEEP_EXPORTS_MS) {
                await dir.removeEntry(name);
            }
        } catch {
            // being read, or gone already
        }
    }
}

/**
 * Passes a file's contents to `write` in chunks. A file in OPFS (a backup) is
 * read without keeping it in memory.
 */
function readChunks(src: VFile, write: (chunk: Uint8Array, pos: number) => void): void {
    const chunk = new Uint8Array(IO_CHUNK);
    let pos = 0;
    for (;;) {
        const n = src instanceof BridgeFile ? src.readDirect(pos, chunk) : src.read(pos, chunk);
        if (!n) {
            return;
        }
        write(chunk.subarray(0, n), pos);
        pos += n;
    }
}

/**
 * Copies an export to OPFS's exports folder in chunks, then removes it;
 * returns its name there. It cannot be moved, as pool files start with a
 * header, so for a moment it takes twice its size; it is removed either way.
 */
async function moveExport(path: string, name: string): Promise<string> {
    const src = fileAt(path);
    const size = src.size();
    const [parent, leaf] = lookupParent(root, splitPath(path));
    const dir = await opfs!.getDirectoryHandle(OPFS.exports, { create: true });
    // unique, so an earlier export still downloading is left alone
    const stored = `${Date.now()}-${name}`;
    let handle: FileSystemSyncAccessHandle | null = null;
    try {
        await removeOldExports();
        const { quota, usage } = await navigator.storage.estimate().catch(() => ({ quota: undefined, usage: undefined }));
        if (quota !== undefined && usage !== undefined && quota - usage < size) {
            throw new Error(noSpaceMessage(size));
        }
        const open = await (await dir.getFileHandle(stored, { create: true })).createSyncAccessHandle();
        handle = open;
        open.truncate(0);
        readChunks(src, (chunk, pos) => {
            for (let written = 0; written < chunk.length;) {
                written += open.write(chunk.subarray(written), { at: pos + written });
            }
        });
        open.flush();
        handle = null;
        open.close();
    } catch (err) {
        handle?.close();
        await dir.removeEntry(stored).catch(() => {});
        try {
            parent.unlink(leaf);
        } catch {
            // gone already
        }
        throw (err as DOMException)?.name === "QuotaExceededError" ? new Error(noSpaceMessage(size)) : err;
    }
    parent.unlink(leaf);
    return stored;
}

function noSpaceMessage(size: number): string {
    return `Saving the export needs about ${(size / 1_000_000).toFixed(1)} MB of free storage, more than is left. `
        + "Free up space on this device, or export less (without media, say), then try again.";
}

function memDirFor(path: string): [MemDir, string] {
    const [parent, name] = lookupParent(root, splitPath(path));
    if (!(parent instanceof MemDir) || !path.startsWith(VFS.tmp)) {
        throw new WasiError(Errno.ACCES, "only temporary folders can be written directly");
    }
    return [parent, name];
}

async function handle(req: EngineRequest): Promise<EngineResponse> {
    switch (req.type) {
        case "init":
            await init(req.init, req.ioPort);
            return { type: "reply", id: req.id, ok: true };
        case "call": {
            const code = withInput(req.input, (ptr, len) => exports!.anki_command(req.service, req.method, ptr, len));
            const output = takeResult();
            if (code === 0) {
                return { type: "reply", id: req.id, ok: true, output };
            }
            const error = code === 1 ? namingUnreadable(output) : undefined;
            return { type: "reply", id: req.id, ok: false, error, message: "" };
        }
        case "db": {
            const code = withInput(req.input, (ptr, len) => exports!.anki_db_command(ptr, len));
            const output = takeResult();
            return code === 0
                ? { type: "reply", id: req.id, ok: true, output }
                : { type: "reply", id: req.id, ok: false, error: code === 1 ? output : undefined, message: "" };
        }
        case "mountProfile":
            await mountProfile(req.name);
            return { type: "reply", id: req.id, ok: true };
        case "unmountProfile":
            mediaDirs.get(req.name)?.close();
            mediaDirs.delete(req.name);
            profilesDir.unmount(req.name);
            bridge!.call({ op: "fetchCancel" });
            return { type: "reply", id: req.id, ok: true };
        case "cancelDownloads":
            bridge!.call({ op: "fetchCancel" });
            return { type: "reply", id: req.id, ok: true };
        case "deleteProfile":
        case "renameProfile": {
            if (profilesDir.get(req.name)) {
                throw new Error("profile is open");
            }
            const from = profilePaths(req.name).dir;
            if (req.type === "deleteProfile") {
                pool!.removeUnder(from);
                await bridge!.removeDir([OPFS.profiles], req.name);
            } else {
                // move the OPFS folders first: if that fails, nothing has moved yet
                await bridge!.renameDir([OPFS.profiles], req.name, req.newName);
                try {
                    pool!.renameUnder(from, profilePaths(req.newName).dir);
                } catch (err) {
                    await bridge!.renameDir([OPFS.profiles], req.newName, req.name);
                    throw err;
                }
            }
            return { type: "reply", id: req.id, ok: true };
        }
        case "storedProfiles": {
            const names = new Set(
                (await bridge!.list([OPFS.profiles])).filter((entry) => entry.dir).map((entry) => entry.name),
            );
            for (const path of pool!.paths()) {
                const match = /^\/profiles\/([^/]+)\//.exec(path);
                if (match) {
                    names.add(match[1]);
                }
            }
            return { type: "reply", id: req.id, ok: true, output: [...names] };
        }
        case "putFile": {
            const [parent, name] = memDirFor(req.path);
            parent.mount(name, new BlobFile(req.blob));
            return { type: "reply", id: req.id, ok: true };
        }
        case "readFile": {
            const node = fileAt(req.path);
            // a media or backup file is not kept in memory once read
            const output = node instanceof BridgeFile ? node.readOnce() : readAll(node);
            return { type: "reply", id: req.id, ok: true, output };
        }
        case "copyFile": {
            const src = fileAt(req.path);
            const [parent, name] = lookupParent(root, splitPath(req.to));
            const dest = (parent.get(name) as VFile | undefined) ?? parent.createFile(name);
            dest.truncate(0);
            readChunks(src, (chunk, pos) => dest.write(pos, chunk));
            dest.flush();
            dest.release?.();
            return { type: "reply", id: req.id, ok: true };
        }
        case "exportFile":
            return { type: "reply", id: req.id, ok: true, output: [await moveExport(req.path, req.name)] };
        case "removeFile": {
            const [parent, name] = lookupParent(root, splitPath(req.path));
            if (parent.get(name)) {
                parent.unlink(name);
            }
            return { type: "reply", id: req.id, ok: true };
        }
        case "listDir": {
            const node = lookup(root, splitPath(req.path));
            return { type: "reply", id: req.id, ok: true, output: node?.kind === "dir" ? node.names() : [] };
        }
    }
}

const queue: EngineRequest[] = [];
let busy = false;

async function pump(): Promise<void> {
    if (busy) {
        return;
    }
    busy = true;
    try {
        while (queue.length) {
            const req = queue.shift()!;
            if (crashed) {
                post({ type: "reply", id: req.id, ok: false, message: crashed });
                continue;
            }
            if (abortFlag) {
                // an abort requested while idle should not cancel this request
                Atomics.store(abortFlag, 0, 0);
            }
            try {
                const res = await handle(req);
                const transfer = res.type === "reply" && res.ok && res.output instanceof Uint8Array
                    ? [res.output.buffer]
                    : [];
                post(res, transfer);
            } catch (err) {
                onError(req.id, err);
            }
            if (!queue.length && exports && !crashed) {
                inBackground = true;
                try {
                    if (exports.anki_run_deferred()) {
                        post({ type: "background" });
                    }
                } catch (err) {
                    onError(null, err);
                } finally {
                    inBackground = false;
                }
            }
            if (pool) {
                await pool.topUp();
            }
        }
    } finally {
        busy = false;
    }
}

/**
 * A media file that cannot be read fails the media scan, and with it media
 * sync and Check Media, with an IO error that does not say which file; adds
 * its name and what to do about it.
 */
function namingUnreadable(error: Uint8Array): Uint8Array {
    const proto = BackendError.fromBinary(error);
    const file = proto.kind === BackendError_Kind.IO_ERROR ? bridge?.takeUnreadable() : null;
    if (!file || file.dir.at(-1) !== "collection.media") {
        return error;
    }
    // one line, for media sync's status bar
    proto.message = `${proto.message.replace(/[.\s]*$/, "")}. The media file "${file.name}" could not be read: `
        + "reload and try again, and if that does not help, remove the file or add it again.";
    return proto.toBinary();
}

function onError(id: number | null, err: unknown): void {
    // a trap (panic) leaves the module unusable; anything else is an ordinary failure
    if (err instanceof WebAssembly.RuntimeError || err instanceof ExitStatus) {
        crashed = `Anki's engine stopped: ${err.message}`;
        console.error(err);
        post({ type: "crashed", message: crashed });
    }
    if (id !== null) {
        post({ type: "reply", id, ok: false, message: crashed ?? String((err as Error)?.message ?? err) });
    }
}

self.onmessage = (event: MessageEvent<EngineRequest>) => {
    if (!(event.data.type === "call" && event.data.quiet)) {
        received++;
    }
    queue.push(event.data);
    void pump();
};
