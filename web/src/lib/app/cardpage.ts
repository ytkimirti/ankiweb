// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * The frame side of a card frame (see cardframe.ts): connects the reviewer
 * script to the app that embeds it, using only messages, since the frame
 * usually lives on another origin.
 */

import { version } from "$app/environment";
import { setProtoTransport } from "@generated/post";

import { isCardOrigin } from "../config";
import { type AppMessage, applyThemeClasses, type FrameMessage } from "./card-messages";
import { isEditable, matches } from "./keys";

let hostOrigin = "";
let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
let shortcutKeys: string[] = [];
let theme: { night: boolean; reduceMotion: boolean } | null = null;

function post(message: FrameMessage, transfer: Transferable[] = []): void {
    window.parent.postMessage(message, hostOrigin, transfer);
}

function request(message: { type: "bridge"; cmd: string } | Omit<FrameMessage & { type: "call" }, "id">): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        post({ ...message, id } as FrameMessage);
    });
}

function reply(id: number, value: unknown, error?: string): void {
    try {
        post({ type: "reply", id, value, error });
    } catch {
        post({ type: "reply", id, error: error ?? "result could not be sent" });
    }
}

function applyTheme(): void {
    if (theme) {
        applyThemeClasses(document, theme.night, theme.reduceMotion);
    }
}

/** Images that failed to load, which media sync may yet download. */
const brokenImages = new Set<HTMLImageElement>();

async function onAppMessage(message: AppMessage): Promise<void> {
    switch (message?.type) {
        case "run": {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fn = (window as any)[message.fn];
            try {
                reply(message.id, typeof fn === "function" ? await fn(...message.args) : undefined);
            } catch (err) {
                reply(message.id, undefined, String(err));
            }
            break;
        }
        case "eval":
            try {
                (0, eval)(message.code);
                reply(message.id, undefined);
            } catch (err) {
                reply(message.id, undefined, String(err));
            }
            break;
        case "theme":
            theme = { night: !!message.night, reduceMotion: !!message.reduceMotion };
            applyTheme();
            break;
        case "keys":
            shortcutKeys = Array.isArray(message.keys) ? message.keys.map(String) : [];
            break;
        case "mediaArrived":
            for (const img of [...brokenImages]) {
                brokenImages.delete(img);
                const src = img.getAttribute("src");
                if (img.isConnected && src) {
                    // setting it again loads it again
                    img.setAttribute("src", src);
                }
            }
            break;
        case "reply": {
            const entry = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) {
                entry?.reject(new Error(message.error));
            } else {
                entry?.resolve(message.value);
            }
            break;
        }
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(resolve, ms))]);
}

/**
 * On the card origin, its service worker serves the page offline and fetches
 * media through it. The first load comes from the network with
 * COEP: require-corp (the only value Safari embeds), so once the worker is
 * installed the page reloads to get the worker's headers, which let cards
 * show images from other sites. Returns false if the page is reloading.
 */
async function startServiceWorker(warmOnly: boolean): Promise<boolean> {
    const container = navigator.serviceWorker;
    if (!container || !isCardOrigin()) {
        return true;
    }
    container.addEventListener("message", (event) => {
        const data = event.data as { type?: string; path?: string; range?: string | null } | undefined;
        const port = event.ports[0];
        if (data?.type === "media" && port) {
            post({ type: "media", path: String(data.path), range: data.range ?? null }, [port]);
        }
    });
    container.startMessages();
    if (container.controller) {
        return true;
    }
    // the worker claims open pages when it activates; listen before registering
    // so a quick claim is not missed
    const claimed = new Promise<boolean>((resolve) => {
        container.addEventListener("controllerchange", () => resolve(true), { once: true });
    });
    try {
        await container.register("/service-worker.js", { type: import.meta.env.DEV ? "module" : "classic" });
        const registration = await withTimeout(container.ready, 10_000);
        if (warmOnly || !registration) {
            return true;
        }
        // an active worker does not claim pages loaded around it (a hard reload); ask it to
        registration.active?.postMessage({ type: "claim" });
        const controlled = !!container.controller || (await withTimeout(claimed, 10_000));
        const url = new URL(location.href);
        if (controlled && !url.searchParams.has("sw")) {
            url.searchParams.set("sw", "1");
            location.replace(url);
            return false;
        }
    } catch (err) {
        console.warn("card frame service worker failed", err);
    }
    return true;
}

/**
 * The card origin's worker takes over as soon as it has a new version, so
 * card frames and the app can run different versions. A frame older than
 * the app loads again, once, from a worker that runs the app's version,
 * updating the worker first if need be; a newer one tells the app (in
 * "hello"), which then moves to it when it can. Returns false if the page is
 * reloading.
 */
async function matchAppVersion(wanted: string | null): Promise<boolean> {
    const url = new URL(location.href);
    const container = navigator.serviceWorker;
    const controller = container?.controller;
    if (!wanted || wanted === version || !controller || !isCardOrigin() || url.searchParams.has("updated")) {
        return true;
    }
    // all of it well within the time the app waits for the frame (cardframe.ts)
    const deadline = Date.now() + 12_000;
    let swapped = false;
    let giveUp!: () => void;
    const changed = new Promise<boolean>((resolve) => {
        giveUp = () => resolve(false);
        container.addEventListener("controllerchange", () => resolve(swapped = true), { once: true });
    });
    // the worker may have updated since it served this page
    if ((await workerVersion(controller)) !== wanted && !swapped) {
        try {
            const registration = await container.getRegistration();
            // a bad connection must not hold up the card for long
            await withTimeout(registration?.update().then(() => {}, () => {}) ?? Promise.resolve(), 5000);
            const installing = registration?.installing;
            installing?.addEventListener("statechange", () => installing.state === "redundant" && giveUp());
            // nothing newer, so the app is the one behind
            if (!installing && !registration?.waiting && !swapped) {
                return true;
            }
        } catch (err) {
            console.warn("card frame update check failed", err);
            return true;
        }
        if (!(await withTimeout(changed, Math.max(0, deadline - Date.now())))) {
            return true;
        }
    }
    url.searchParams.set("updated", "1");
    location.replace(url);
    return false;
}

/** The version a service worker runs; undefined from versions that do not say. */
async function workerVersion(worker: ServiceWorker): Promise<string | undefined> {
    const channel = new MessageChannel();
    const reply = new Promise<string | undefined>((resolve) => {
        channel.port1.onmessage = (event) => resolve(String(event.data));
    });
    worker.postMessage({ type: "version" }, [channel.port2]);
    const answer = await withTimeout(reply, 2000);
    channel.port1.close();
    return answer;
}

/** Returns false when the page was opened outside the app. */
export async function connectCardPage(): Promise<boolean> {
    const host = new URLSearchParams(location.search).get("host");
    if (window.parent === window || !host) {
        return false;
    }
    try {
        hostOrigin = new URL(host).origin;
    } catch {
        return false;
    }
    addEventListener("message", (event) => {
        if (event.source === window.parent && event.origin === hostOrigin) {
            void onAppMessage(event.data as AppMessage);
        }
    });
    const params = new URLSearchParams(location.search);
    if (params.has("warm")) {
        // the app loads this once at startup so cards work offline later
        await startServiceWorker(true);
        await new Promise(() => {});
    }
    if (!(await startServiceWorker(false)) || !(await matchAppVersion(params.get("v")))) {
        await new Promise(() => {});
    }

    setProtoTransport(async (method, input, opChangesType) => {
        const output = await request({ type: "call", method, input: input.slice(), opChangesType });
        return new Uint8Array(output as Uint8Array);
    });
    window.bridgeCommand = <T>(cmd: string, callback?: (value: T) => void) => {
        request({ type: "bridge", cmd: String(cmd) }).then(
            (value) => callback?.(value as T),
            (err) => console.error(err),
        );
    };
    // card scripts use pycmd too
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).pycmd = window.bridgeCommand;

    addEventListener("DOMContentLoaded", applyTheme);
    addEventListener("error", (event) => {
        if (event.target instanceof HTMLImageElement) {
            // cards replaced since are no longer worth retrying
            for (const img of brokenImages) {
                if (!img.isConnected) {
                    brokenImages.delete(img);
                }
            }
            brokenImages.add(event.target);
        }
    }, true);
    addEventListener("keydown", (event) => {
        if (event.defaultPrevented) {
            return;
        }
        if (event.key === "Escape") {
            post({ type: "escape" });
            return;
        }
        if (isEditable(event.target)) {
            return;
        }
        if (shortcutKeys.some((spec) => matches(spec, event))) {
            event.preventDefault();
        }
        const { key, code, ctrlKey, metaKey, altKey, shiftKey, repeat } = event;
        post({ type: "key", event: { key, code, ctrlKey, metaKey, altKey, shiftKey, repeat } });
    });
    post({ type: "hello", version });
    return true;
}
