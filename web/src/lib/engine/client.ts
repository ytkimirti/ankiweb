// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Main-thread handle on the engine worker, which runs Anki's Rust backend.
 */

import { BackendError as BackendErrorProto, BackendError_Kind, BackendInit } from "@generated/anki/backend_pb";
import { Progress } from "@generated/anki/collection_pb";
import { backendMethods } from "@generated/backend-methods";

import type { EngineRequest, EngineResponse } from "./protocol";

/** An error returned by the Rust backend. */
export class BackendError extends Error {
    readonly kind: BackendError_Kind;
    readonly proto: BackendErrorProto;

    constructor(proto: BackendErrorProto) {
        super(proto.message);
        this.name = "BackendError";
        this.kind = proto.kind;
        this.proto = proto;
    }

    get interrupted(): boolean {
        return this.kind === BackendError_Kind.INTERRUPTED;
    }
}

type Pending = { resolve: (value: any) => void; reject: (err: Error) => void; quiet: boolean };

// distributive Omit, so each request variant keeps its own fields
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RequestWithoutId = DistributiveOmit<EngineRequest, "id">;

export class Engine {
    private worker: Worker;
    private io: Worker;
    private nextId = 1;
    private pending = new Map<number, Pending>();
    private progressListeners = new Set<(progress: Progress) => void>();
    private crashListeners = new Set<(message: string) => void>();
    private backgroundListeners = new Set<() => void>();
    private onLoading: ((loaded: number) => void) | null = null;
    /** [0]: abort requested; [1]: requests sent, so the worker can tell one is waiting. */
    private abortFlag = new Int32Array(new SharedArrayBuffer(8));
    private lastActivity = 0;
    crashed: string | null = null;

    private constructor() {
        this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "anki-engine" });
        this.io = new Worker(new URL("./io-worker.ts", import.meta.url), { type: "module", name: "anki-io" });
        this.worker.onmessage = (event: MessageEvent<EngineResponse>) => this.onMessage(event.data);
        this.worker.onerror = (event) => this.onCrash(`engine worker failed: ${event.message}`);
    }

    /** `onLoading` hears how many bytes of the engine have downloaded. */
    static async start(
        wasmUrl: string,
        wasmSize: number,
        preferredLangs: string[],
        onLoading?: (loaded: number) => void,
    ): Promise<Engine> {
        if (!self.crossOriginIsolated) {
            throw new Error("Anki needs a cross-origin isolated page (COOP/COEP headers).");
        }
        const engine = new Engine();
        engine.onLoading = onLoading ?? null;
        const channel = new MessageChannel();
        engine.io.postMessage({ type: "port", port: channel.port2 }, [channel.port2]);
        const backendInit = new BackendInit({ preferredLangs, server: false }).toBinary();
        await engine.request(
            {
                type: "init",
                init: { wasmUrl, wasmSize, backendInit, abortFlag: engine.abortFlag.buffer as SharedArrayBuffer },
                ioPort: channel.port1,
            },
            [channel.port1],
        );
        return engine;
    }

    private onMessage(msg: EngineResponse): void {
        if (msg.type === "progress") {
            const progress = Progress.fromBinary(msg.progress);
            for (const listener of this.progressListeners) {
                listener(progress);
            }
            return;
        }
        if (msg.type === "loading") {
            this.onLoading?.(msg.loaded);
            return;
        }
        if (msg.type === "crashed") {
            this.onCrash(msg.message);
            return;
        }
        if (msg.type === "background") {
            for (const listener of this.backgroundListeners) {
                listener();
            }
            return;
        }
        const pending = this.pending.get(msg.id);
        if (!pending) {
            return;
        }
        this.pending.delete(msg.id);
        if (!pending.quiet) {
            this.lastActivity = performance.now();
        }
        if (msg.ok) {
            pending.resolve(msg.output);
        } else if (msg.error) {
            pending.reject(new BackendError(BackendErrorProto.fromBinary(msg.error)));
        } else {
            pending.reject(new Error(msg.message));
        }
    }

    private onCrash(message: string): void {
        this.crashed = message;
        for (const listener of this.crashListeners) {
            listener(message);
        }
        for (const pending of this.pending.values()) {
            pending.reject(new Error(message));
        }
        this.pending.clear();
    }

    private request<T>(req: RequestWithoutId, transfer: Transferable[] = []): Promise<T> {
        const quiet = req.type === "call" && !!req.quiet;
        if (this.crashed) {
            return Promise.reject(new Error(this.crashed));
        }
        const id = this.nextId++;
        if (!quiet) {
            this.lastActivity = performance.now();
        }
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, quiet });
            if (!quiet) {
                // counted before sending, so background work stops for it
                Atomics.add(this.abortFlag, 1, 1);
            }
            this.worker.postMessage({ ...req, id } as EngineRequest, transfer);
        });
    }

    /**
     * Calls a backend method by its camelCase name. A `quiet` call waits for
     * background work (media sync) to finish rather than interrupting it.
     */
    callMethod(method: string, input: Uint8Array, options: { quiet?: boolean } = {}): Promise<Uint8Array> {
        const indices = backendMethods[method];
        if (!indices) {
            return Promise.reject(new Error(`unknown backend method: ${method}`));
        }
        return this.request({ type: "call", service: indices[0], method: indices[1], input, quiet: options.quiet });
    }

    hasMethod(method: string): boolean {
        return method in backendMethods;
    }

    /** Runs a JSON DB command (see rslib/src/backend/dbproxy.rs). */
    async db(command: unknown): Promise<unknown> {
        const input = new TextEncoder().encode(JSON.stringify(command));
        const output: Uint8Array = await this.request({ type: "db", input });
        return JSON.parse(new TextDecoder().decode(output));
    }

    mountProfile(name: string): Promise<void> {
        return this.request({ type: "mountProfile", name });
    }

    unmountProfile(name: string): Promise<void> {
        return this.request({ type: "unmountProfile", name });
    }

    deleteProfileData(name: string): Promise<void> {
        return this.request({ type: "deleteProfile", name });
    }

    renameProfileData(name: string, newName: string): Promise<void> {
        return this.request({ type: "renameProfile", name, newName });
    }

    putFile(path: string, blob: Blob): Promise<void> {
        return this.request({ type: "putFile", path, blob });
    }

    readFile(path: string): Promise<Uint8Array> {
        return this.request({ type: "readFile", path });
    }

    removeFile(path: string): Promise<void> {
        return this.request({ type: "removeFile", path });
    }

    listDir(path: string): Promise<string[]> {
        return this.request({ type: "listDir", path });
    }

    /** Asks the running operation to stop at its next progress update. */
    abort(): void {
        Atomics.store(this.abortFlag, 0, 1);
    }

    onProgress(listener: (progress: Progress) => void): () => void {
        this.progressListeners.add(listener);
        return () => this.progressListeners.delete(listener);
    }

    /**
     * Resolves once no request has been waiting or answered for `ms`. Quiet
     * calls don't count: they wait on background work rather than the app.
     */
    async waitIdle(ms: number): Promise<void> {
        for (;;) {
            const quiet = performance.now() - this.lastActivity;
            if (![...this.pending.values()].some((p) => !p.quiet) && quiet >= ms) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, Math.max(ms - quiet, 100)));
        }
    }

    /** Called after background tasks (media sync, backups) ran between requests. */
    onBackground(listener: () => void): () => void {
        this.backgroundListeners.add(listener);
        return () => this.backgroundListeners.delete(listener);
    }

    onCrashed(listener: (message: string) => void): () => void {
        this.crashListeners.add(listener);
        return () => this.crashListeners.delete(listener);
    }
}
