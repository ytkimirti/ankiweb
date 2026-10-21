// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Main-window keyboard shortcuts (desktop's applyShortcuts and
 * setStateShortcuts). Keys are written like Qt key sequences: "a",
 * "Shift+t", "Ctrl+Alt+N", "Enter", "F5".
 */

import { get } from "svelte/store";

import { dialogs } from "./dialogs";
import { openMenus } from "./menus";
import { windows } from "./windows";

export type ShortcutHandler = () => void;
export type Shortcut = [key: string, handler: ShortcutHandler];

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

let globalShortcuts: Shortcut[] = [];
let stateShortcuts: Shortcut[] = [];

export function setGlobalShortcuts(shortcuts: Shortcut[]): void {
    globalShortcuts = shortcuts;
}

/** Shortcuts of the current main-window state; replaced on each state change. */
export function setStateShortcuts(shortcuts: Shortcut[]): void {
    stateShortcuts = shortcuts;
}

export function clearStateShortcuts(): void {
    stateShortcuts = [];
}

interface KeyLike {
    key: string;
    code?: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
}

const named: Record<string, string> = {
    enter: "Enter",
    return: "Enter",
    space: " ",
    esc: "Escape",
    escape: "Escape",
    backspace: "Backspace",
    delete: "Delete",
    del: "Delete",
    left: "ArrowLeft",
    right: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
    tab: "Tab",
};

function matches(spec: string, event: KeyLike): boolean {
    const parts = spec.split("+");
    let keyPart = parts.pop()!;
    if (keyPart === "" && spec.endsWith("+")) {
        keyPart = "+";
        parts.pop();
    }
    const mods = new Set(parts.map((p) => p.toLowerCase()));
    // Ctrl means Cmd on macOS, as in Qt
    const wantCtrl = mods.has("ctrl");
    const ctrl = isMac ? event.metaKey : event.ctrlKey;
    if (wantCtrl !== ctrl || mods.has("alt") !== event.altKey) {
        return false;
    }
    const key = named[keyPart.toLowerCase()] ?? keyPart;
    if (/^F\d+$/.test(key) || key.length > 1) {
        return event.key === key && mods.has("shift") === event.shiftKey;
    }
    if (/^[a-z0-9]$/i.test(key)) {
        // letters and digits match by physical key too, so shortcuts work
        // with Ctrl/Alt held and on non-Latin layouts
        const pressed = event.key.length === 1 ? event.key.toLowerCase() : "";
        const byCode = event.code === `Key${key.toUpperCase()}` || event.code === `Digit${key}`;
        return (pressed === key.toLowerCase() || (byCode && (ctrl || event.altKey)))
            && mods.has("shift") === event.shiftKey;
    }
    // symbols like "*", "=", "!" already include any Shift
    return event.key === key;
}

export function isEditable(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.closest !== "function") {
        return false;
    }
    return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

/** True while a window, dialog or menu covers the main window. */
export function mainWindowBlocked(): boolean {
    return get(windows).length > 0 || get(dialogs).length > 0 || get(openMenus).length > 0;
}

/** Runs the matching shortcut; returns true if one ran. */
export function handleKey(event: KeyLike, target: EventTarget | null = null): boolean {
    if (mainWindowBlocked() || isEditable(target)) {
        return false;
    }
    for (const [spec, handler] of [...stateShortcuts, ...globalShortcuts]) {
        if (matches(spec, event)) {
            handler();
            return true;
        }
    }
    return false;
}

export function installShortcuts(): void {
    addEventListener("keydown", (event) => {
        if (event.defaultPrevented || event.repeat && !/^[1-4 ]$/.test(event.key)) {
            return;
        }
        if (handleKey(event, event.target)) {
            event.preventDefault();
        }
    });
}

/** How a shortcut is shown in tooltips and menus. */
export function shortcutLabel(spec: string): string {
    if (!isMac) {
        return spec;
    }
    return spec.replace(/Ctrl\+/g, "⌘").replace(/Alt\+/g, "⌥").replace(/Shift\+/g, "⇧");
}
