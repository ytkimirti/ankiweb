<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's fields.py
    import { StockNotetype_Kind } from "@generated/anki/notetypes_pb";
    import { getNotetypeNamesAndCounts, getStockNotetypeLegacy } from "@generated/backend";
    import * as tr from "@generated/ftl";
    import { onMount } from "svelte";

    import { askUser, getText, showWarning, tooltip } from "$web/app/dialogs";
    import { decodeJson64 } from "$web/app/json64";
    import {
        ChangeTracker,
        type FieldDict,
        fieldNameProblem,
        type NotetypeDict,
        saveNotetypeDict,
    } from "$web/app/notetypes";
    import type { WindowHandle } from "$web/app/windows";

    import { FONTS } from "./fonts";

    let {
        win,
        notetype,
        openAt = 0,
        api,
    }: {
        win: WindowHandle;
        notetype: NotetypeDict;
        openAt?: number;
        api: { canClose?: () => Promise<boolean> };
    } = $props();

    // svelte-ignore state_referenced_locally
    const nt = $state(notetype);
    const tracker = new ChangeTracker();
    // svelte-ignore state_referenced_locally
    let current = $state(Math.min(openAt, notetype.flds.length - 1));
    let saving = false;
    let dragFrom: number | null = null;

    const field = $derived(nt.flds[current] as FieldDict | undefined);

    function isSortField(f: FieldDict): boolean {
        return f.ord === null ? nt.sortf === current : nt.sortf === f.ord;
    }

    function markBasic(): void {
        tracker.markBasic();
    }

    async function uniqueName(prompt: string, old = ""): Promise<string | null> {
        const text = (await getText(prompt, { value: old }))?.replace(/"/g, "").trim();
        if (!text) {
            return null;
        }
        const problem = fieldNameProblem(text, nt.flds, old);
        if (problem === "unchanged") {
            return null;
        }
        if (problem) {
            await showWarning(problem);
            return null;
        }
        return text;
    }

    async function onRename(): Promise<void> {
        if (!field) {
            return;
        }
        const name = await uniqueName(tr.actionsNewName(), field.name);
        if (name) {
            markBasic();
            field.name = name;
        }
    }

    async function onAdd(): Promise<void> {
        const name = await uniqueName(tr.fieldsFieldName());
        if (!name || !(await tracker.markSchema())) {
            return;
        }
        const stock = decodeJson64<NotetypeDict>(
            (await getStockNotetypeLegacy({ kind: StockNotetype_Kind.BASIC })).json,
        );
        const newField = { ...stock.flds[0], name, ord: null };
        nt.flds.push(newField);
        current = nt.flds.length - 1;
    }

    async function onDelete(): Promise<void> {
        if (!field) {
            return;
        }
        if (nt.flds.length < 2) {
            await showWarning(tr.fieldsNotesRequireAtLeastOneField());
            return;
        }
        if (field.preventDeletion) {
            await showWarning(tr.fieldsFieldIsRequired());
            return;
        }
        const counts = await getNotetypeNamesAndCounts({});
        const count = counts.entries.find((e) => Number(e.id) === Number(nt.id))?.useCount ?? 0;
        if (!(await askUser(tr.fieldsDeleteFieldFrom({ val: tr.browsingNoteCount({ count }) })))) {
            return;
        }
        if (!(await tracker.markSchema())) {
            return;
        }
        // sortf holds the original ordinal; the backend maps it to the new position
        nt.flds.splice(current, 1);
        current = 0;
    }

    async function onPosition(): Promise<void> {
        const count = nt.flds.length;
        const text = await getText(tr.fieldsNewPosition1({ val: count }), { value: String(current + 1) });
        const pos = Number.parseInt(text ?? "", 10);
        if (!Number.isFinite(pos) || pos < 1 || pos > count) {
            return;
        }
        await moveField(current, pos - 1);
    }

    async function moveField(from: number, to: number): Promise<void> {
        if (from === to || !(await tracker.markSchema())) {
            return;
        }
        const [moved] = nt.flds.splice(from, 1);
        nt.flds.splice(to, 0, moved);
        current = to;
    }

    async function onSortField(): Promise<void> {
        if (!field || isSortField(field) || !(await tracker.markSchema())) {
            return;
        }
        nt.sortf = field.ord ?? current;
    }

    async function save(): Promise<void> {
        if (saving) {
            return;
        }
        saving = true;
        try {
            const out = await saveNotetypeDict(nt, true);
            if (out !== undefined) {
                tracker.setUnchanged();
                tooltip(tr.cardTemplatesChangesSaved());
                win.close();
            }
        } finally {
            saving = false;
        }
    }

    onMount(() => {
        api.canClose = async () => !tracker.changed() || (await askUser(tr.cardTemplatesDiscardChanges()));
        return () => (api.canClose = undefined);
    });

    function onListKey(event: KeyboardEvent): void {
        if (event.key === "ArrowDown" && current < nt.flds.length - 1) {
            current++;
        } else if (event.key === "ArrowUp" && current > 0) {
            current--;
        } else {
            return;
        }
        event.preventDefault();
    }
</script>

<div class="fields">
    <div class="top">
        <ol class="list" role="listbox" tabindex="0" aria-label={tr.notetypesFields()} onkeydown={onListKey}>
            {#each nt.flds as f, i (f)}
                <li
                    role="option"
                    aria-selected={i === current}
                    class:selected={i === current}
                    draggable="true"
                    onclick={() => (current = i)}
                    ondblclick={() => void onRename()}
                    onkeydown={() => {}}
                    ondragstart={() => (dragFrom = i)}
                    ondragover={(e) => e.preventDefault()}
                    ondrop={(e) => {
                        e.preventDefault();
                        if (dragFrom !== null) {
                            void moveField(dragFrom, i);
                        }
                        dragFrom = null;
                    }}
                >
                    {i + 1}: {f.name}
                </li>
            {/each}
        </ol>
        <div class="buttons">
            <button type="button" class="btn btn-secondary" onclick={() => void onAdd()}>{tr.actionsAdd()}</button>
            <button type="button" class="btn btn-secondary" onclick={() => void onDelete()}>{tr.actionsDelete()}</button>
            <button type="button" class="btn btn-secondary" onclick={() => void onRename()}>{tr.actionsRename()}</button>
            <button type="button" class="btn btn-secondary" onclick={() => void onPosition()}>
                {tr.actionsReposition()}
            </button>
        </div>
    </div>

    {#if field}
        <fieldset class="options">
            <legend>{tr.fieldsEditingFont()}</legend>
            <label>
                <span>{tr.fieldsFont()}</span>
                <input class="form-control" list="field-fonts" bind:value={field.font} oninput={markBasic} />
            </label>
            <datalist id="field-fonts">
                {#each FONTS as font (font)}
                    <option value={font}></option>
                {/each}
            </datalist>
            <label>
                <span>{tr.fieldsSize()}</span>
                <input class="form-control" type="number" min="5" max="300" bind:value={field.size} oninput={markBasic} />
            </label>
            <label>
                <span>{tr.fieldsDescription()}</span>
                <input
                    class="form-control"
                    placeholder={tr.fieldsDescriptionPlaceholder()}
                    bind:value={field.description}
                    oninput={markBasic}
                />
            </label>
            <label class="check">
                <input type="radio" checked={isSortField(field)} onclick={() => void onSortField()} />
                {tr.fieldsSortByThisFieldInThe()}
            </label>
            <label class="check">
                <input type="checkbox" bind:checked={field.rtl} onchange={markBasic} />
                {tr.fieldsReverseTextDirectionRtl()}
            </label>
            <label class="check">
                <input type="checkbox" bind:checked={field.plainText} onchange={markBasic} />
                {tr.fieldsHtmlByDefault()}
            </label>
            <label class="check">
                <input type="checkbox" bind:checked={field.collapsed} onchange={markBasic} />
                {tr.fieldsCollapseByDefault()}
            </label>
            <label class="check">
                <input type="checkbox" bind:checked={field.excludeFromSearch} onchange={markBasic} />
                {tr.fieldsExcludeFromSearch()}
            </label>
        </fieldset>
    {/if}

    <div class="footer">
        <button type="button" class="btn btn-secondary" onclick={() => void win.requestClose()}>
            {tr.actionsCancel()}
        </button>
        <button type="button" class="btn btn-primary" onclick={() => void save()}>{tr.actionsSave()}</button>
    </div>
</div>

<style lang="scss">
    .fields {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 1rem;
    }

    .top {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 0.75rem;
    }

    .list {
        list-style: none;
        margin: 0;
        padding: 0;
        min-height: 10rem;
        max-height: 40vh;
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
    }

    .options {
        display: grid;
        gap: 0.5rem;
        border: 1px solid var(--border-subtle);
        border-radius: var(--border-radius);
        padding: 0.75rem;
        legend {
            float: none;
            width: auto;
            font-size: 1em;
            padding: 0 0.3rem;
        }
        label:not(.check) {
            display: grid;
            grid-template-columns: 7rem 1fr;
            align-items: center;
            gap: 0.5rem;
        }
        .check {
            display: flex;
            gap: 0.5rem;
            align-items: center;
        }
    }

    .footer {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
    }

    @media (max-width: 600px) {
        .top {
            grid-template-columns: 1fr;
        }
        .buttons {
            flex-direction: row;
            flex-wrap: wrap;
        }
        .options label:not(.check) {
            grid-template-columns: 1fr;
        }
    }
</style>
