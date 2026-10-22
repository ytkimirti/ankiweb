// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Syncing with AnkiWeb (desktop's sync.py and mediasync.py). The engine talks
 * to AnkiWeb through the same-origin /ankiweb-proxy/, since AnkiWeb does not
 * allow cross-origin requests.
 */

import { BackendError_Kind } from "@generated/anki/backend_pb";
import {
    MediaSyncStatusResponse,
    SyncAuth,
    SyncCollectionResponse_ChangesRequired,
    SyncStatusResponse_Required,
} from "@generated/anki/sync_pb";
import {
    abortMediaSync,
    fullUploadOrDownload,
    syncCollection,
    syncLogin,
    syncMedia,
    syncStatus,
} from "@generated/backend";
import * as tr from "@generated/ftl";
import * as trq from "@generated/ftl-qt";
import { get, writable } from "svelte/store";

import { BackendError } from "../engine/client";
import { hooks } from "../plugins/hooks";
import { getEngine } from "./backend";
import { errorMessage, openDialog, showInfo, showWarning, tooltip } from "./dialogs";
import { mainState, reset } from "./main";
import { mediaArrived } from "./media";
import { describeMediaSync, type MediaSyncStatus, MediaSyncTracker } from "./mediasync";
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

/** The current or last media sync, for the status bar and sync panel. */
export const mediaSyncStatus = writable<MediaSyncStatus | null>(null);

/** What syncing did lately, oldest first (desktop's media sync log). */
export const syncLog = writable<{ time: number; text: string }[]>([]);

/** The sync panel, under the toolbar, is open. */
export const syncPanelOpen = writable(false);

function logSync(text: string): void {
    syncLog.update((log) => [...log.slice(-99), { time: Date.now(), text }]);
}

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
    logSync(errorMessage(err));
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
        syncPanelOpen.update((open) => !open);
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
        // a full sync must go to the new endpoint too; the old one redirects
        // downloads, which the browser follows to a response without its size
        auth.endpoint = out.newEndpoint;
    }
    if (out.serverMessage) {
        await showInfo(out.serverMessage, { html: true });
    }
    if (out.required === SyncCollectionResponse_ChangesRequired.NO_CHANGES) {
        logSync(tr.syncCollectionComplete());
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
    logSync(upload ? "Uploaded the collection to AnkiWeb." : "Downloaded the collection from AnkiWeb.");
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
/** The user (or closing the profile) stopped media sync, so don't resume it. */
let mediaAborted = false;
let checkingMedia = false;
let recheckMedia = false;
let tracker = new MediaSyncTracker();
/** Stages this sync has logged; each is logged once, not after every pause. */
let loggedStages = new Set<string>();

const mediaLabels = () => ({
    starting: tr.syncMediaStarting(),
    complete: tr.syncMediaComplete(),
    aborted: tr.syncMediaAborted(),
});

/** The status bar's line for a media sync. */
export function mediaSyncText(status: MediaSyncStatus): string {
    return describeMediaSync(status, mediaLabels());
}

let mediaArrivedAt = 0;
let mediaArrivedTimer: ReturnType<typeof setTimeout> | null = null;

/** Tells cards at most every 2 seconds, so they do not ask again with every zip. */
function noteMediaArrived(): void {
    if (mediaArrivedTimer) {
        return;
    }
    mediaArrivedTimer = setTimeout(() => {
        mediaArrivedTimer = null;
        mediaArrivedAt = Date.now();
        mediaArrived.update((n) => n + 1);
    }, Math.max(0, mediaArrivedAt + 2000 - Date.now()));
}

function setMediaStatus(status: MediaSyncStatus): void {
    if (status.downloaded > (get(mediaSyncStatus)?.downloaded ?? 0)) {
        noteMediaArrived();
    }
    mediaSyncStatus.set(status);
    const line = mediaSyncText(status);
    mediaSyncLog.set(status.detail && status.active ? `${line}\n${status.detail}` : line);
    // the log keeps each step, not every count, nor each pause for other work
    if (!loggedStages.has(status.stage) && status.stage !== "checking") {
        loggedStages.add(status.stage);
        logSync(
            status.stage === "downloading"
                ? `Media to download: ${status.total.toLocaleString()} files`
                : status.stage === "uploading"
                ? `Media to upload: ${status.toSend.toLocaleString()} files`
                : line,
        );
    }
}

function newTracker(): void {
    tracker = new MediaSyncTracker();
    loggedStages = new Set();
}

/**
 * Media syncing runs in the engine between requests, once the call that
 * started it returns. It gives way to any request the app makes meanwhile
 * (see engine/worker.ts), which interrupts it; it resumes from where it
 * stopped when started again, so we restart it until it finishes.
 */
function startMediaMonitoring(): void {
    if (unlistenMedia) {
        return;
    }
    mediaAborted = false;
    syncState.update((s) => ({ ...s, mediaSyncing: true }));
    newTracker();
    setMediaStatus(tracker.status());
    const engine = getEngine();
    const offProgress = engine.onProgress((progress) => {
        // after an abort the log says so until the sync stops
        if (progress.value.case === "mediaSync" && !mediaAborted) {
            const p = progress.value.value;
            setMediaStatus(tracker.progress(p, `${p.added}, ${p.removed}, ${p.checked}`));
        }
    });
    const offBackground = engine.onBackground(() => void checkMediaSync());
    // a sync can also end inside a request (importing a colpkg aborts it),
    // which posts no "background" message, so look now and then as well
    const poll = setInterval(() => void checkMediaSync(), 5000);
    unlistenMedia = () => {
        offProgress();
        offBackground();
        clearInterval(poll);
    };
    // it may have run before we listened
    void checkMediaSync();
}

function finishMediaSync(stage: "complete" | "aborted" | "failed", error: string | null = null): void {
    unlistenMedia?.();
    unlistenMedia = null;
    syncState.update((s) => ({ ...s, mediaSyncing: false }));
    setMediaStatus(tracker.finish(stage, error));
}

/**
 * One check at a time: the status call takes a finished sync's result, so a
 * second overlapping call would see no sync and think it complete.
 */
async function checkMediaSync(): Promise<void> {
    if (checkingMedia) {
        recheckMedia = true;
        return;
    }
    checkingMedia = true;
    try {
        do {
            recheckMedia = false;
            await checkMediaSyncOnce();
        } while (recheckMedia && unlistenMedia);
    } finally {
        checkingMedia = false;
    }
}

async function checkMediaSyncOnce(): Promise<void> {
    if (!unlistenMedia) {
        return;
    }
    let error: unknown = null;
    try {
        // quiet, so asking does not interrupt the sync it asks about
        const output = await getEngine().callMethod("mediaSyncStatus", new Uint8Array(), { quiet: true });
        if (MediaSyncStatusResponse.fromBinary(output).active) {
            return;
        }
    } catch (err) {
        error = err;
    }
    if (!unlistenMedia) {
        return;
    }
    const interrupted = error instanceof BackendError && error.interrupted;
    if (interrupted && !mediaAborted) {
        setMediaStatus(tracker.pause());
        // let a burst of requests (opening the reviewer, say) finish first, as
        // each would interrupt it again before it got anywhere
        await getEngine().waitIdle(1000);
        if (!unlistenMedia) {
            return;
        }
    }
    const auth = syncAuth();
    if (interrupted && !mediaAborted && auth) {
        // it continues from the last files it recorded, counting from zero
        setMediaStatus(tracker.resume());
        try {
            await syncMedia(auth, { alertOnError: false });
        } catch (err) {
            finishMediaSync("failed", errorMessage(err));
        }
        return;
    }
    if (interrupted) {
        finishMediaSync("aborted");
    } else if (error === null) {
        finishMediaSync("complete");
    } else {
        finishMediaSync("failed", errorMessage(error));
    }
}

/** Stops following media sync and keeps it from resuming (closing the profile). */
export function stopMediaMonitoring(): void {
    mediaAborted = true;
    if (unlistenMedia) {
        finishMediaSync("aborted");
    }
    // the next profile starts afresh
    mediaSyncStatus.set(null);
    syncLog.set([]);
    syncPanelOpen.set(false);
}

/**
 * Waits for media sync to finish, showing its log with an abort button, as
 * desktop does before closing a profile: closing sooner would leave this
 * session's media unsynced.
 */
export async function waitForMediaSync(): Promise<void> {
    if (!get(syncState).mediaSyncing) {
        return;
    }
    const finished = new AbortController();
    const unsubscribe = syncState.subscribe((s) => {
        if (!s.mediaSyncing) {
            finished.abort();
        }
    });
    let aborting = false;
    try {
        // stays up until the sync ends, aborted or not, so nothing else
        // happens meanwhile
        while (!finished.signal.aborted) {
            const result = await openDialog(
                {
                    title: tr.syncMediaLogTitle(),
                    text: get(mediaSyncLog),
                    liveText: mediaSyncLog,
                    dismissable: false,
                    buttons: aborting ? [] : [{ label: tr.syncAbortButton(), value: "abort" }],
                },
                finished.signal,
            );
            if (result.button === "abort" && !aborting) {
                aborting = true;
                void abortMediaSyncNow();
            }
        }
    } finally {
        unsubscribe();
    }
}

export async function abortMediaSyncNow(): Promise<void> {
    mediaAborted = true;
    mediaSyncLog.set(tr.syncMediaAborting());
    logSync(tr.syncMediaAborting());
    getEngine().abort();
    await abortMediaSync({}, { alertOnError: false }).catch(() => {});
}

/** Starts media sync on its own, as the periodic sync does (the status bar's retry). */
export async function startMediaSync(): Promise<void> {
    const auth = syncAuth();
    if (!auth || syncing || get(syncState).mediaSyncing || !mediaSyncingEnabled()) {
        return;
    }
    try {
        await syncMedia(auth, { alertOnError: false });
    } catch (err) {
        newTracker();
        setMediaStatus(tracker.finish("failed", errorMessage(err)));
        return;
    }
    startMediaMonitoring();
}

/** Hides a finished sync's result from the status bar. */
export function dismissMediaSyncStatus(): void {
    const status = get(mediaSyncStatus);
    if (status && !status.active) {
        mediaSyncStatus.set(null);
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
    await startMediaSync();
}

/** Syncs on open/close when enabled (desktop's maybe_auto_sync_on_open_close). */
export async function maybeAutoSync(): Promise<void> {
    if (syncAuth() && autoSyncingEnabled() && navigator.onLine) {
        await syncCollectionAndMedia();
    } else {
        void updateSyncStatus();
    }
}
