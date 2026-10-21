<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // Tools > Add-ons: web-native plugins are ES modules loaded at startup (see web/README.md)
    import * as tr from "@generated/ftl";
    import * as trq from "@generated/ftl-qt";

    import { askUser, getText, showWarning } from "$web/app/dialogs";
    import type { WindowHandle } from "$web/app/windows";
    import { installedPlugins, loadedPlugins, setInstalledPlugins, type InstalledPlugin } from "$web/plugins/loader";

    let { win }: { win: WindowHandle } = $props();

    let plugins = $state<InstalledPlugin[]>(installedPlugins());
    let changed = $state(false);
    const loaded = loadedPlugins();

    function save(next: InstalledPlugin[]): void {
        plugins = next;
        setInstalledPlugins(next);
        changed = true;
    }

    async function add(): Promise<void> {
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
        const ok = await askUser(trq.addonsImportantAsAddonsAreProgramsDownloaded(), { defaultNo: true });
        if (ok) {
            save([...plugins, { url, enabled: true }]);
        }
    }

    function toggle(index: number): void {
        save(plugins.map((p, i) => (i === index ? { ...p, enabled: !p.enabled } : p)));
    }

    async function remove(index: number): Promise<void> {
        if (await askUser(trq.addonsDeleteTheNumdSelectedAddon({ count: 1 }), { defaultNo: true, danger: true })) {
            save(plugins.filter((_, i) => i !== index));
        }
    }

    function nameFor(url: string): string {
        return loaded.find((p) => p.url === url)?.name ?? url;
    }
</script>

<div class="plugins">
    {#if plugins.length}
        <ul>
            {#each plugins as plugin, i (plugin.url)}
                <li class:disabled={!plugin.enabled}>
                    <label>
                        <input type="checkbox" checked={plugin.enabled} onchange={() => toggle(i)} />
                        <span class="name">{nameFor(plugin.url)}</span>
                    </label>
                    <span class="url">{plugin.url}</span>
                    <button type="button" class="btn btn-sm btn-secondary" onclick={() => void remove(i)}>
                        {tr.actionsDelete()}
                    </button>
                </li>
            {/each}
        </ul>
    {:else}
        <p class="empty">No plugins installed.</p>
    {/if}
    {#if changed}
        <p class="note">{trq.addonsChangesWillTakeEffectWhenAnki()}</p>
    {/if}
    <footer>
        <button type="button" class="btn btn-secondary" onclick={() => void add()}>{trq.addonsInstallAddon()}</button>
        <span class="spacer"></span>
        {#if changed}
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
    ul {
        flex: 1;
        overflow: auto;
        list-style: none;
        margin: 0;
        padding: 0;
    }
    li {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 0.1rem 0.5rem;
        padding: 0.5rem 0;
        border-bottom: 1px solid var(--border-subtle);
        &.disabled .name {
            color: var(--fg-disabled);
        }
    }
    label {
        display: flex;
        gap: 0.5rem;
        align-items: center;
    }
    .url {
        grid-column: 1;
        font-size: 0.85em;
        color: var(--fg-subtle);
        word-break: break-all;
    }
    li button {
        grid-row: 1 / 3;
        grid-column: 2;
        align-self: center;
    }
    .empty {
        flex: 1;
        color: var(--fg-subtle);
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
