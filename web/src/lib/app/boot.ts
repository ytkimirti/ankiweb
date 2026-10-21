// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** Startup and profile loading (desktop's AnkiQt.setupProfile/loadProfile). */

import { setAlertOnErrorDefault } from "@generated/post";
import * as tr from "@generated/ftl";
import { setupGlobalI18n } from "@tslib/i18n";
import { get } from "svelte/store";

import { hooks } from "../plugins/hooks";
import { loadPlugins } from "../plugins/loader";
import * as actions from "./actions";
import { startEngine } from "./backend";
import { showError } from "./dialogs";
import { registerFrontendHandlers } from "./frontend";
import { installHost } from "./host";
import { clearUndoInfo, mainState, moveToState, redoAction, undoAction, updateUndoActions, watchOperations } from "./main";
import { setMediaProfile } from "./media";
import { toggleFullScreen } from "./settings";
import { addProfile, backupNow, closeProfile, currentProfile, getMeta, lastProfile, openProfile } from "./profiles";
import { loadReviewerSettings, registerReviewerFrontendMethods } from "./reviewer";
import { installShortcuts, setGlobalShortcuts } from "./shortcuts";
import {
    automaticSyncAndBackupsSuspended,
    autoSyncingEnabled,
    maybeAutoSync,
    onSync,
    startPeriodicMediaSync,
    stopPeriodicMediaSync,
    suspendAutomaticSyncAndBackups,
    syncAuth,
    syncCollectionAndMedia,
} from "./sync";
import { closeAllWindows } from "./windows";

/** Languages for the interface: the one chosen in preferences, else the browser's. */
export function preferredLanguages(): string[] {
    const chosen = getMeta<string | null>("defaultLang", null);
    return chosen ? [chosen] : navigator.languages.slice();
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

export function globalShortcuts(): [string, () => void][] {
    return [
        ["d", () => moveToState("deckBrowser")],
        ["s", actions.onStudyKey],
        ["a", actions.onAddCard],
        ["b", actions.onBrowse],
        ["t", actions.onStats],
        ["Shift+t", actions.onStats],
        ["y", () => void onSync()],
        ["Ctrl+Shift+P", () => void switchProfile()],
        ["Ctrl+Shift+I", () => void actions.onImport()],
        ["Ctrl+E", () => void actions.onExport()],
        ["Ctrl+Z", () => void undoAction()],
        [isMac ? "Ctrl+Shift+Z" : "Ctrl+Y", () => void redoAction()],
        ["/", () => void actions.onStudyDeck()],
        ["f", () => void actions.onFilteredDeck()],
        ["Ctrl+Shift+N", () => void actions.onNoteTypes()],
        ["Ctrl+P", () => void actions.onPrefs()],
        ["F1", actions.onDocumentation],
        ["F11", toggleFullScreen],
    ];
}

let backupTimer: ReturnType<typeof setInterval> | null = null;

export async function boot(): Promise<void> {
    installHost();
    setAlertOnErrorDefault(false);
    await startEngine(preferredLanguages());
    await setupGlobalI18n();
    registerFrontendHandlers();
    registerReviewerFrontendMethods();
    watchOperations();
    installShortcuts();
    setGlobalShortcuts(globalShortcuts());
    await loadPlugins();
    let name = lastProfile();
    if (!name) {
        name = tr.profilesUser1();
        addProfile(name);
    }
    await loadProfile(name);
}

export async function loadProfile(name: string): Promise<void> {
    try {
        await openProfile(name);
    } catch (err) {
        await showError(err);
        moveToState("profiles");
        return;
    }
    suspendAutomaticSyncAndBackups(false);
    await setMediaProfile(name);
    await loadReviewerSettings();
    hooks.profileDidOpen.run(name);
    await updateUndoActions();
    moveToState("deckBrowser");
    // desktop backs up periodically; the backend skips it if too little has changed
    backupTimer ??= setInterval(() => {
        if (get(currentProfile) && get(mainState) !== "review" && !automaticSyncAndBackupsSuspended()) {
            void backupNow(false).catch(() => {});
        }
    }, 5 * 60_000);
    startPeriodicMediaSync();
    void maybeAutoSync();
}

/** Closes the open profile; resolves false if a window refused to close. */
export async function unloadProfile(): Promise<boolean> {
    const name = get(currentProfile);
    if (!name) {
        return true;
    }
    if (!(await closeAllWindows())) {
        return false;
    }
    if (autoSyncingEnabled() && syncAuth() && navigator.onLine) {
        await syncCollectionAndMedia();
    }
    hooks.profileWillClose.run(name);
    stopPeriodicMediaSync();
    moveToState("profiles");
    try {
        await closeProfile({ backup: !automaticSyncAndBackupsSuspended() });
    } catch (err) {
        await showError(err);
    }
    await setMediaProfile(null);
    clearUndoInfo();
    return true;
}

export async function switchProfile(): Promise<void> {
    if (await unloadProfile()) {
        moveToState("profiles");
    }
}
