// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** Running backend operations from the app (desktop's CollectionOp/QueryOp). */

import { showError } from "./dialogs";
import { withProgress } from "./progress";

export interface RunOptions {
    /** Show a progress indicator if the operation is slow; a string sets its label. */
    progress?: boolean | string;
    cancellable?: boolean;
}

/** Runs an operation, reporting errors to the user. Resolves undefined on failure. */
export async function runOp<T>(fn: () => Promise<T>, options: RunOptions = {}): Promise<T | undefined> {
    try {
        if (options.progress) {
            return await withProgress(fn, {
                label: typeof options.progress === "string" ? options.progress : undefined,
                cancellable: options.cancellable,
            });
        }
        return await fn();
    } catch (err) {
        await showError(err);
        return undefined;
    }
}
