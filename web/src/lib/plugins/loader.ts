// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Loading web-native plugins. A plugin is an ES module whose default export
 * is a Plugin; it is given the PluginApi when the app starts, or when it is
 * installed. Installed plugins are listed in the "plugins" meta setting, by
 * URL, or as "builtin:<id>" for the ones bundled with the app (catalog.ts).
 * See web/README.md.
 */

import * as backend from "@generated/backend";
import * as tr from "@generated/ftl";

import * as actions from "../app/actions";
import { getEngine, registerFrontendMethod } from "../app/backend";
import * as dialogs from "../app/dialogs";
import { refreshEditorPlugins } from "../app/editor-plugins";
import * as main from "../app/main";
import * as menus from "../app/menus";
import { getMeta, setMeta } from "../app/profiles";
import { reviewer } from "../app/reviewer";
import { reapplyShortcuts } from "../app/shortcuts";
import * as windows from "../app/windows";
import { BUILTIN_PREFIX, catalogEntry } from "./catalog";
import { pluginFiles, type PluginFiles } from "./files";
import { hooks } from "./hooks";
import { PluginRegistry, type PluginRecord, type Startable } from "./registry";

/** Desktop's mw.col.db: SQL against the collection. Changes made with it cannot be undone. */
export interface PluginDb {
    all(sql: string, ...args: unknown[]): Promise<unknown[][]>;
    first(sql: string, ...args: unknown[]): Promise<unknown[] | null>;
    scalar(sql: string, ...args: unknown[]): Promise<unknown>;
}

export interface PluginApi {
    /** The hooks; listeners added through here are removed when the plugin is. */
    hooks: typeof hooks;
    /** Typed access to every backend method (@generated/backend). */
    backend: typeof backend;
    db: PluginDb;
    tr: typeof tr;
    dialogs: typeof dialogs;
    windows: typeof windows;
    menus: typeof menus;
    actions: typeof actions;
    main: typeof main;
    reviewer: typeof reviewer;
    registerFrontendMethod: typeof registerFrontendMethod;
    /** Per-plugin settings, kept with the app's settings. */
    getConfig<T>(fallback: T): T;
    setConfig(value: unknown): void;
    /** Shows a Config button for the plugin in Tools > Add-ons (desktop's setConfigAction). */
    setConfigAction(action: () => void | Promise<void>): void;
    /** Adds CSS to the app's page until the plugin is removed. */
    addStyle(css: string): HTMLStyleElement;
    /** Files kept for this plugin, such as images the user picked. */
    files: PluginFiles;
    /** Runs `fn` when the plugin is removed or disabled. */
    onUnload(fn: () => void): void;
    /** Runs the shortcut hooks again, after the plugin changed what they do. */
    reapplyShortcuts(): void;
}

export type Plugin = Startable<PluginApi>;

export interface InstalledPlugin {
    url: string;
    enabled: boolean;
}

/** How long a plugin may take to start, so a stuck one cannot hold up opening the app. */
const SETUP_TIMEOUT_MS = 15_000;

const registry = new PluginRegistry<Plugin, PluginApi>({
    apiFor: (record) => apiFor(record),
    importModule: (url) => importPlugin(url),
    timeoutMs: SETUP_TIMEOUT_MS,
    unloadableByDefault: (key) => key.startsWith(BUILTIN_PREFIX),
});
const loaded = registry.loaded;

export function loadedPlugins(): { name: string; url: string; hasConfig: boolean }[] {
    return [...loaded.values()].map((p) => ({ name: p.name, url: p.key, hasConfig: !!p.configAction }));
}

export function installedPlugins(): InstalledPlugin[] {
    return getMeta<InstalledPlugin[]>("plugins", []);
}

export function setInstalledPlugins(plugins: InstalledPlugin[]): void {
    setMeta("plugins", plugins);
}

/** Hooks whose append() records the listener, so it can be removed with the plugin. */
function trackedHooks(disposers: (() => void)[]): typeof hooks {
    const out: Record<string, unknown> = {};
    for (const [name, hook] of Object.entries(hooks)) {
        out[name] = new Proxy(hook, {
            get(target, prop) {
                if (prop === "append") {
                    return (listener: never) => {
                        const remove = target.append(listener);
                        disposers.push(remove);
                        return remove;
                    };
                }
                const value = Reflect.get(target, prop, target);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
    }
    return out as typeof hooks;
}

/** Ids are bigints in the backend's messages; the DB proxy takes JSON. */
function sqlArgs(args: unknown[]): unknown[] {
    return args.map((arg) => {
        if (typeof arg !== "bigint") {
            return arg;
        }
        if (arg > BigInt(Number.MAX_SAFE_INTEGER) || arg < BigInt(Number.MIN_SAFE_INTEGER)) {
            // rounding it could match a different row
            throw new RangeError(`${arg} is too large to pass to the database`);
        }
        return Number(arg);
    });
}

const db: PluginDb = {
    async all(sql, ...args) {
        return (await getEngine().db({ kind: "query", sql, args: sqlArgs(args), first_row_only: false })) as unknown[][];
    },
    async first(sql, ...args) {
        const rows = (await getEngine().db({ kind: "query", sql, args: sqlArgs(args), first_row_only: true })) as unknown[][];
        return rows[0] ?? null;
    },
    async scalar(sql, ...args) {
        return (await db.first(sql, ...args))?.[0] ?? null;
    },
};

function apiFor(record: PluginRecord): PluginApi {
    const key = `plugin:${record.name}`;
    return {
        hooks: trackedHooks(record.disposers),
        backend,
        db,
        tr,
        dialogs,
        windows,
        menus,
        actions,
        main,
        reviewer,
        registerFrontendMethod,
        getConfig: <T>(fallback: T) => getMeta<T>(key, fallback),
        setConfig: (value) => setMeta(key, value),
        setConfigAction: (action) => {
            record.configAction = action;
        },
        addStyle: (css) => {
            const style = document.createElement("style");
            style.dataset.plugin = record.name;
            style.textContent = css;
            document.head.append(style);
            record.disposers.push(() => style.remove());
            return style;
        },
        files: pluginFiles(record.name),
        onUnload: (fn) => {
            record.disposers.push(fn);
            record.unloadable = true;
        },
        reapplyShortcuts,
    };
}

/** Registers a plugin that is bundled with the app or loaded by other means. */
export function registerPlugin(plugin: Plugin, url = `manual:${plugin.name}`): Promise<void> {
    return registry.register(plugin, url);
}

/**
 * globalThis.ankiweb.registerPlugin: while a plugin module is imported, what
 * it registers is started under its URL like a default export. Otherwise it
 * starts once the plugins starting now have, so it resolves without waiting
 * for that: a setup that waited would never finish.
 */
function registerGlobal(plugin: Plugin, url?: string): Promise<void> {
    if (!registry.capture(plugin)) {
        registerPlugin(plugin, url).catch((err) => console.error(`plugin ${plugin.name} failed to load`, err));
    }
    return Promise.resolve();
}

function importPlugin(url: string): Promise<{ default?: Plugin }> {
    const builtin = url.startsWith(BUILTIN_PREFIX) ? catalogEntry(url.slice(BUILTIN_PREFIX.length)) : null;
    if (url.startsWith(BUILTIN_PREFIX) && !builtin) {
        throw new Error(`no bundled plugin ${url}`);
    }
    return builtin ? builtin.load() : import(/* @vite-ignore */ url);
}

/** Lets the screens, which plugins draw into, show the change. */
function refreshScreens(): void {
    reapplyShortcuts();
    refreshEditorPlugins();
    main.reset();
}

/**
 * Installs and starts a plugin. Throws if it failed to load, in which case it
 * is not installed.
 */
export async function installPlugin(url: string): Promise<void> {
    const list = installedPlugins().filter((p) => p.url !== url);
    await registry.load(url);
    setInstalledPlugins([...list, { url, enabled: true }]);
    refreshScreens();
}

/** Turns a plugin on or off; resolves false if a reload is needed to finish. */
export async function setPluginEnabled(url: string, enabled: boolean): Promise<boolean> {
    // a plugin that fails to start stays off
    const done = enabled ? (await registry.load(url), true) : await registry.unload(url);
    setInstalledPlugins(installedPlugins().map((p) => (p.url === url ? { ...p, enabled } : p)));
    refreshScreens();
    return done;
}

/** Uninstalls a plugin; resolves false if a reload is needed to finish. */
export async function removePlugin(url: string): Promise<boolean> {
    setInstalledPlugins(installedPlugins().filter((p) => p.url !== url));
    const done = await registry.unload(url);
    refreshScreens();
    return done;
}

/** Opens a loaded plugin's settings. */
export async function configurePlugin(url: string): Promise<void> {
    await loaded.get(url)?.configAction?.();
}

export async function loadPlugins(): Promise<void> {
    (globalThis as { ankiweb?: unknown }).ankiweb = { registerPlugin: registerGlobal, hooks };
    for (const entry of installedPlugins()) {
        if (!entry.enabled) {
            continue;
        }
        try {
            await registry.load(entry.url);
        } catch (err) {
            console.error(`plugin ${entry.url} failed to load`, err);
        }
    }
    // the app's shortcuts were set before plugins could change them
    reapplyShortcuts();
}
