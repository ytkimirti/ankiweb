// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** The card previewer (desktop's browser/previewer.py). */

import * as tr from "@generated/ftl";

import { tooltip } from "./dialogs";
import { reviewer } from "./reviewer";
import { findWindow, openWindow, type WindowHandle } from "./windows";

export interface PreviewSource {
    /** The card to show; null when none (or several) are selected. */
    current(): bigint | null;
    /** Moves to the previous/next card; false at either end. */
    prev?(): boolean;
    next?(): boolean;
    canPrev?(): boolean;
    canNext?(): boolean;
    /** Calls back when the current card changes. */
    subscribe?(callback: () => void): () => void;
}

export async function openPreviewer(source: PreviewSource, onClose?: () => void): Promise<WindowHandle> {
    const existing = findWindow("previewer");
    if (existing) {
        existing.close();
    }
    const { default: Previewer } = await import("../ui/Previewer.svelte");
    return openWindow({
        key: "previewer",
        title: tr.actionsPreview(),
        component: Previewer,
        props: { source },
        size: "md",
        onClose: () => onClose?.(),
    });
}

/** The editor's preview button outside the browser: shows the card being edited. */
export async function openPreviewerForEditor(_editor: WindowHandle): Promise<void> {
    const card = reviewer.card?.id ?? null;
    if (card === null) {
        tooltip(tr.cardStatsNoCard());
        return;
    }
    await openPreviewer({ current: () => card });
}
