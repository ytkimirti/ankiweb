// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Loading web-native plugins. A plugin is an ES module whose default export
 * is a Plugin; it is given the PluginApi when the app starts. Installed
 * plugins are listed in the "plugins" meta setting. See web/README.md.
 */

import * as backend from "@generated/backend";
import * as tr from "@generated/ftl";

import * as actions from "../app/actions";
import * as dialogs from "../app/dialogs";
import { getMeta, setMeta } from "../app/profiles";
import { registerFrontendMethod } from "../app/backend";
import * as main from "../app/main";
import * as menus from "../app/menus";
import * as windows from "../app/windows";
import { reviewer } from "../app/reviewer";
import { hooks } from "./hooks";

export interface PluginApi {
    hooks: typeof hooks;
    /** Typed access to every backend method (@generated/backend). */
    backend: typeof backend;
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
}

export interface Plugin {
    name: string;
    setup(api: PluginApi): void | Promise<void>;
}

export interface InstalledPlugin {
    url: string;
    enabled: boolean;
}

const loaded: { name: string; url: string }[] = [];

export function loadedPlugins(): { name: string; url: string }[] {
    return [...loaded];
}

export function installedPlugins(): InstalledPlugin[] {
    return getMeta<InstalledPlugin[]>("plugins", []);
}

export function setInstalledPlugins(plugins: InstalledPlugin[]): void {
    setMeta("plugins", plugins);
}

function apiFor(name: string): PluginApi {
    const key = `plugin:${name}`;
    return {
        hooks,
        backend,
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
    };
}

/** Registers a plugin that is bundled with the app or loaded by other means. */
export async function registerPlugin(plugin: Plugin, url = "builtin"): Promise<void> {
    await plugin.setup(apiFor(plugin.name));
    loaded.push({ name: plugin.name, url });
}

export async function loadPlugins(): Promise<void> {
    (globalThis as { ankiweb?: unknown }).ankiweb = { registerPlugin, hooks };
    for (const entry of installedPlugins()) {
        if (!entry.enabled) {
            continue;
        }
        try {
            const module = await import(/* @vite-ignore */ entry.url);
            const plugin = module.default as Plugin | undefined;
            if (plugin?.setup) {
                await registerPlugin(plugin, entry.url);
            }
        } catch (err) {
            console.error(`plugin ${entry.url} failed to load`, err);
        }
    }
}
