// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Messages between the app and card frames (cardframe.ts and cardpage.ts).
 * Requests carry an id that the reply repeats.
 */

import type { KeyLike } from "./keys";

export type FrameMessage =
    /** The page loaded and is listening. */
    | { type: "hello" }
    | { type: "bridge"; id: number; cmd: string }
    | { type: "call"; id: number; method: string; input: Uint8Array; opChangesType: number }
    | { type: "key"; event: KeyLike & { repeat: boolean } }
    | { type: "escape" }
    /** A media file for the card origin's service worker; answered on the transferred port. */
    | { type: "media"; path: string; range: string | null }
    | { type: "reply"; id: number; value?: unknown; error?: string };

export type AppMessage =
    /** Runs one of the reviewer script's global functions (_showQuestion and so on). */
    | { type: "run"; id: number; fn: string; args: unknown[] }
    | { type: "eval"; id: number; code: string }
    | { type: "theme"; night: boolean; reduceMotion: boolean }
    /** Shortcut keys whose browser default the frame should prevent. */
    | { type: "keys"; keys: string[] }
    | { type: "reply"; id: number; value?: unknown; error?: string };

/** Applies the app's theme classes to a frame's document. */
/** The system UI font, as desktop's standard_css() sets on every page. */
export const SYSTEM_FONT = `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

export function applyThemeClasses(doc: Document, night: boolean, reduceMotion: boolean): void {
    if (!doc.getElementById("anki-standard-css")) {
        const style = doc.createElement("style");
        style.id = "anki-standard-css";
        style.textContent = `html { font-family: ${SYSTEM_FONT}; } button { font-family: inherit; }`;
        // first, so page and card styles still override it
        doc.head?.prepend(style);
    }
    const root = doc.documentElement;
    root.classList.toggle("night-mode", night);
    root.dataset.bsTheme = night ? "dark" : "light";
    doc.body?.classList.toggle("nightMode", night);
    doc.body?.classList.add("fancy");
    doc.body?.classList.toggle("reduce-motion", reduceMotion);
}
