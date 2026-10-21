// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * The main window's state (desktop's AnkiQt): which screen is showing, the
 * undo state, and the startup sequence.
 */

import { BackendError_Kind } from "@generated/anki/backend_pb";
import type { OpChanges } from "@generated/anki/collection_pb";
import { getUndoStatus, redo, undo } from "@generated/backend";
import * as tr from "@generated/ftl";
import { get, writable } from "svelte/store";

import { BackendError } from "../engine/client";
import { hooks, type MainState } from "../plugins/hooks";
import { showError, tooltip } from "./dialogs";
import { onOpChanges } from "./ops";
import { clearStateShortcuts } from "./shortcuts";

export type { MainState };

export const mainState = writable<MainState>("startup");

export function moveToState(state: MainState): void {
    const old = get(mainState);
    hooks.stateWillChange.run(state, old);
    if (state === old) {
        // the screen stays mounted and keeps its shortcuts; desktop re-enters
        // the state, which reloads it
        reset();
    } else {
        clearStateShortcuts();
        mainState.set(state);
    }
    hooks.stateDidChange.run(state, old);
}

/** Increments when the main screen should reload its data (desktop's mw.reset()). */
export const resetCounter = writable(0);

export function reset(): void {
    resetCounter.update((n) => n + 1);
}

// Undo
//////////////////////////////////////////////////////////////////////////////

export interface UndoInfo {
    undoText: string;
    redoText: string;
    canUndo: boolean;
    canRedo: boolean;
}

const emptyUndo = (): UndoInfo => ({
    undoText: tr.undoUndo(),
    redoText: tr.undoRedo(),
    canUndo: false,
    canRedo: false,
});

export const undoInfo = writable<UndoInfo>({ undoText: "Undo", redoText: "Redo", canUndo: false, canRedo: false });

export async function updateUndoActions(): Promise<void> {
    try {
        const status = await getUndoStatus({}, { alertOnError: false });
        undoInfo.set({
            undoText: status.undo ? tr.undoUndoAction({ val: status.undo }) : tr.undoUndo(),
            redoText: status.redo ? tr.undoRedoAction({ action: status.redo }) : tr.undoRedo(),
            canUndo: !!status.undo,
            canRedo: !!status.redo,
        });
    } catch {
        undoInfo.set(emptyUndo());
    }
}

/** Desktop ignores undo and redo with nothing to undo (its shortcut can fire anyway). */
function isUndoEmpty(err: unknown): boolean {
    return err instanceof BackendError && err.kind === BackendError_Kind.UNDO_EMPTY;
}

export async function undoAction(): Promise<void> {
    try {
        const out = await undo({}, { alertOnError: false });
        tooltip(tr.undoActionUndone({ action: out.operation }));
    } catch (err) {
        if (!isUndoEmpty(err)) {
            await showError(err);
        }
    }
}

export async function redoAction(): Promise<void> {
    try {
        const out = await redo({}, { alertOnError: false });
        tooltip(tr.undoActionRedone({ action: out.operation }));
    } catch (err) {
        if (!isUndoEmpty(err)) {
            await showError(err);
        }
    }
}

export function watchOperations(): void {
    onOpChanges((changes: OpChanges, initiator) => {
        void updateUndoActions();
        hooks.operationDidExecute.run(changes, initiator);
    });
}

export function clearUndoInfo(): void {
    undoInfo.set(emptyUndo());
}
