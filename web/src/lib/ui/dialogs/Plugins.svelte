<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // Tools > Add-ons: the bundled plugins, and web-native plugins installed by
    // URL; both are ES modules started when installed (see web/README.md)
    import * as tr from "@generated/ftl";
    import * as trq from "@generated/ftl-qt";

    import { askUser, errorMessage, getText, showWarning } from "$web/app/dialogs";
    import type { WindowHandle } from "$web/app/windows";
    import { BUILTIN_PREFIX, catalog, type CatalogEntry } from "$web/plugins/catalog";
    import {
        configurePlugin,
        installedPlugins,
        installPlugin,
        loadedPlugins,
        removePlugin,
        setPluginEnabled,
        type InstalledPlugin,
    } from "$web/plugins/loader";

    let { win }: { win: WindowHandle } = $props();

    let plugins = $state<InstalledPlugin[]>(installedPlugins());
    let loaded = $state(loadedPlugins());
    let needsReload = $state(false);
    let busy = $state<string | null>(null);

    const fromUrl = $derived(plugins.filter((p) => !p.url.startsWith(BUILTIN_PREFIX)));

    function refresh(): void {
        plugins = installedPlugins();
        loaded = loadedPlugins();
    }

    function urlOf(entry: CatalogEntry): string {
        return BUILTIN_PREFIX + entry.id;
    }

    async function run(url: string, fn: () => Promise<boolean | void> | boolean | void): Promise<void> {
        busy = url;
        try {
            if ((await fn()) === false) {
                needsReload = true;
            }
        } catch (err) {
            await showWarning(`The add-on could not be started: ${errorMessage(err)}`);
        } finally {
            busy = null;
            refresh();
        }
    }

    async function configure(url: string): Promise<void> {
        try {
            await configurePlugin(url);
        } catch (err) {
            await showWarning(`The add-on's settings could not be saved: ${errorMessage(err)}`);
        }
    }

    async function addFromUrl(): Promise<void> {
        const url = (await getText("Plugin module URL", { placeholder: "https://example.com/plugin.js" }))?.trim();
        if (!url) {
            return;
        }
        try {
            new URL(url, location.href);
        } catch {
            await showWarning("Invalid URL.");
            return;
        }
        if (plugins.some((p) => p.url === url)) {
            return;
        }
        if (await askUser(trq.addonsImportantAsAddonsAreProgramsDownloaded(), { defaultNo: true })) {
            await run(url, () => installPlugin(url));
        }
    }

    function toggle(url: string, enabled: boolean): void {
        void run(url, () => setPluginEnabled(url, enabled));
    }

    async function remove(url: string): Promise<void> {
        if (await askUser(trq.addonsDeleteTheNumdSelectedAddon({ count: 1 }), { defaultNo: true, danger: true })) {
            await run(url, () => removePlugin(url));
        }
    }

    function installed(url: string): InstalledPlugin | undefined {
        return plugins.find((p) => p.url === url);
    }

    function hasConfig(url: string): boolean {
        return loaded.some((p) => p.url === url && p.hasConfig);
    }

    function nameFor(url: string): string {
        return loaded.find((p) => p.url === url)?.name ?? url;
    }
</script>

<div class="plugins">
    <div class="lists">
        <ul>
            {#each catalog as entry (entry.id)}
                {@const url = urlOf(entry)}
                {@const plugin = installed(url)}
                <li class:disabled={plugin && !plugin.enabled}>
                    <div class="info">
                        <label class="name">
                            {#if plugin}
                                <input
                                    type="checkbox"
                                    title={trq.addonsToggleEnabled()}
                                    checked={plugin.enabled}
                                    disabled={busy !== null}
                                    onchange={() => toggle(url, !plugin.enabled)}
                                />
                            {/if}
                            {entry.name}
                        </label>
                        <span class="description">{entry.description}</span>
                    </div>
                    <div class="buttons">
                        {#if plugin}
                            {#if hasConfig(url)}
                                <button type="button" class="btn btn-sm btn-secondary" onclick={() => void configure(url)}>
                                    {trq.addonsConfig()}
                                </button>
                            {/if}
                            <button
                                type="button"
                                class="btn btn-sm btn-secondary"
                                disabled={busy !== null}
                                onclick={() => void remove(url)}
                            >
                                Remove
                            </button>
                        {:else}
                            <button
                                type="button"
                                class="btn btn-sm btn-primary"
                                disabled={busy !== null}
                                onclick={() => void run(url, () => installPlugin(url))}
                            >
                                {busy === url ? trq.addonsChecking() : "Install"}
                            </button>
                        {/if}
                    </div>
                </li>
            {/each}
        </ul>
        {#if fromUrl.length}
            <h4>Installed from URL</h4>
            <ul>
                {#each fromUrl as plugin (plugin.url)}
                    <li class:disabled={!plugin.enabled}>
                        <div class="info">
                            <label class="name">
                                <input
                                    type="checkbox"
                                    title={trq.addonsToggleEnabled()}
                                    checked={plugin.enabled}
                                    disabled={busy !== null}
                                    onchange={() => toggle(plugin.url, !plugin.enabled)}
                                />
                                {nameFor(plugin.url)}
                            </label>
                            <span class="description url">{plugin.url}</span>
                        </div>
                        <div class="buttons">
                            {#if hasConfig(plugin.url)}
                                <button
                                    type="button"
                                    class="btn btn-sm btn-secondary"
                                    onclick={() => void configure(plugin.url)}
                                >
                                    {trq.addonsConfig()}
                                </button>
                            {/if}
                            <button
                                type="button"
                                class="btn btn-sm btn-secondary"
                                disabled={busy !== null}
                                onclick={() => void remove(plugin.url)}
                            >
                                {tr.actionsDelete()}
                            </button>
                        </div>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
    {#if needsReload}
        <p class="note">{trq.addonsChangesWillTakeEffectWhenAnki()}</p>
    {/if}
    <footer>
        <button type="button" class="btn btn-secondary" disabled={busy !== null} onclick={() => void addFromUrl()}>
            Install from URL…
        </button>
        <span class="spacer"></span>
        {#if needsReload}
            <button type="button" class="btn btn-secondary" onclick={() => location.reload()}>Reload</button>
        {/if}
        <button type="button" class="btn btn-primary" onclick={() => win.close()}>{tr.actionsClose()}</button>
    </footer>
</div>

<style>
    .plugins {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        padding: 0.75rem 1rem;
        gap: 0.75rem;
    }
    .lists {
        flex: 1;
        overflow: auto;
    }
    ul {
        list-style: none;
        margin: 0;
        padding: 0;
    }
    h4 {
        margin: 1rem 0 0;
        font-size: 1em;
    }
    li {
        display: flex;
        gap: 0.75rem;
        align-items: center;
        padding: 0.5rem 0;
        border-bottom: 1px solid var(--border-subtle);
        &.disabled .name {
            color: var(--fg-disabled);
        }
    }
    .info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
    }
    .name {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        font-weight: 600;
    }
    .description {
        font-size: 0.85em;
        color: var(--fg-subtle);
    }
    .url {
        word-break: break-all;
    }
    .buttons {
        display: flex;
        gap: 0.4rem;
        flex-shrink: 0;
    }
    .note {
        margin: 0;
        color: var(--fg-subtle);
    }
    footer {
        display: flex;
        gap: 0.5rem;
    }
    .spacer {
        flex: 1;
    }
</style>
