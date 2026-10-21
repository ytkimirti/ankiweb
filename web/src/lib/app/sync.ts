// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Syncing with AnkiWeb (desktop's sync.py and mediasync.py). The engine talks
 * to AnkiWeb through the same-origin /ankiweb-proxy/, since AnkiWeb does not
 * allow cross-origin requests.
 */

import { BackendError_Kind } from "@generated/anki/backend_pb";
import { SyncAuth, SyncCollectionResponse_ChangesRequired, SyncStatusResponse_Required } from "@generated/anki/sync_pb";
import { abortMediaSync, fullUploadOrDownload, syncCollection, syncLogin, syncMedia, syncStatus } from "@generated/backend";
import * as tr from "@generated/ftl";
import * as trq from "@generated/ftl-qt";
import { get, writable } from "svelte/store";

import { BackendError } from "../engine/client";
import { hooks } from "../plugins/hooks";
import { getEngine } from "./backend";
import { errorMessage, openDialog, showInfo, showWarning, tooltip } from "./dialogs";
import { mainState, reset } from "./main";
import { forceMediaResync, getProfileConfig, setProfileConfig } from "./profiles";
import { withProgress } from "./progress";
import { closeAllWindows } from "./windows";

/** The toolbar's sync button state. */
export const syncState = writable<{ required: "none" | "normal" | "full"; mediaSyncing: boolean; syncing: boolean }>({
    required: "none",
    mediaSyncing: false,
    syncing: false,
});

export const mediaSyncLog = writable<string>("");

export function syncAuth(): SyncAuth | null {
    const hkey = getProfileConfig<string | null>("syncKey", null);
    if (!hkey) {
        return null;
    }
    return new SyncAuth({
        hkey,
        endpoint: syncEndpoint() ?? undefined,
        ioTimeoutSecs: getProfileConfig<number>("networkTimeout", 60),
    });
}

function syncEndpoint(): string | null {
    return getProfileConfig<string | null>("currentSyncUrl", null) || getProfileConfig<string | null>("customSyncUrl", null)
        || null;
}

export function mediaSyncingEnabled(): boolean {
    return getProfileConfig<boolean>("syncMedia", true);
}

let automaticSuspended = false;

/** After restoring a backup, until the profile is reopened (desktop does the same). */
export function suspendAutomaticSyncAndBackups(suspend = true): void {
    automaticSuspended = suspend;
}

export function automaticSyncAndBackupsSuspended(): boolean {
    return automaticSuspended;
}

export function autoSyncingEnabled(): boolean {
    return !automaticSuspended && getProfileConfig<boolean>("autoSync", true);
}

function isAuthError(err: unknown): boolean {
    return err instanceof BackendError && err.kind === BackendError_Kind.SYNC_AUTH_ERROR;
}

async function handleSyncError(err: unknown): Promise<void> {
    if (isAuthError(err)) {
        setProfileConfig("syncKey", null);
    } else if (err instanceof BackendError && err.interrupted) {
        return;
    } else if (errorMessage(err) === "500: Interrupted") {
        return;
    }
    await showWarning(errorMessage(err));
}

/** Refreshes the sync button colour (desktop's toolbar sync status check). */
export async function updateSyncStatus(): Promise<void> {
    const auth = syncAuth();
    if (!auth) {
        syncState.update((s) => ({ ...s, required: "none" }));
        return;
    }
    try {
        const out = await syncStatus(auth, { alertOnError: false });
        if (out.newEndpoint) {
            setProfileConfig("currentSyncUrl", out.newEndpoint);
        }
        const required = out.required === SyncStatusResponse_Required.FULL_SYNC
            ? "full"
            : out.required === SyncStatusResponse_Required.NORMAL_SYNC
            ? "normal"
            : "none";
        syncState.update((s) => ({ ...s, required }));
    } catch (err) {
        console.log("sync status check failed:", errorMessage(err));
    }
}

/** Login dialog; resolves true once a key is stored. */
export async function syncLoginDialog(username = "", password = ""): Promise<boolean> {
    for (;;) {
        const result = await openDialog({
            title: trq.qtMiscSync(),
            text: tr.syncAccountRequired({ link: "https://ankiweb.net/account/signup" }),
            html: true,
            form: [
                { key: "user", label: tr.syncAnkiwebIdLabel(), type: "text", value: username },
                { key: "pass", label: tr.syncPasswordLabel(), type: "password", value: password },
            ],
            buttons: [
                { label: tr.actionsCancel(), value: "cancel" },
                { label: tr.helpOk(), value: "ok", primary: true },
            ],
        });
        if (result.button !== "ok") {
            return false;
        }
        username = String(result.form?.user ?? "").trim();
        password = String(result.form?.pass ?? "");
        if (!username || !password) {
            continue;
        }
        try {
            const auth = await withProgress(
                () => syncLogin({ username, password, endpoint: syncEndpoint() ?? undefined }, { alertOnError: false }),
            );
            setProfileConfig("syncKey", auth.hkey);
            setProfileConfig("syncUser", username);
            return true;
        } catch (err) {
            if (isAuthError(err)) {
                await showWarning(errorMessage(err));
                continue;
            }
            await handleSyncError(err);
            return false;
        }
    }
}

export async function logout(): Promise<void> {
    if (get(syncState).mediaSyncing || syncing) {
        await showWarning("Can't log out while sync in progress.");
        return;
    }
    setProfileConfig("syncKey", null);
    setProfileConfig("syncUser", null);
    setProfileConfig("currentSyncUrl", null);
    await withProgress(() => forceMediaResync()).catch(handleSyncError);
    void updateSyncStatus();
}

let syncing = false;

/** The toolbar's sync button (desktop's on_sync_button_clicked). */
export async function onSync(): Promise<void> {
    if (get(syncState).mediaSyncing) {
        await showMediaSyncLog();
        return;
    }
    if (!syncAuth() && !(await syncLoginDialog())) {
        return;
    }
    await syncCollectionAndMedia();
}

export async function syncCollectionAndMedia(): Promise<void> {
    const auth = syncAuth();
    if (!auth || syncing) {
        return;
    }
    syncing = true;
    syncState.update((s) => ({ ...s, syncing: true }));
    hooks.syncWillStart.run();
    try {
        await syncCollectionInner(auth);
    } finally {
        syncing = false;
        syncState.update((s) => ({ ...s, syncing: false }));
        hooks.syncDidFinish.run();
        reset();
        void updateSyncStatus();
    }
}

async function syncCollectionInner(auth: SyncAuth): Promise<void> {
    const withMedia = mediaSyncingEnabled();
    let out;
    try {
        out = await withProgress(
            () => syncCollection({ auth, syncMedia: withMedia }, { alertOnError: false }),
            { label: tr.syncChecking(), title: tr.syncChecking(), cancellable: true, delay: 0 },
        );
    } catch (err) {
        await handleSyncError(err);
        return;
    }
    setProfileConfig("hostNum", out.hostNumber);
    if (out.newEndpoint) {
        setProfileConfig("currentSyncUrl", out.newEndpoint);
    }
    if (out.serverMessage) {
        await showInfo(out.serverMessage, { html: true });
    }
    if (out.required === SyncCollectionResponse_ChangesRequired.NO_CHANGES) {
        tooltip(tr.syncCollectionComplete());
        if (withMedia) {
            startMediaMonitoring();
        }
        return;
    }
    await fullSync(auth, out.required, withMedia ? out.serverMediaUsn : undefined);
}

async function fullSync(auth: SyncAuth, required: SyncCollectionResponse_ChangesRequired, serverUsn?: number): Promise<void> {
    let upload: boolean;
    if (required === SyncCollectionResponse_ChangesRequired.FULL_DOWNLOAD) {
        if (!(await confirm(tr.syncConfirmEmptyDownload()))) {
            return;
        }
        upload = false;
    } else if (required === SyncCollectionResponse_ChangesRequired.FULL_UPLOAD) {
        if (!(await confirm(tr.syncConfirmEmptyUpload()))) {
            return;
        }
        upload = true;
    } else {
        const result = await openDialog({
            title: trq.qtMiscSync(),
            text: tr.syncConflictExplanation2(),
            buttons: [
                { label: tr.syncUploadToAnkiweb(), value: "upload" },
                { label: tr.syncDownloadFromAnkiweb(), value: "download" },
                { label: tr.syncCancelButton(), value: "cancel", primary: true },
            ],
        });
        if (result.button !== "upload" && result.button !== "download") {
            return;
        }
        upload = result.button === "upload";
    }
    if (!(await closeAllWindows())) {
        return;
    }
    try {
        await withProgress(async () => {
            if (!upload) {
                const { backupNow } = await import("./profiles");
                await backupNow(true).catch(() => false);
            }
            await fullUploadOrDownload({ auth, upload, serverUsn }, { alertOnError: false });
        }, {
            label: upload ? tr.syncUploadingToAnkiweb() : tr.syncDownloadingFromAnkiweb(),
            cancellable: true,
            delay: 0,
        });
    } catch (err) {
        await handleSyncError(err);
        return;
    } finally {
        reset();
    }
    if (serverUsn !== undefined) {
        startMediaMonitoring();
    }
}

async function confirm(text: string): Promise<boolean> {
    const result = await openDialog({
        text,
        buttons: [
            { label: tr.actionsCancel(), value: "cancel" },
            { label: tr.helpOk(), value: "ok", primary: true },
        ],
    });
    return result.button === "ok";
}

// Media sync
//////////////////////////////////////////////////////////////////////////////

let unlistenMedia: (() => void) | null = null;
let mediaIdle: ReturnType<typeof setTimeout> | null = null;

/**
 * Media syncing runs in the engine after the collection sync returns; we
 * follow it through progress updates, and treat a quiet period as the end.
 */
function startMediaMonitoring(): void {
    if (unlistenMedia) {
        return;
    }
    syncState.update((s) => ({ ...s, mediaSyncing: true }));
    mediaSyncLog.set(tr.syncMediaStarting());
    const finish = () => {
        unlistenMedia?.();
        unlistenMedia = null;
        if (mediaIdle) {
            clearTimeout(mediaIdle);
        }
        syncState.update((s) => ({ ...s, mediaSyncing: false }));
        mediaSyncLog.set(tr.syncMediaComplete());
    };
    const bump = () => {
        if (mediaIdle) {
            clearTimeout(mediaIdle);
        }
        // a backend call that completes means the engine is free again
        mediaIdle = setTimeout(() => {
            void getEngine().callMethod("latestProgress", new Uint8Array()).finally(finish);
        }, 1500);
    };
    unlistenMedia = getEngine().onProgress((progress) => {
        if (progress.value.case === "mediaSync") {
            const p = progress.value.value;
            mediaSyncLog.set(`${p.added}, ${p.removed}, ${p.checked}`);
            bump();
        }
    });
    bump();
}

export async function abortMediaSyncNow(): Promise<void> {
    getEngine().abort();
    await abortMediaSync({}, { alertOnError: false }).catch(() => {});
    mediaSyncLog.set(tr.syncMediaAborting());
}

async function showMediaSyncLog(): Promise<void> {
    const result = await openDialog({
        title: tr.syncMediaLogTitle(),
        text: get(mediaSyncLog),
        buttons: [
            { label: tr.syncAbortButton(), value: "abort" },
            { label: tr.actionsClose(), value: "close", primary: true },
        ],
    });
    if (result.button === "abort") {
        await abortMediaSyncNow();
    }
}

// Periodic media sync (desktop's MediaSyncer timer)
//////////////////////////////////////////////////////////////////////////////

let periodicTimer: ReturnType<typeof setInterval> | null = null;

export function periodicMediaSyncMinutes(): number {
    return getProfileConfig<number>("periodicSyncMediaMinutes", 15);
}

/** (Re)starts the timer for the open profile; stopped when minutes is 0. */
export function startPeriodicMediaSync(): void {
    stopPeriodicMediaSync();
    const minutes = periodicMediaSyncMinutes();
    if (minutes > 0) {
        periodicTimer = setInterval(() => void periodicMediaSync(), minutes * 60_000);
    }
}

export function stopPeriodicMediaSync(): void {
    if (periodicTimer) {
        clearInterval(periodicTimer);
        periodicTimer = null;
    }
}

async function periodicMediaSync(): Promise<void> {
    const auth = syncAuth();
    // media syncing occupies the engine, so only start it from the deck list
    if (
        !auth || automaticSuspended || !mediaSyncingEnabled() || syncing || get(syncState).mediaSyncing || !navigator.onLine
        || get(mainState) !== "deckBrowser"
    ) {
        return;
    }
    try {
        await syncMedia(auth, { alertOnError: false });
        startMediaMonitoring();
    } catch (err) {
        console.log("media sync failed:", errorMessage(err));
    }
}

/** Syncs on open/close when enabled (desktop's maybe_auto_sync_on_open_close). */
export async function maybeAutoSync(): Promise<void> {
    if (syncAuth() && autoSyncingEnabled() && navigator.onLine) {
        await syncCollectionAndMedia();
    } else {
        void updateSyncStatus();
    }
}
