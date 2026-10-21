// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Starts the engine and routes ts/'s backend calls to it. Methods the Rust
 * backend does not implement (FrontendService, served by Python on desktop)
 * go to handlers registered with registerFrontendMethod. Webview pages in
 * iframes reach the same router through host.ts.
 */

import { Progress } from "@generated/anki/collection_pb";
import { setProtoTransport } from "@generated/post";

import { BackendError, Engine } from "../engine/client";
import { emitOpChanges, opChangesFromOutput } from "./ops";

let engine: Engine | null = null;
let starting: Promise<Engine> | null = null;

/** Who made a backend call: null for the app itself, or a webview frame. */
export interface CallContext {
    source: Window | null;
    /** The screen that made the call, if it said (PostProtoOptions.initiator). */
    initiator?: unknown;
}

type FrontendHandler = (input: Uint8Array, ctx: CallContext) => Promise<Uint8Array> | Uint8Array;
const frontendMethods = new Map<string, FrontendHandler>();

/**
 * Implements a FrontendService method (see proto/anki/frontend.proto), or
 * overrides a backend method the way desktop's mediasrv.py wraps some.
 */
export function registerFrontendMethod(method: string, handler: FrontendHandler): void {
    frontendMethods.set(method, handler);
}

export function getEngine(): Engine {
    if (!engine) {
        throw new Error("engine not started");
    }
    return engine;
}

let latestProgress: Uint8Array = new Progress().toBinary();
let running = 0;

/**
 * Calls a backend or frontend method. The engine runs one request at a time,
 * so progress queries and abort requests are answered here instead of
 * queueing behind the operation they are about.
 */
export async function callBackend(
    method: string,
    input: Uint8Array,
    opChangesType: number,
    ctx: CallContext = { source: null },
): Promise<Uint8Array> {
    const handler = frontendMethods.get(method);
    if (handler) {
        return handler(input, ctx);
    }
    return callEngine(method, input, opChangesType, ctx);
}

/** Calls the Rust backend directly, bypassing frontend overrides. */
export async function callEngine(
    method: string,
    input: Uint8Array,
    opChangesType: number,
    ctx: CallContext = { source: null },
): Promise<Uint8Array> {
    const started = getEngine();
    if (method === "latestProgress") {
        return running ? latestProgress : new Progress().toBinary();
    }
    if (method === "setWantsAbort") {
        started.abort();
        return new Uint8Array();
    }
    if (!started.hasMethod(method)) {
        throw new Error(`${method} is not available in the web version`);
    }
    running++;
    let output: Uint8Array;
    try {
        output = await started.callMethod(method, input);
    } catch (err) {
        if (err instanceof BackendError && err.interrupted) {
            // what ts/lib/generated/post.ts expects for a cancelled operation
            throw new Error("500: Interrupted");
        }
        throw err;
    } finally {
        if (--running === 0) {
            latestProgress = new Progress().toBinary();
        }
    }
    if (opChangesType) {
        const changes = opChangesFromOutput(output, opChangesType);
        if (changes) {
            emitOpChanges(changes, ctx.source ?? ctx.initiator ?? null);
        }
    }
    return output;
}

export function startEngine(preferredLangs: string[] = navigator.languages.slice()): Promise<Engine> {
    starting ??= Engine.start("/engine/anki.wasm", preferredLangs).then((started) => {
        engine = started;
        started.onProgress((progress) => {
            latestProgress = progress.toBinary();
        });
        setProtoTransport((method, input, opChangesType, _signal, initiator) =>
            callBackend(method, input, opChangesType, { source: null, initiator })
        );
        return started;
    });
    return starting;
}
