<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's models.py
    import { StockNotetype_Kind } from "@generated/anki/notetypes_pb";
    import type { NotetypeNameIdUseCount } from "@generated/anki/notetypes_pb";
    import { getNotetypeNamesAndCounts, getStockNotetypeLegacy, removeNotetype } from "@generated/backend";
    import * as tr from "@generated/ftl";
    import { onDestroy, onMount } from "svelte";

    import { askUser, chooseFrom, getText, openForm, showInfo } from "$web/app/dialogs";
    import { decodeJson64 } from "$web/app/json64";
    import {
        addNotetypeDict,
        blankNote,
        confirmSchema,
        getNotetypeDict,
        type NotetypeDict,
        openCardLayout,
        openFieldsDialog,
        saveNotetypeDict,
    } from "$web/app/notetypes";
    import { onOpChanges } from "$web/app/ops";
    import { runOp } from "$web/app/run";
    import type { WindowHandle } from "$web/app/windows";

    let {
        win,
        fromMain = true,
        selectedNotetypeId = undefined,
    }: { win: WindowHandle; fromMain?: boolean; selectedNotetypeId?: bigint } = $props();

    let models = $state.raw<NotetypeNameIdUseCount[]>([]);
    let selected = $state<bigint | null>(null);
    let cleanup: (() => void) | null = null;

    const current = $derived(models.find((m) => m.id === selected) ?? null);

    async function refresh(select: bigint | null = selected): Promise<void> {
        const out = await runOp(() => getNotetypeNamesAndCounts({}));
        if (!out) {
            return;
        }
        const index = models.findIndex((m) => m.id === selected);
        models = out.entries;
        selected = models.find((m) => m.id === select)?.id
            ?? models[Math.min(Math.max(index, 0), models.length - 1)]?.id
            ?? null;
    }

    async function onAdd(): Promise<void> {
        const stockKinds = [
            StockNotetype_Kind.BASIC,
            StockNotetype_Kind.BASIC_AND_REVERSED,
            StockNotetype_Kind.BASIC_OPTIONAL_REVERSED,
            StockNotetype_Kind.BASIC_TYPING,
            StockNotetype_Kind.CLOZE,
            StockNotetype_Kind.IMAGE_OCCLUSION,
        ];
        const stock = await Promise.all(
            stockKinds.map(async (kind) => decodeJson64<NotetypeDict>((await getStockNotetypeLegacy({ kind })).json)),
        );
        const existing = [...models].sort((a, b) => a.name.localeCompare(b.name));
        const choice = await chooseFrom(tr.notetypesAddNoteType(), [
            ...stock.map((nt) => tr.notetypesAdd({ val: nt.name })),
            ...existing.map((m) => tr.notetypesClone({ val: m.name })),
        ], { title: tr.notetypesAddNoteType() });
        if (choice === null) {
            return;
        }
        let nt: NotetypeDict;
        if (choice < stock.length) {
            nt = stock[choice];
        } else {
            // clone existing, as models.copy(add=False)
            nt = await getNotetypeDict(existing[choice - stock.length].id);
            nt.name = tr.notetypesCopy({ val: nt.name }).replace(/[\u2068\u2069]/g, "");
            nt.id = 0;
            nt.originalId = null;
        }
        const name = (await getText(tr.actionsName(), { value: nt.name }))?.trim();
        if (!name) {
            return;
        }
        nt.name = name;
        const id = await addNotetypeDict(nt);
        if (id !== undefined) {
            await refresh(id);
        }
    }

    async function onRename(): Promise<void> {
        if (!current) {
            return;
        }
        const nt = await getNotetypeDict(current.id);
        const name = (await getText(tr.actionsNewName(), { value: nt.name }))?.trim();
        if (name) {
            nt.name = name;
            await saveNotetypeDict(nt);
            await refresh(current.id);
        }
    }

    async function onDelete(): Promise<void> {
        if (!current) {
            return;
        }
        if (models.length < 2) {
            await showInfo(tr.notetypesPleaseAddAnotherNoteTypeFirst());
            return;
        }
        const msg = current.useCount
            ? tr.notetypesDeleteThisNoteTypeAndAll()
            : tr.notetypesDeleteThisUnusedNoteType();
        if (!(await askUser(msg)) || !(await confirmSchema())) {
            return;
        }
        await runOp(() => removeNotetype({ ntid: current.id }));
        await refresh(null);
    }

    async function onAdvanced(): Promise<void> {
        if (!current) {
            return;
        }
        const nt = await getNotetypeDict(current.id);
        const values = await openForm(
            [
                {
                    key: "latexsvg",
                    label: tr.notetypesCreateScalableImagesWithDvisvgm(),
                    type: "checkbox",
                    value: !!nt.latexsvg,
                },
                { key: "latexPre", label: tr.notetypesHeader(), type: "textarea", value: nt.latexPre ?? "", rows: 8 },
                { key: "latexPost", label: tr.notetypesFooter(), type: "textarea", value: nt.latexPost ?? "", rows: 3 },
            ],
            { title: tr.actionsOptionsFor({ val: nt.name }), text: tr.editingLatex() },
        );
        if (!values) {
            return;
        }
        nt.latexsvg = !!values.latexsvg;
        nt.latexPre = String(values.latexPre);
        nt.latexPost = String(values.latexPost);
        await saveNotetypeDict(nt);
        await refresh(current.id);
    }

    async function onFields(): Promise<void> {
        if (current) {
            await openFieldsDialog(current.id);
        }
    }

    async function onCards(): Promise<void> {
        if (current) {
            await openCardLayout(await blankNote(current.id), 0, true);
        }
    }

    onMount(() => {
        void refresh(selectedNotetypeId ?? null);
        cleanup = onOpChanges((changes) => {
            if (changes.notetype || changes.note) {
                void refresh();
            }
        });
    });

    onDestroy(() => cleanup?.());

    function onListKey(event: KeyboardEvent): void {
        const index = models.findIndex((m) => m.id === selected);
        if (event.key === "ArrowDown" && index < models.length - 1) {
            selected = models[index + 1].id;
        } else if (event.key === "ArrowUp" && index > 0) {
            selected = models[index - 1].id;
        } else if (event.key === "Enter") {
            void onRename();
        } else {
            return;
        }
        event.preventDefault();
    }
</script>

<div class="notetypes">
    <ul class="list" role="listbox" tabindex="0" aria-label={tr.notetypesNoteTypes()} onkeydown={onListKey}>
        {#each models as model (model.id)}
            <li
                role="option"
                aria-selected={model.id === selected}
                class:selected={model.id === selected}
                onclick={() => (selected = model.id)}
                ondblclick={() => void onRename()}
                onkeydown={() => {}}
            >
                {model.name} [{tr.browsingNoteCount({ count: model.useCount })}]
            </li>
        {/each}
    </ul>
    <div class="buttons">
        <button type="button" class="btn btn-secondary" onclick={() => void onAdd()}>{tr.actionsAdd()}</button>
        <button type="button" class="btn btn-secondary" disabled={!current} onclick={() => void onRename()}>
            {tr.actionsRename()}
        </button>
        <button type="button" class="btn btn-secondary" disabled={!current} onclick={() => void onDelete()}>
            {tr.actionsDelete()}
        </button>
        {#if fromMain}
            <button type="button" class="btn btn-secondary" disabled={!current} onclick={() => void onFields()}>
                {tr.notetypesFields()}
            </button>
            <button type="button" class="btn btn-secondary" disabled={!current} onclick={() => void onCards()}>
                {tr.notetypesCards()}
            </button>
        {/if}
        <button type="button" class="btn btn-secondary" disabled={!current} onclick={() => void onAdvanced()}>
            {tr.notetypesOptions()}
        </button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-primary" onclick={() => win.close()}>{tr.actionsClose()}</button>
    </div>
</div>

<style lang="scss">
    .notetypes {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 0.75rem;
        padding: 1rem;
        height: 100%;
        min-height: 20rem;
    }

    .list {
        list-style: none;
        margin: 0;
        padding: 0;
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: var(--border-radius);
        background: var(--canvas-inset);
        li {
            padding: 0.3rem 0.6rem;
            cursor: default;
            user-select: none;
            &.selected {
                background: color-mix(in srgb, var(--border-focus) 35%, transparent);
            }
        }
    }

    .buttons {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        .spacer {
            flex: 1;
        }
    }

    @media (max-width: 600px) {
        .notetypes {
            grid-template-columns: 1fr;
            grid-template-rows: 1fr auto;
        }
        .buttons {
            flex-direction: row;
            flex-wrap: wrap;
        }
    }
</style>
