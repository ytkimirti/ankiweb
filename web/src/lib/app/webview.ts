// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * The frame side of the webview bridge (see host.ts): runs in iframes that
 * show desktop ts/ pages, and connects them to the app that embeds them.
 */

import { setProtoTransport } from "@generated/post";

import type { HostApi } from "./host";

function isEditable(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

export function hostApi(): HostApi | null {
    try {
        return window.parent !== window ? window.parent.__ankiHost ?? null : null;
    } catch {
        return null;
    }
}

/** Returns false when the page was opened outside the app. */
export function connectToHost(): boolean {
    const host = hostApi();
    if (!host) {
        return false;
    }
    setProtoTransport(async (method, input, opChangesType) => {
        try {
            return new Uint8Array(await host.call(method, input, opChangesType, window));
        } catch (err) {
            // rethrow as an error of this realm, so instanceof checks work
            const local = new Error((err as Error)?.message ?? String(err));
            local.name = (err as Error)?.name ?? "Error";
            throw local;
        }
    });
    window.bridgeCommand = <T>(cmd: string, callback?: (value: T) => void) => {
        host.bridge(window, cmd).then(
            (value) => callback?.(value as T),
            (err) => console.error(err),
        );
    };
    // desktop pages use pycmd too
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).pycmd = window.bridgeCommand;
    host.applyTheme(document);
    addEventListener("DOMContentLoaded", () => host.applyTheme(document));
    addEventListener("keydown", (event) => {
        if (event.defaultPrevented) {
            return;
        }
        if (event.key === "Escape" && !document.querySelector(".modal.show")) {
            host.escape(window);
        } else if (!isEditable(event.target) && host.key(window, event)) {
            event.preventDefault();
        }
    });
    return true;
}
