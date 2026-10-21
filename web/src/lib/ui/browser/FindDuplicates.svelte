<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's browser/find_duplicates.py
    import { SearchNode } from "@generated/anki/search_pb";
    import { addNoteTags, buildSearchString } from "@generated/backend";
    import * as tr from "@generated/ftl";
    import { onMount } from "svelte";

    import { errorMessage, showWarning, tooltip } from "$web/app/dialogs";
    import { getProfileConfig, setProfileConfig } from "$web/app/profiles";
    import { runOp } from "$web/app/run";
    import type { WindowHandle } from "$web/app/windows";

    import { allFieldNames, type Dupe, findDupes } from "./find-duplicates";

    let { win, searchFor }: { win: WindowHandle; searchFor: (text: string) => void } = $props();

    let fields = $state<string[]>([]);
    let field = $state(getProfileConfig<string>("findDupesFields", ""));
    let search = $state(getProfileConfig<string>("findDupesFind", ""));
    let dupes = $state.raw<Dupe[] | null>(null);
    let busy = $state(false);

    onMount(async () => {
        fields = (await runOp(() => allFieldNames())) ?? [];
        if (!fields.includes(field)) {
            field = fields[0] ?? "";
        }
    });

    async function run(): Promise<void> {
        if (!field) {
            return;
        }
        setProfileConfig("findDupesFields", field);
        setProfileConfig("findDupesFind", search);
        busy = true;
        try {
            dupes = await findDupes(field, search);
        } catch (err) {
            await showWarning(errorMessage(err));
        } finally {
            busy = false;
        }
    }

    async function open(nids: bigint[]): Promise<void> {
        const text = await buildSearchString(new SearchNode({ filter: { case: "nids", value: { ids: nids } } }));
        searchFor(text.val);
    }

    async function tagDuplicates(): Promise<void> {
        if (!dupes?.length) {
            return;
        }
        const noteIds = [...new Set(dupes.flatMap(([, nids]) => nids))];
        const out = await runOp(() => addNoteTags({ noteIds, tags: tr.browsingDuplicate() }));
        if (out) {
            tooltip(tr.browsingNotesUpdated({ count: out.count }));
        }
    }

    const noteTotal = $derived(dupes?.reduce((sum, [, nids]) => sum + nids.length, 0) ?? 0);
</script>

<div class="dupes">
    <form
        class="controls"
        onsubmit={(e) => {
            e.preventDefault();
            void run();
        }}
    >
        <label>
            {tr.browsingSearchIn()}
            <select bind:value={field}>
                {#each fields as name (name)}
                    <option value={name}>{name}</option>
                {/each}
            </select>
        </label>
        <label>
            {tr.browsingOptionalFilter()}
            <input type="search" bind:value={search} />
        </label>
        <div class="buttons">
            {#if dupes?.length}
                <button type="button" class="btn btn-secondary" onclick={() => void tagDuplicates()}>
                    {tr.browsingTagDuplicates()}
                </button>
            {/if}
            <button type="button" class="btn btn-secondary" onclick={() => win.close()}>{tr.actionsClose()}</button>
            <button type="submit" class="btn btn-primary" disabled={busy || !field}>{tr.actionsSearch()}</button>
        </div>
    </form>
    {#if dupes}
        <div class="report">
            <p>
                {tr.browsingFoundAsAcrossBs({
                    part: tr.browsingGroup({ count: dupes.length }),
                    whole: tr.browsingNoteCount({ count: noteTotal }),
                }).replace(/<[^>]+>/g, "")}
            </p>
            <ol>
                {#each dupes as [value, nids] (value)}
                    <li>
                        <a href="#/" onclick={(e) => (e.preventDefault(), void open(nids))}>
                            {tr.browsingNoteCount({ count: nids.length })}
                        </a>: {value}
                    </li>
                {/each}
            </ol>
        </div>
    {/if}
</div>

<style lang="scss">
    .dupes {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 1rem;
        min-height: 0;
        height: 100%;
    }

    .controls {
        display: grid;
        gap: 0.5rem;
        label {
            display: grid;
            grid-template-columns: 9rem 1fr;
            align-items: center;
            gap: 0.5rem;
        }
        select,
        input {
            padding: 0.25rem 0.5rem;
            border: 1px solid var(--border);
            border-radius: var(--border-radius);
            background: var(--canvas-inset);
            color: var(--fg);
        }
    }

    .buttons {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
    }

    .report {
        flex: 1;
        min-height: 0;
        overflow: auto;
        border: 1px solid var(--border-subtle);
        border-radius: var(--border-radius);
        padding: 0.5rem 1rem;
        a {
            color: var(--fg-link);
        }
    }

    @media (max-width: 600px) {
        .controls label {
            grid-template-columns: 1fr;
        }
    }
</style>
