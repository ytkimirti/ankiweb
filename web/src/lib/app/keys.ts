// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Matching key events against shortcut specs written like Qt key sequences
 * ("a", "Shift+t", "Ctrl+Alt+N", "Enter", "F5"). Shared by the app and the
 * card frame, so it imports nothing from the app.
 */

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

export interface KeyLike {
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

export function matches(spec: string, event: KeyLike): boolean {
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

