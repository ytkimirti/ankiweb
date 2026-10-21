// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Starts the engine and routes ts/'s backend calls to it. Methods the Rust
 * backend does not implement (FrontendService, served by Python on desktop)
 * go to handlers registered with registerFrontendMethod.
 */

import { setProtoTransport } from "@generated/post";

import { Engine } from "../engine/client";

let engine: Engine | null = null;
let starting: Promise<Engine> | null = null;

type FrontendHandler = (input: Uint8Array) => Promise<Uint8Array> | Uint8Array;
const frontendMethods = new Map<string, FrontendHandler>();

/** Implements a FrontendService method (see proto/anki/frontend.proto). */
export function registerFrontendMethod(method: string, handler: FrontendHandler): void {
    frontendMethods.set(method, handler);
}

export function getEngine(): Engine {
    if (!engine) {
        throw new Error("engine not started");
    }
    return engine;
}

export function startEngine(preferredLangs: string[] = navigator.languages.slice()): Promise<Engine> {
    starting ??= Engine.start("/engine/anki.wasm", preferredLangs).then((started) => {
        engine = started;
        setProtoTransport(async (method, input) => {
            if (started.hasMethod(method)) {
                return started.callMethod(method, input);
            }
            const handler = frontendMethods.get(method);
            if (handler) {
                return handler(input);
            }
            throw new Error(`${method} is not available in the web version`);
        });
        return started;
    });
    return starting;
}
