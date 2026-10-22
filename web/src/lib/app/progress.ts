// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * A modal progress indicator for long operations (desktop's ProgressManager),
 * fed by the engine's progress updates. Rendered by ProgressHost.svelte.
 */

import type { Progress } from "@generated/anki/collection_pb";
import * as tr from "@generated/ftl";
import * as trq from "@generated/ftl-qt";
import { writable } from "svelte/store";

import { getEngine } from "./backend";

export interface ProgressInfo {
    title?: string;
    label: string;
    /** A line under the bar, such as how much has been transferred. */
    detail?: string;
    value?: number;
    max?: number;
    cancellable: boolean;
}

export const progressState = writable<ProgressInfo | null>(null);

function describe(progress: Progress, fallback: string): Partial<ProgressInfo> | null {
    const value = progress.value;
    switch (value.case) {
        case "mediaSync":
            return { label: [value.value.checked, value.value.added, value.value.removed].filter(Boolean).join("\n") };
        case "mediaCheck":
        case "importing":
        case "exporting":
            return { label: value.value };
        case "fullSync": {
            const { transferred, total } = value.value;
            return {
                label: transferred === total ? tr.syncChecking() : fallback,
                detail: total
                    ? `${megabytes(transferred)} of ${megabytes(total)}`
                    : transferred
                    ? megabytes(transferred)
                    : undefined,
                value: Math.floor(transferred / 1024),
                max: Math.floor(total / 1024),
            };
        }
        case "normalSync":
            return { title: value.value.stage, label: `${value.value.added}\n${value.value.removed}` };
        case "databaseCheck":
            return { label: value.value.stage, value: value.value.stageCurrent, max: value.value.stageTotal };
        case "computeParams":
            return { label: fallback, value: value.value.current, max: value.value.total };
        case "computeRetention":
            return { label: fallback, value: value.value.current, max: value.value.total };
        case "computeMemory":
            return { label: value.value.label || fallback, value: value.value.currentCards, max: value.value.totalCards };
        default:
            return null;
    }
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

let depth = 0;

/**
 * Runs `fn`, showing a progress indicator if it takes longer than `delay` ms.
 * With `cancellable`, a cancel button asks the engine to abort.
 */
export async function withProgress<T>(
    fn: () => Promise<T>,
    options: { label?: string; title?: string; cancellable?: boolean; delay?: number } = {},
): Promise<T> {
    const fallback = options.label ?? trq.qtMiscProcessing();
    let info: ProgressInfo = { label: fallback, title: options.title, cancellable: !!options.cancellable };
    let shown = false;
    depth++;
    const timer = setTimeout(() => {
        shown = true;
        progressState.set(info);
    }, options.delay ?? 300);
    const unlisten = getEngine().onProgress((progress) => {
        const update = describe(progress, fallback);
        if (update) {
            info = { ...info, ...update, title: update.title ?? info.title };
            if (shown) {
                progressState.set(info);
            }
        }
    });
    try {
        return await fn();
    } finally {
        clearTimeout(timer);
        unlisten();
        if (--depth === 0) {
            progressState.set(null);
        }
    }
}

export function cancelProgress(): void {
    getEngine().abort();
}
