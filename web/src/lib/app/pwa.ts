// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** Service worker registration and updates. */

import { dev } from "$app/environment";

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
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve) =>
            navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true })
        );
    }
    sessionStorage.setItem(RELOADED_KEY, "1");
    location.reload();
    return false;
}

function watchForUpdates(registration: ServiceWorkerRegistration, onUpdate: (apply: () => void) => void): void {
    const apply = (worker: ServiceWorker) => () => {
        navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
        worker.postMessage({ type: "skipWaiting" });
    };
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
