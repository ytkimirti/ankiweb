// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * The app's side of a card frame: desktop's reviewer webview, which shows card
 * HTML and runs its scripts. The frame is loaded from the card origin (see
 * lib/config.ts) and reaches the app only through these messages, which allow
 * bridge commands, the few backend methods the reviewer script uses, and media
 * files. See cardpage.ts for the frame side.
 */

import { get } from "svelte/store";

import { cardOrigin } from "../config";
import { readMediaFile } from "../media-file";
import { callBackend } from "./backend";
import type { AppMessage, FrameMessage } from "./card-messages";
import type { KeyLike } from "./keys";
import { mediaProfile } from "./media";
import { reduceMotion } from "./settings";
import { nightMode } from "./theme";

/** Backend methods card frames may call: custom scheduling and translations. */
const FRAME_METHODS = new Set(["getSchedulingStatesWithContext", "setSchedulingStates", "i18nResources"]);

export interface CardFrameOwner {
    onBridge?: (cmd: string) => unknown;
    /** A key pressed outside a text field in the frame. */
    onKey?: (event: KeyLike & { repeat: boolean }) => void;
    /** The user pressed Escape in the frame. */
    onEscape?: () => void;
    /** Shortcut keys (as in shortcuts.ts) the frame should keep from the browser. */
    keys?: () => string[];
    /** The frame reloaded and lost what it showed. */
    onReload?: () => void;
}

/** The URL card frames load. */
export function cardFrameUrl(): string {
    return `${cardOrigin()}/reviewer?host=${encodeURIComponent(location.origin)}`;
}

const frames = new Map<Window, CardFrame>();
let listening = false;

function listen(): void {
    if (listening) {
        return;
    }
    listening = true;
    addEventListener("message", (event) => {
        const frame = event.source ? frames.get(event.source as Window) : undefined;
        if (frame && event.origin === cardOrigin()) {
            void frame.handle(event.data as FrameMessage, event.ports);
        }
    });
}

export class CardFrame {
    /** Resolves when the reviewer script in the frame is ready. */
    ready!: Promise<void>;
    private markReady!: () => void;
    private loaded = false;
    private nextId = 1;
    private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
    private nightOverride: boolean | null = null;
    private readonly target: Window;
    private readonly cleanups: (() => void)[] = [];

    constructor(iframe: HTMLIFrameElement, private owner: CardFrameOwner) {
        this.target = iframe.contentWindow!;
        this.resetReady();
        listen();
        frames.set(this.target, this);
        this.cleanups.push(nightMode.subscribe(() => this.sendTheme()));
        this.cleanups.push(reduceMotion.subscribe(() => this.sendTheme()));
    }

    destroy(): void {
        if (frames.get(this.target) === this) {
            frames.delete(this.target);
        }
        this.cleanups.forEach((fn) => fn());
        this.rejectPending();
    }

    /** Runs one of the reviewer script's functions in the frame; undefined if it failed. */
    async call<T = unknown>(fn: string, ...args: unknown[]): Promise<T | undefined> {
        await this.ready;
        try {
            return (await this.request({ type: "run", fn, args })) as T;
        } catch (err) {
            console.error(`card frame ${fn} failed`, err);
            return undefined;
        }
    }

    /** Runs code in the frame, as desktop's webview eval. */
    async eval(code: string): Promise<void> {
        await this.ready;
        await this.request({ type: "eval", code });
    }

    /** Shows the frame in day or night mode regardless of the app's (null to follow it). */
    setNightMode(night: boolean | null): void {
        this.nightOverride = night;
        this.sendTheme();
    }

    /** Sends the current shortcut keys, after the owner changes them. */
    sendKeys(): void {
        this.post({ type: "keys", keys: this.owner.keys?.() ?? [] });
    }

    private resetReady(): void {
        this.ready = new Promise((resolve) => (this.markReady = resolve));
    }

    private rejectPending(): void {
        for (const { reject } of this.pending.values()) {
            reject(new Error("card frame closed"));
        }
        this.pending.clear();
    }

    private post(message: AppMessage, transfer: Transferable[] = []): void {
        try {
            this.target.postMessage(message, cardOrigin(), transfer);
        } catch (err) {
            console.warn("card frame message failed", err);
        }
    }

    private request(message: { type: "run"; fn: string; args: unknown[] } | { type: "eval"; code: string }): Promise<unknown> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.post({ ...message, id });
        });
    }

    private reply(id: number, value: unknown, error?: string, transfer: Transferable[] = []): void {
        try {
            this.target.postMessage({ type: "reply", id, value, error } satisfies AppMessage, cardOrigin(), transfer);
        } catch {
            // the value could not be cloned
            this.post({ type: "reply", id, value: undefined, error });
        }
    }

    private sendTheme(): void {
        this.post({ type: "theme", night: this.nightOverride ?? get(nightMode), reduceMotion: get(reduceMotion) });
    }

    /** @internal */
    async handle(message: FrameMessage, ports: readonly MessagePort[]): Promise<void> {
        switch (message?.type) {
            case "hello":
                if (this.loaded) {
                    // the page reloaded; what it showed and was asked is gone
                    this.rejectPending();
                    this.resetReady();
                    this.owner.onReload?.();
                }
                this.loaded = true;
                this.sendTheme();
                this.sendKeys();
                break;
            case "bridge": {
                const cmd = String(message.cmd);
                if (cmd === "reviewerReady") {
                    this.markReady();
                    this.reply(message.id, undefined);
                    break;
                }
                try {
                    this.reply(message.id, await this.owner.onBridge?.(cmd));
                } catch (err) {
                    this.reply(message.id, undefined, String(err));
                }
                break;
            }
            case "call": {
                if (!FRAME_METHODS.has(message.method)) {
                    this.reply(message.id, undefined, `${message.method} is not available to cards`);
                    break;
                }
                try {
                    const input = new Uint8Array(message.input);
                    const output = await callBackend(message.method, input, message.opChangesType, { source: null });
                    const copy = output.slice();
                    this.reply(message.id, copy, undefined, [copy.buffer]);
                } catch (err) {
                    this.reply(message.id, undefined, (err as Error)?.message ?? String(err));
                }
                break;
            }
            case "key":
                this.owner.onKey?.(message.event);
                break;
            case "escape":
                this.owner.onEscape?.();
                break;
            case "media": {
                const port = ports[0];
                if (!port) {
                    break;
                }
                try {
                    port.postMessage(await readMediaFile(mediaProfile(), String(message.path), message.range ?? null));
                } catch {
                    port.postMessage(null);
                }
                port.close();
                break;
            }
            case "reply": {
                const pending = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) {
                    pending?.reject(new Error(message.error));
                } else {
                    pending?.resolve(message.value);
                }
                break;
            }
        }
    }
}
