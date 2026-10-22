// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** Startup and profile loading (desktop's AnkiQt.setupProfile/loadProfile). */

import { importCollectionPackage } from "@generated/backend";
import { setAlertOnErrorDefault } from "@generated/post";
import * as tr from "@generated/ftl";
import * as trq from "@generated/ftl-qt";
import { setupGlobalI18n } from "@tslib/i18n";
import { get } from "svelte/store";

import { profilePaths } from "../engine/protocol";
import { hooks } from "../plugins/hooks";
import { loadPlugins } from "../plugins/loader";
import * as actions from "./actions";
import { getEngine, startEngine } from "./backend";
import { showError, showInfo, showWarning } from "./dialogs";
import { registerFrontendHandlers } from "./frontend";
import { installHost } from "./host";
import { clearUndoInfo, moveToState, redoAction, undoAction, updateUndoActions, watchOperations } from "./main";
import { setLoadingStage } from "./loading";
import { setMediaProfile } from "./media";
import { toggleFullScreen } from "./settings";
import {
    addProfile,
    addStoredProfiles,
    backupNow,
    closeProfile,
    currentProfile,
    getMeta,
    lastProfile,
    openProfile,
    setMeta,
} from "./profiles";
import { requestPersistentStorage, STORAGE_WARNING } from "./pwa";
import { runOp } from "./run";
import { loadReviewerSettings, registerReviewerFrontendMethods } from "./reviewer";
import { installShortcuts, setGlobalShortcuts } from "./shortcuts";
import {
    automaticSyncAndBackupsSuspended,
    autoSyncingEnabled,
    maybeAutoSync,
    onSync,
    startPeriodicMediaSync,
    stopMediaMonitoring,
    stopPeriodicMediaSync,
    suspendAutomaticSyncAndBackups,
    syncAuth,
    syncCollectionAndMedia,
    waitForMediaSync,
    watchForChanges,
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
    watchForChanges();
    installShortcuts();
    setGlobalShortcuts(globalShortcuts());
    await loadPlugins();
    await addStoredProfiles().catch((err) => console.warn("could not look for stored profiles", err));
    let name = lastProfile();
    if (!name) {
        name = tr.profilesUser1();
        addProfile(name);
    }
    setLoadingStage("Opening your collection…");
    await loadProfile(name);
    void checkPersistentStorage();
}

/**
 * Asks the browser to keep Anki's data, and says once if it won't: the
 * collection, media and backups could all be evicted.
 */
async function checkPersistentStorage(): Promise<void> {
    if (await requestPersistentStorage() || getMeta<boolean>("storageWarned", false)) {
        return;
    }
    setMeta("storageWarned", true);
    await showWarning(STORAGE_WARNING);
}


/**
 * Opens a profile, resolving false if it could not be. After restoring a
 * backup, automatic syncs and backups stay off until it is opened again, as
 * on desktop.
 */
export async function loadProfile(name: string, options: { restoredBackup?: boolean } = {}): Promise<boolean> {
    try {
        await openProfile(name);
    } catch (err) {
        await showError(err);
        moveToState("profiles");
        return false;
    }
    suspendAutomaticSyncAndBackups(!!options.restoredBackup);
    await setMediaProfile(name);
    await loadReviewerSettings();
    hooks.profileDidOpen.run(name);
    await updateUndoActions();
    moveToState("deckBrowser");
    // desktop backs up periodically; the backend skips it if too little has changed
    backupTimer ??= setInterval(() => {
        if (get(currentProfile) && !automaticSyncAndBackupsSuspended()) {
            void backupNow(false).catch(() => {});
        }
    }, 5 * 60_000);
    startPeriodicMediaSync();
    void maybeAutoSync();
    return true;
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
    await waitForMediaSync();
    hooks.profileWillClose.run(name);
    stopPeriodicMediaSync();
    stopMediaMonitoring();
    moveToState("profiles");
    // screens still loading (the deck list refreshes after the sync above)
    // would otherwise call into the closed collection
    await getEngine().waitIdle(200);
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

/**
 * Desktop's Open Backup in the profile manager: replaces a closed profile's
 * collection with a backup, then opens it. Nothing needs backing up first.
 */
export async function restoreClosedProfile(name: string, colpkgPath: string): Promise<boolean> {
    const engine = getEngine();
    await engine.mountProfile(name);
    const paths = profilePaths(name);
    const done = await runOp(() =>
        importCollectionPackage({
            colPath: paths.collection,
            backupPath: colpkgPath,
            mediaFolder: paths.mediaFolder,
            mediaDb: paths.mediaDb,
        }), { progress: true, cancellable: true });
    if (done === undefined) {
        await engine.unmountProfile(name);
        return false;
    }
    if (await loadProfile(name, { restoredBackup: true })) {
        await showInfo(trq.qtMiscAutomaticSyncingAndBackupsHaveBeen());
    }
    return true;
}
