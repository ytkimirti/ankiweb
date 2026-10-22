// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/// <reference lib="webworker" />

/**
 * Hosts Anki's Rust backend (web/wasm) in a WASI runtime. Requests are run
 * one at a time; between them the worker runs queued background tasks (media
 * sync, backups) and replenishes the OPFS file pool.
 */

import { Progress } from "@generated/anki/collection_pb";

import { BridgeClient, BridgeDir, BridgeFile } from "./bridge";
import { Errno, WasiError } from "./errno";
import { IO_CHUNK } from "./io-protocol";
import { httpImports } from "./http";
import { Pool, PoolDir } from "./pool";
import { type EngineInit, type EngineRequest, type EngineResponse, OPFS, profilePaths, VFS } from "./protocol";
import { BlobFile, lookup, lookupParent, MemDir, mkdirp, readAll, splitPath } from "./vfs";
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
mkdirp(root, VFS.imports);
mkdirp(root, VFS.exports);

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
    const opfs = await openStorage();
    pool = await Pool.open(await opfs.getDirectoryHandle(OPFS.pool, { create: true }));

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
    const dir = new PoolDir(pool!, paths.dir);
    dir.mount("collection.media", await BridgeDir.open(bridge!, [OPFS.profiles, name, "collection.media"]));
    dir.mount("backups", await BridgeDir.open(bridge!, [OPFS.profiles, name, "backups"]));
    // media check and media sync move deleted files here
    dir.mount("media.trash", await BridgeDir.open(bridge!, [OPFS.profiles, name, "media.trash"]));
    profilesDir.mount(name, dir);
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
            return { type: "reply", id: req.id, ok: false, error: code === 1 ? output : undefined, message: "" };
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
        case "putFile": {
            const [parent, name] = memDirFor(req.path);
            parent.mount(name, new BlobFile(req.blob));
            return { type: "reply", id: req.id, ok: true };
        }
        case "readFile": {
            const node = lookup(root, splitPath(req.path));
            if (!node || node.kind !== "file") {
                throw new WasiError(Errno.NOENT, `${req.path} not found`);
            }
            return { type: "reply", id: req.id, ok: true, output: readAll(node).slice() };
        }
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
