// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Messages between the app and card frames (cardframe.ts and cardpage.ts).
 * Requests carry an id that the reply repeats.
 */

import type { KeyLike } from "./keys";

export type FrameMessage =
    /** The page loaded and is listening; the version it runs. */
    | { type: "hello"; version?: string }
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
    /** Media sync downloaded files: images that failed to load may load now. */
    | { type: "mediaArrived" }
    | { type: "reply"; id: number; value?: unknown; error?: string };

/** The system UI font. */
export const SYSTEM_FONT = `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

// iPads also report MacIntel, but have touch points
const isMacDesktop = /Mac/.test(navigator.platform) && navigator.maxTouchPoints <= 1;

/** The font desktop's standard_css() sets on every webview: Helvetica on macOS, the system font elsewhere. */
export const WEBVIEW_FONT = isMacDesktop ? "Helvetica" : SYSTEM_FONT;

/** The platform class desktop puts on every webview's body (theme.py's body_class()). */
export const PLATFORM_CLASS = isMacDesktop ? "isMac" : /Win/.test(navigator.platform) ? "isWin" : "isLin";

const isApple = /Mac|iPhone|iPad/.test(navigator.platform);

/** The platform class on a card's body: templates' .isMac rules also suit iPhones and iPads. */
export const CARD_PLATFORM_CLASS = isApple ? "isMac" : PLATFORM_CLASS;

/** desktop's standard_css(): the webview font, and the platform's button style */
const STANDARD_CSS = `html { font-family: ${WEBVIEW_FONT}; }\n`
    + (isMacDesktop
        ? `button { --canvas: #fff; -webkit-appearance: none; background: var(--canvas);
    border-radius: var(--border-radius); padding: 3px 12px; border: 1px solid var(--border);
    box-shadow: 0px 1px 3px var(--border-subtle); font-family: Helvetica; }
.night-mode button { --canvas: #606060; --fg: #eee; }`
        : PLATFORM_CLASS === "isWin" || isApple
        ? `button { font-family: inherit; }`
        : `button { font-family: inherit; }
textarea:focus, input:focus, input[type]:focus, .uneditable-input:focus, div[contenteditable="true"]:focus {
    outline: 0 none; border-color: var(--border-focus); }`);

/** Applies the app's theme classes to a frame's document. */
export function applyThemeClasses(doc: Document, night: boolean, reduceMotion: boolean): void {
    if (!doc.getElementById("anki-standard-css")) {
        const style = doc.createElement("style");
        style.id = "anki-standard-css";
        style.textContent = STANDARD_CSS;
        // after the page's stylesheets, as desktop has it after webview.css and
        // Svelte pages' styles; a card's own styles are in the body, later still
        doc.head?.append(style);
    }
    const root = doc.documentElement;
    root.classList.toggle("night-mode", night);
    root.dataset.bsTheme = night ? "dark" : "light";
    doc.body?.classList.toggle("nightMode", night);
    // cards set their own (cardBodyClass)
    if (doc.body && !/\bis(Mac|Win|Lin)\b/.test(doc.body.className)) {
        doc.body.classList.add(PLATFORM_CLASS);
    }
    doc.body?.classList.add("fancy");
    doc.body?.classList.toggle("reduce-motion", reduceMotion);
}
