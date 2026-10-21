<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's File > Revert to Backup, which picks a file from the backups folder
    import * as tr from "@generated/ftl";
    import * as trq from "@generated/ftl-qt";
    import { onMount } from "svelte";
    import { get } from "svelte/store";

    import { replaceCollection } from "$web/app/actions";
    import { getEngine } from "$web/app/backend";
    import { askUser, showError, showInfo } from "$web/app/dialogs";
    import { downloadBlob, fileToEnginePath, pickFiles } from "$web/app/files";
    import { currentProfile } from "$web/app/profiles";
    import { suspendAutomaticSyncAndBackups } from "$web/app/sync";
    import type { WindowHandle } from "$web/app/windows";
    import { profilePaths } from "$web/engine/protocol";

    let { win }: { win: WindowHandle } = $props();

    let backups = $state<string[]>([]);
    let selected = $state<string | null>(null);
    let busy = $state(false);

    function folder(): string {
        return profilePaths(get(currentProfile)!).backups;
    }

    onMount(async () => {
        const names = await getEngine().listDir(folder());
        backups = names.filter((n) => n.endsWith(".colpkg")).sort().reverse();
        selected = backups[0] ?? null;
    });

    async function restore(path: string, label: string): Promise<void> {
        if (!(await askUser(trq.qtMiscReplaceYourCollectionWithAnEarlier2({ val: label }), { defaultNo: true, danger: true }))) {
            return;
        }
        win.close();
        suspendAutomaticSyncAndBackups();
        if (await replaceCollection(path, { backup: false })) {
            await showInfo(trq.qtMiscAutomaticSyncingAndBackupsHaveBeen());
        }
    }

    async function run(fn: () => Promise<void>): Promise<void> {
        busy = true;
        try {
            await fn();
        } catch (err) {
            await showError(err);
        } finally {
            busy = false;
        }
    }

    function restoreSelected(): Promise<void> {
        return run(async () => {
            if (selected) {
                await restore(`${folder()}/${selected}`, selected);
            }
        });
    }

    function download(): Promise<void> {
        return run(async () => {
            if (selected) {
                const data = await getEngine().readFile(`${folder()}/${selected}`);
                downloadBlob(data, selected);
            }
        });
    }

    function restoreFromFile(): Promise<void> {
        return run(async () => {
            const [file] = await pickFiles({ accept: ".colpkg" });
            if (file) {
                await restore(await fileToEnginePath(file, file.name), file.name);
            }
        });
    }
</script>

<div class="backups">
    <select class="list" size="10" bind:value={selected} ondblclick={() => void restoreSelected()} aria-label={trq.qtMiscRevertToBackup()}>
        {#each backups as name (name)}
            <option value={name}>{name.replace(/^backup-/, "").replace(/\.colpkg$/, "")}</option>
        {/each}
    </select>
    <p class="note">{tr.preferencesMediaIsNotBackedUp()}</p>
    <footer>
        <button type="button" class="btn btn-secondary" disabled={busy} onclick={() => void restoreFromFile()}>
            {tr.decksImportFile()}
        </button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-secondary" disabled={busy || !selected} onclick={() => void download()}>
            {tr.actionsExport()}
        </button>
        <button type="button" class="btn btn-primary" disabled={busy || !selected} onclick={() => void restoreSelected()}>
            {trq.qtMiscRevertToBackup()}
        </button>
    </footer>
</div>

<style>
    .backups {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 1rem;
    }
    .list {
        min-height: 12rem;
        background: var(--canvas-inset);
        color: var(--fg);
        border: 1px solid var(--border);
        border-radius: var(--border-radius);
    }
    .note {
        margin: 0;
        font-size: 0.9em;
        color: var(--fg-subtle);
    }
    footer {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
    }
    .spacer {
        flex: 1;
    }
</style>
