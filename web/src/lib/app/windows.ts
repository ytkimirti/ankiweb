// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * In-page windows, standing in for desktop's dialogs and secondary windows
 * (aqt.dialogs). A window shows either a Svelte component or a webview page
 * (a desktop ts/ page in an iframe). Rendered by WindowHost.svelte.
 */

import type { Component } from "svelte";
import { get, writable } from "svelte/store";

import { attachFrame } from "./host";

export type WindowSize = "sm" | "md" | "lg" | "xl" | "full";

export interface WindowSpec {
    /** Only one window per key is open at a time; opening it again focuses it. */
    key?: string;
    title: string;
    /** A webview page, e.g. "/deck-options/1". */
    url?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    component?: Component<any>;
    props?: Record<string, unknown>;
    size?: WindowSize;
    /** Handles bridgeCommand() calls from the webview. */
    onBridge?: (cmd: string, win: WindowHandle) => unknown;
    /** Called each time the webview finishes loading. */
    onLoad?: (frame: Window, win: WindowHandle) => void;
    /** Asked before the user closes the window; return false to keep it open. */
    canClose?: (win: WindowHandle) => boolean | Promise<boolean>;
    onClose?: (win: WindowHandle) => void;
}

export interface AppWindow extends WindowSpec {
    id: number;
    handle: WindowHandle;
}

export const windows = writable<AppWindow[]>([]);

let nextId = 1;

export class WindowHandle {
    readonly id: number;
    /** The webview's window, once its iframe exists. */
    frame: Window | null = null;
    closed = false;
    private detachFrame: (() => void) | null = null;
    private loadWaiters: (() => void)[] = [];
    loaded = false;

    constructor(id: number) {
        this.id = id;
    }

    private get entry(): AppWindow | undefined {
        return get(windows).find((w) => w.id === this.id);
    }

    get spec(): WindowSpec | undefined {
        return this.entry;
    }

    setTitle(title: string): void {
        windows.update((list) => list.map((w) => (w.id === this.id ? { ...w, title } : w)));
    }

    focus(): void {
        windows.update((list) => {
            const entry = list.find((w) => w.id === this.id);
            return entry ? [...list.filter((w) => w.id !== this.id), entry] : list;
        });
    }

    /** Closes after asking canClose, like the user pressing the close button. */
    async requestClose(): Promise<void> {
        const spec = this.entry;
        if (!spec || this.closed) {
            return;
        }
        if (spec.canClose && !(await spec.canClose(this))) {
            return;
        }
        this.close();
    }

    /** Closes immediately. */
    close(): void {
        const spec = this.entry;
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.detachFrame?.();
        windows.update((list) => list.filter((w) => w.id !== this.id));
        spec?.onClose?.(this);
    }

    /** Resolves once the webview has loaded. */
    whenLoaded(): Promise<void> {
        if (this.loaded) {
            return Promise.resolve();
        }
        return new Promise((resolve) => this.loadWaiters.push(resolve));
    }

    /** Called by WindowHost when the iframe is created. */
    setFrame(frame: Window): void {
        if (this.frame === frame) {
            return;
        }
        this.detachFrame?.();
        this.frame = frame;
        this.detachFrame = attachFrame(frame, {
            window: this,
            onBridge: (cmd) => this.entry?.onBridge?.(cmd, this),
            onEscape: () => void this.requestClose(),
        });
    }

    /** Called by WindowHost when the iframe has loaded. */
    frameLoaded(): void {
        if (!this.frame) {
            return;
        }
        this.loaded = true;
        this.entry?.onLoad?.(this.frame, this);
        for (const waiter of this.loadWaiters.splice(0)) {
            waiter();
        }
    }
}

export function openWindow(spec: WindowSpec): WindowHandle {
    if (spec.key) {
        const existing = findWindow(spec.key);
        if (existing) {
            existing.focus();
            return existing;
        }
    }
    const id = nextId++;
    const handle = new WindowHandle(id);
    windows.update((list) => [...list, { size: "lg", ...spec, id, handle }]);
    return handle;
}

export function findWindow(key: string): WindowHandle | null {
    return get(windows).find((w) => w.key === key)?.handle ?? null;
}

/** Asks every window to close; resolves false if one refused. */
export async function closeAllWindows(): Promise<boolean> {
    for (const win of [...get(windows)].reverse()) {
        await win.handle.requestClose();
    }
    return get(windows).length === 0;
}
