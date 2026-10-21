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

type Pending = { resolve: (value: any) => void; reject: (err: Error) => void };

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
    private abortFlag = new Int32Array(new SharedArrayBuffer(4));
    crashed: string | null = null;

    private constructor() {
        this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "anki-engine" });
        this.io = new Worker(new URL("./io-worker.ts", import.meta.url), { type: "module", name: "anki-io" });
        this.worker.onmessage = (event: MessageEvent<EngineResponse>) => this.onMessage(event.data);
        this.worker.onerror = (event) => this.onCrash(`engine worker failed: ${event.message}`);
    }

    static async start(wasmUrl: string, preferredLangs: string[]): Promise<Engine> {
        if (!self.crossOriginIsolated) {
            throw new Error("Anki needs a cross-origin isolated page (COOP/COEP headers).");
        }
        const engine = new Engine();
        const channel = new MessageChannel();
        engine.io.postMessage({ type: "port", port: channel.port2 }, [channel.port2]);
        const backendInit = new BackendInit({ preferredLangs, server: false }).toBinary();
        await engine.request(
            {
                type: "init",
                init: { wasmUrl, backendInit, abortFlag: engine.abortFlag.buffer as SharedArrayBuffer },
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
        if (msg.type === "crashed") {
            this.onCrash(msg.message);
            return;
        }
        const pending = this.pending.get(msg.id);
        if (!pending) {
            return;
        }
        this.pending.delete(msg.id);
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
        if (this.crashed) {
            return Promise.reject(new Error(this.crashed));
        }
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ ...req, id } as EngineRequest, transfer);
        });
    }

    /** Calls a backend method by its camelCase name. */
    callMethod(method: string, input: Uint8Array): Promise<Uint8Array> {
        const indices = backendMethods[method];
        if (!indices) {
            return Promise.reject(new Error(`unknown backend method: ${method}`));
        }
        return this.request({ type: "call", service: indices[0], method: indices[1], input });
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

    onCrashed(listener: (message: string) => void): () => void {
        this.crashListeners.add(listener);
        return () => this.crashListeners.delete(listener);
    }
}
