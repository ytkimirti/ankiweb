// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Card HTML can contain scripts, so cards are shown in frames from a separate
 * origin that serves the same build (VITE_CARD_ORIGIN at build time, e.g.
 * https://cards.example.com). Scripts there cannot reach the app's storage,
 * the sync key or the backend; the frame talks to the app only through the
 * messages in app/cardframe.ts. Without it, card frames share the app's
 * origin, as desktop's webviews do.
 */

const configured = originOf((import.meta.env.VITE_CARD_ORIGIN as string | undefined) ?? "");

function originOf(value: string): string {
    // vite.config.ts rejects values that are not URLs
    return value ? new URL(value).origin : "";
}

/** The origin card frames are loaded from. */
export function cardOrigin(): string {
    return configured || self.location.origin;
}

/** True when this context is the separate card origin, not the app. */
export function isCardOrigin(): boolean {
    return !!configured && self.location.origin === configured;
}
