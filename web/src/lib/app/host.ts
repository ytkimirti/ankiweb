// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * The app's side of the webview bridge. Desktop pages from ts/ run in
 * same-origin iframes (like desktop's webviews); they reach the engine and
 * their owner (pycmd/bridgeCommand on desktop) through window.__ankiHost.
 * See webview.ts for the frame side. Card frames, which run card scripts, use
 * the narrower message bridge in cardframe.ts instead.
 */

import { get } from "svelte/store";

import { callBackend } from "./backend";
import { applyThemeClasses } from "./card-messages";
import { setupEditorPlugins } from "./editor-plugins";
import { onOpChanges } from "./ops";
import { reduceMotion } from "./settings";
import { nightMode } from "./theme";
import type { WindowHandle } from "./windows";

export interface FrameOwner {
    /** The window showing this frame, if any. */
    window?: WindowHandle;
    onBridge?: (cmd: string, frame: Window) => unknown;
    /** The user pressed Escape in the frame and nothing handled it. */
    onEscape?: () => void;
    /** A key pressed outside a text field in the frame; return true if handled. */
    onKey?: (event: KeyboardEvent) => boolean;
}

export interface HostApi {
    call(method: string, input: Uint8Array, opChangesType: number, source: Window): Promise<Uint8Array>;
    bridge(source: Window, cmd: string): Promise<unknown>;
    escape(source: Window): void;
    key(source: Window, event: KeyboardEvent): boolean;
    /** Applies the app's theme classes to a frame's document. */
    applyTheme(doc: Document): void;
}

declare global {
    interface Window {
        __ankiHost?: HostApi;
    }
}

const frames = new Map<Window, FrameOwner>();

export function attachFrame(frame: Window, owner: FrameOwner): () => void {
    frames.set(frame, owner);
    return () => {
        if (frames.get(frame) === owner) {
            frames.delete(frame);
        }
    };
}

export function frameOwner(frame: Window | null): FrameOwner | undefined {
    return frame ? frames.get(frame) : undefined;
}

/** The window a call came from (desktop's activeModalWidget()). */
export function sourceWindow(frame: Window | null): WindowHandle | null {
    return frameOwner(frame)?.window ?? null;
}

export function attachedFrames(): Window[] {
    return [...frames.keys()];
}

function applyTheme(doc: Document): void {
    applyThemeClasses(doc, get(nightMode), get(reduceMotion), "last");
}

/** Evaluates `fn` in a frame, ignoring frames that are gone or not ready. */
function inFrame(frame: Window, fn: (frame: Window & typeof globalThis) => void): void {
    try {
        fn(frame as Window & typeof globalThis);
    } catch (err) {
        console.warn("frame call failed", err);
    }
}

export function installHost(): void {
    window.__ankiHost = {
        async call(method, input, opChangesType, source) {
            // copy, so the bytes belong to this realm
            return callBackend(method, new Uint8Array(input), opChangesType, { source });
        },
        async bridge(source, cmd) {
            if (cmd === "editorReady") {
                // every editor, wherever it is shown
                setupEditorPlugins(source);
            }
            const owner = frames.get(source);
            if (!owner?.onBridge) {
                console.debug("unhandled bridge command", cmd);
                return undefined;
            }
            return owner.onBridge(cmd, source);
        },
        escape(source) {
            frames.get(source)?.onEscape?.();
        },
        key(source, event) {
            return frames.get(source)?.onKey?.(event) ?? false;
        },
        applyTheme,
    };

    // desktop's webview.on_operation_did_execute
    onOpChanges((changes, initiator) => {
        const json = changes.toJson();
        for (const frame of frames.keys()) {
            if (frame !== initiator) {
                inFrame(frame, (f) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const anki = (f as any).anki;
                    anki?.onOperationDidExecute?.(JSON.parse(JSON.stringify(json)));
                });
            }
        }
    });

    const reapply = () => {
        for (const frame of frames.keys()) {
            inFrame(frame, (f) => f.document && applyTheme(f.document));
        }
    };
    nightMode.subscribe(reapply);
    reduceMotion.subscribe(reapply);
}
