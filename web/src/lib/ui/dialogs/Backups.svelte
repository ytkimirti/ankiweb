<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's File > Revert to Backup, which picks a file from the backups
    // folder, and the profile manager's Open Backup for a closed profile
    import * as tr from "@generated/ftl";
    import * as trq from "@generated/ftl-qt";
    import { onMount } from "svelte";
    import { get } from "svelte/store";

    import { replaceCollection } from "$web/app/actions";
    import { getEngine } from "$web/app/backend";
    import { restoreClosedProfile } from "$web/app/boot";
    import { askUser, showError, showInfo } from "$web/app/dialogs";
    import { downloadBlob, fileToEnginePath, opfsFile, pickFiles } from "$web/app/files";
    import { currentProfile } from "$web/app/profiles";
    import type { WindowHandle } from "$web/app/windows";
    import { OPFS, profilePaths, VFS } from "$web/engine/protocol";

    let { win, profile = undefined }: { win: WindowHandle; profile?: string } = $props();

    const name = profile ?? get(currentProfile)!;
    /** The backups are listed and downloaded from OPFS, so the profile need not be open. */
    const opfsFolder = [OPFS.profiles, name, "backups"];

    let backups = $state<string[]>([]);
    let selected = $state<string | null>(null);
    let busy = $state(false);

    const isOpen = () => get(currentProfile) === name;

    onMount(async () => {
        const names: string[] = [];
        try {
            let dir = await navigator.storage.getDirectory();
            for (const part of opfsFolder) {
                dir = await dir.getDirectoryHandle(part);
            }
            for await (const [entry, handle] of dir.entries()) {
                if (handle.kind === "file" && entry.endsWith(".colpkg")) {
                    names.push(entry);
                }
            }
        } catch (err) {
            if ((err as DOMException)?.name !== "NotFoundError") {
                await showError(err);
            }
        }
        backups = names.sort().reverse();
        selected = backups[0] ?? null;
    });

    async function restore(path: string, label: string, copy: boolean): Promise<void> {
        if (!(await askUser(trq.qtMiscReplaceYourCollectionWithAnEarlier2({ val: label }), { defaultNo: true, danger: true }))) {
            return;
        }
        win.close();
        if (!isOpen()) {
            // nothing is open to back up first, so the file can be used where it is
            await restoreClosedProfile(name, path);
            return;
        }
        // restoring backs up first, which can thin out the backup being restored
        let from = path;
        if (copy) {
            from = `${VFS.exports}/restore-${label}`;
            await getEngine().copyFile(path, from);
        }
        try {
            if (await replaceCollection(from, { restoring: true })) {
                await showInfo(trq.qtMiscAutomaticSyncingAndBackupsHaveBeen());
            }
        } finally {
            if (copy) {
                await getEngine().removeFile(from).catch(() => {});
            }
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
                await restore(`${profilePaths(name).backups}/${selected}`, selected, true);
            }
        });
    }

    function download(): Promise<void> {
        return run(async () => {
            if (selected) {
                downloadBlob(await opfsFile([...opfsFolder, selected]), selected);
            }
        });
    }

    function restoreFromFile(): Promise<void> {
        return run(async () => {
            const [file] = await pickFiles({ accept: ".colpkg" });
            if (file) {
                await restore(await fileToEnginePath(file, file.name), file.name, false);
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
