<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's import_export/exporting.py; the file is downloaded rather than saved to a chosen path
    import type { DeckNameId } from "@generated/anki/decks_pb";
    import { ExportLimit } from "@generated/anki/import_export_pb";
    import {
        exportAnkiPackage,
        exportCardCsv,
        exportCollectionPackage,
        exportNoteCsv,
        getDeckNames,
        openCollection,
    } from "@generated/backend";
    import * as tr from "@generated/ftl";
    import { onMount } from "svelte";
    import { get } from "svelte/store";

    import { tooltip } from "$web/app/dialogs";
    import { downloadBlob, newExportPath, takeEngineFile } from "$web/app/files";
    import { reset } from "$web/app/main";
    import { currentProfile } from "$web/app/profiles";
    import { runOp } from "$web/app/run";
    import type { WindowHandle } from "$web/app/windows";
    import { profilePaths } from "$web/engine/protocol";

    let {
        win,
        deckId = undefined,
        noteIds = undefined,
        cardIds = undefined,
    }: { win: WindowHandle; deckId?: bigint; noteIds?: bigint[]; cardIds?: bigint[] } = $props();

    type Format = "apkg" | "colpkg" | "notes" | "cards";

    const selection = noteIds ?? cardIds;
    let format = $state<Format>(selection || deckId ? "apkg" : "colpkg");
    let decks = $state.raw<DeckNameId[]>([]);
    /** "" means all decks (or the selection). */
    let deck = $state("");
    let includeSched = $state(!deckId);
    let includeDeckConfigs = $state(false);
    let includeMedia = $state(true);
    let includeTags = $state(true);
    let includeHtml = $state(true);
    let includeDeck = $state(false);
    let includeNotetype = $state(false);
    let includeGuid = $state(false);
    let legacy = $state(false);
    let busy = $state(false);

    const formats: { id: Format; label: string; ext: string }[] = [
        { id: "apkg", label: tr.exportingAnkiDeckPackage(), ext: "apkg" },
        { id: "colpkg", label: tr.exportingAnkiCollectionPackage(), ext: "colpkg" },
        { id: "notes", label: tr.exportingNotesInPlainText(), ext: "txt" },
        { id: "cards", label: tr.exportingCardsInPlainText(), ext: "txt" },
    ];

    const show = $derived({
        deckList: format !== "colpkg",
        sched: format === "apkg",
        deckConfigs: format === "apkg",
        media: format === "apkg" || format === "colpkg",
        legacy: format === "apkg" || format === "colpkg",
        tags: format === "notes",
        html: format === "notes" || format === "cards",
        deck: format === "notes",
        notetype: format === "notes",
        guid: format === "notes",
    });

    onMount(async () => {
        if (!selection) {
            const names = await runOp(() => getDeckNames({ skipEmptyDefault: false, includeFiltered: true }));
            decks = names?.entries ?? [];
            if (deckId) {
                deck = String(deckId);
            }
        }
    });

    function limit(): ExportLimit {
        if (noteIds) {
            return new ExportLimit({ limit: { case: "noteIds", value: { noteIds } } });
        }
        if (cardIds) {
            return new ExportLimit({ limit: { case: "cardIds", value: { cids: cardIds } } });
        }
        if (deck) {
            return new ExportLimit({ limit: { case: "deckId", value: BigInt(deck) } });
        }
        return new ExportLimit({ limit: { case: "wholeCollection", value: {} } });
    }

    function filename(ext: string): string {
        if (show.deckList) {
            const name = deck ? decks.find((d) => String(d.id) === deck)?.name : selection ? tr.exportingSelectedNotes() : tr.exportingAllDecks();
            return `${(name ?? "export").replace(/[\\/?<>:*|"^]/g, "_")}.${ext}`;
        }
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}@${pad(now.getHours())}-${
            pad(now.getMinutes())
        }-${pad(now.getSeconds())}`;
        return `${tr.exportingCollection()}-${stamp}.${ext}`;
    }

    async function exportColpkg(outPath: string): Promise<void> {
        const name = get(currentProfile)!;
        const paths = profilePaths(name);
        try {
            await exportCollectionPackage({ outPath, includeMedia, legacy });
        } finally {
            // the backend closes the collection to export it
            await openCollection({
                collectionPath: paths.collection,
                mediaFolderPath: paths.mediaFolder,
                mediaDbPath: paths.mediaDb,
            }).catch(() => {});
            reset();
        }
    }

    async function doExport(): Promise<void> {
        const fmt = formats.find((f) => f.id === format)!;
        const name = filename(fmt.ext);
        const outPath = newExportPath(name);
        busy = true;
        const message = await runOp(async () => {
            switch (format) {
                case "colpkg":
                    await exportColpkg(outPath);
                    return tr.exportingCollectionExported();
                case "apkg": {
                    const out = await exportAnkiPackage({
                        outPath,
                        limit: limit(),
                        options: {
                            withScheduling: includeSched,
                            withDeckConfigs: includeDeckConfigs,
                            withMedia: includeMedia,
                            legacy,
                        },
                    });
                    return tr.exportingNoteExported({ count: out.val });
                }
                case "notes": {
                    const out = await exportNoteCsv({
                        outPath,
                        limit: limit(),
                        withHtml: includeHtml,
                        withTags: includeTags,
                        withDeck: includeDeck,
                        withNotetype: includeNotetype,
                        withGuid: includeGuid,
                    });
                    return tr.exportingNoteExported({ count: out.val });
                }
                case "cards": {
                    const out = await exportCardCsv({ outPath, limit: limit(), withHtml: includeHtml });
                    return tr.exportingCardExported({ count: out.val });
                }
            }
        }, { progress: true, cancellable: true });
        busy = false;
        if (message === undefined) {
            return;
        }
        const data = await takeEngineFile(outPath);
        downloadBlob(data, name, fmt.ext === "txt" ? "text/plain" : "application/octet-stream");
        tooltip(message);
        win.close();
    }
</script>

<form class="export" onsubmit={(e) => (e.preventDefault(), void doExport())}>
    <label class="row">
        <span>{tr.exportingExportFormat()}</span>
        <select bind:value={format}>
            {#each formats as f (f.id)}
                <option value={f.id}>{f.label} (.{f.ext})</option>
            {/each}
        </select>
    </label>
    {#if show.deckList}
        <label class="row">
            <span>{tr.exportingInclude()}</span>
            <select bind:value={deck} disabled={!!selection}>
                <option value="">{selection ? tr.exportingSelectedNotes() : tr.exportingAllDecks()}</option>
                {#each decks as d (d.id)}
                    <option value={String(d.id)}>{d.name}</option>
                {/each}
            </select>
        </label>
    {/if}
    <div class="options">
        {#if show.sched}
            <label><input type="checkbox" bind:checked={includeSched} /> {tr.exportingIncludeSchedulingInformation()}</label>
        {/if}
        {#if show.deckConfigs}
            <label><input type="checkbox" bind:checked={includeDeckConfigs} /> {tr.exportingIncludeDeckConfigs()}</label>
        {/if}
        {#if show.media}
            <label><input type="checkbox" bind:checked={includeMedia} /> {tr.exportingIncludeMedia()}</label>
        {/if}
        {#if show.html}
            <label><input type="checkbox" bind:checked={includeHtml} /> {tr.exportingIncludeHtmlAndMediaReferences()}</label>
        {/if}
        {#if show.tags}
            <label><input type="checkbox" bind:checked={includeTags} /> {tr.exportingIncludeTags()}</label>
        {/if}
        {#if show.deck}
            <label><input type="checkbox" bind:checked={includeDeck} /> {tr.exportingIncludeDeck()}</label>
        {/if}
        {#if show.notetype}
            <label><input type="checkbox" bind:checked={includeNotetype} /> {tr.exportingIncludeNotetype()}</label>
        {/if}
        {#if show.guid}
            <label><input type="checkbox" bind:checked={includeGuid} /> {tr.exportingIncludeGuid()}</label>
        {/if}
        {#if show.legacy}
            <label><input type="checkbox" bind:checked={legacy} /> {tr.exportingSupportOlderAnkiVersions()}</label>
        {/if}
    </div>
    <footer>
        <span class="spacer"></span>
        <button type="button" class="btn btn-secondary" onclick={() => win.close()}>{tr.actionsCancel()}</button>
        <button type="submit" class="btn btn-primary" disabled={busy}>{tr.exportingExport()}</button>
    </footer>
</form>

<style>
    .export {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 1rem;
    }
    .row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        > span {
            min-width: 7rem;
        }
        select {
            flex: 1;
            min-width: 0;
        }
    }
    .options {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        label {
            display: flex;
            gap: 0.5rem;
            align-items: center;
        }
    }
    footer {
        display: flex;
        gap: 0.5rem;
    }
    .spacer {
        flex: 1;
    }
</style>
