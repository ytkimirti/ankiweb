// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** Service worker registration and updates. */

import { dev } from "$app/environment";
import { writable } from "svelte/store";

import { setLoadingStage } from "./loading";

const RELOADED_KEY = "ankiweb-isolation-reload";

/**
 * Registers the service worker. Resolves false when the page is about to
 * reload so the worker can make it cross-origin isolated.
 */
export async function startServiceWorker(onUpdate: (apply: () => void) => void): Promise<boolean> {
    if (!("serviceWorker" in navigator)) {
        return true;
    }
    let registration: ServiceWorkerRegistration;
    try {
        registration = await navigator.serviceWorker.register("/service-worker.js", {
            type: dev ? "module" : "classic",
        });
    } catch (err) {
        console.warn("service worker registration failed", err);
        return true;
    }
    watchForUpdates(registration, onUpdate);
    if (self.crossOriginIsolated) {
        sessionStorage.removeItem(RELOADED_KEY);
        return true;
    }
    // without COOP/COEP from the server, the worker adds them; reload once it controls the page
    if (sessionStorage.getItem(RELOADED_KEY)) {
        return true;
    }
    await whileInstalling(registration, async () => {
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
            await new Promise<void>((resolve) =>
                navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true })
            );
        }
    });
    sessionStorage.setItem(RELOADED_KEY, "1");
    location.reload();
    return false;
}

/**
 * Runs `wait` while the worker installs (downloading the whole app), showing
 * its progress, and fails instead of waiting forever if the install does.
 */
async function whileInstalling(registration: ServiceWorkerRegistration, wait: () => Promise<void>): Promise<void> {
    setLoadingStage("Saving Anki for offline use…");
    let fail!: (err: Error) => void;
    const failed = new Promise<never>((_, reject) => (fail = reject));
    const onMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; loaded?: number; total?: number; message?: string } | undefined;
        if (data?.type === "install-progress") {
            setLoadingStage("Saving Anki for offline use…", data.loaded, data.total);
        } else if (data?.type === "install-failed") {
            fail(new Error(`Anki could not be downloaded (${data.message}). Check your connection, then reload.`));
        }
    };
    const watch = (worker: ServiceWorker | null) =>
        worker?.addEventListener("statechange", () => {
            if (worker.state === "redundant" && !navigator.serviceWorker.controller) {
                fail(new Error("Anki could not be downloaded. Check your connection, then reload."));
            }
        });
    navigator.serviceWorker.addEventListener("message", onMessage);
    watch(registration.installing);
    registration.addEventListener("updatefound", () => watch(registration.installing));
    try {
        await Promise.race([wait(), failed]);
    } finally {
        navigator.serviceWorker.removeEventListener("message", onMessage);
    }
}

/** Hands the page to a waiting worker, reloading once it takes over. */
function activate(worker: ServiceWorker): void {
    navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
    worker.postMessage({ type: "skipWaiting" });
    // in case it never does
    setTimeout(() => location.reload(), 10_000);
}

/**
 * Moves to the new version if one has been downloaded or is downloading, or,
 * with `check`, is found on the server; false if there is none. The page has
 * to: a reload alone stays with the current version's worker, which may no
 * longer find what the page asks the server for, such as the engine's
 * workers in versions that did not cache them.
 */
export async function applyPendingUpdate(check = false): Promise<boolean> {
    const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
    if (!registration || !navigator.serviceWorker.controller) {
        return false;
    }
    if (check) {
        await registration.update().catch(() => {});
    }
    const installing = registration.installing;
    if (installing && !registration.waiting) {
        await whileInstalling(
            registration,
            () =>
                new Promise<void>((resolve) => {
                    const settled = () => installing.state !== "installing" && resolve();
                    installing.addEventListener("statechange", settled);
                    settled();
                }),
        );
    }
    const waiting = registration.waiting;
    if (!waiting) {
        return false;
    }
    activate(waiting);
    return true;
}

/** Reloads the page, on the new version if there is one (see above). */
export async function reloadApp(): Promise<void> {
    if (!(await applyPendingUpdate())) {
        location.reload();
    }
}

function watchForUpdates(registration: ServiceWorkerRegistration, onUpdate: (apply: () => void) => void): void {
    const apply = (worker: ServiceWorker) => () => activate(worker);
    const check = () => {
        // a waiting worker with a controller present means an update, not a first install
        if (registration.waiting && navigator.serviceWorker.controller) {
            onUpdate(apply(registration.waiting));
        }
    };
    check();
    registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        installing?.addEventListener("statechange", () => {
            if (installing.state === "installed") {
                check();
            }
        });
    });
    // look for a new version every hour while the app stays open
    setInterval(() => void registration.update().catch(() => {}), 60 * 60 * 1000);
}

/**
 * Whether the browser keeps Anki's data until the user deletes it: null until
 * asked. Without it the browser may evict the whole site's storage when space
 * runs low, collection, media and backups included.
 */
export const storagePersisted = writable<boolean | null>(null);

export const STORAGE_WARNING = "This browser has not agreed to keep Anki's data, and may delete it when the device runs "
    + "low on space, backups included. Installing Anki as an app makes that less likely. Sync with AnkiWeb, or "
    + "download a backup from File > Revert to Backup now and then, so a copy is kept off this device.";

/** Asks for persistent storage, at startup and after syncs until granted. */
export async function requestPersistentStorage(): Promise<boolean> {
    let granted = false;
    try {
        granted = await navigator.storage.persisted() || await navigator.storage.persist();
    } catch {
        // not supported
    }
    storagePersisted.set(granted);
    return granted;
}
