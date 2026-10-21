// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Main-window keyboard shortcuts (desktop's applyShortcuts and
 * setStateShortcuts). Keys are written like Qt key sequences: "a",
 * "Shift+t", "Ctrl+Alt+N", "Enter", "F5".
 */

import { get } from "svelte/store";

import { dialogs } from "./dialogs";
import { isEditable, type KeyLike, matches } from "./keys";
import { openMenus } from "./menus";
import { windows } from "./windows";

export type ShortcutHandler = () => void;
export type Shortcut = [key: string, handler: ShortcutHandler];

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

export { isEditable };

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

/** True while a window, dialog or menu covers the main window. */
export function mainWindowBlocked(): boolean {
    return get(windows).length > 0 || get(dialogs).length > 0 || get(openMenus).length > 0;
}

/** The keys of the active shortcuts, for card frames to keep from the browser. */
export function shortcutKeys(): string[] {
    return [...stateShortcuts, ...globalShortcuts].map(([spec]) => spec);
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
