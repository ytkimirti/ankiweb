<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's clayout.py
    import type { AVTag } from "@generated/anki/card_rendering_pb";
    import type { Note } from "@generated/anki/notes_pb";
    import { StockNotetype_Kind } from "@generated/anki/notetypes_pb";
    import {
        clozeNumbersInNote,
        compareAnswer,
        extractAvTags,
        getDeck,
        getNotetypeNamesAndCounts,
        getStockNotetypeLegacy,
        renderUncommittedCardLegacy,
        restoreNotetypeToStock,
    } from "@generated/backend";
    import * as tr from "@generated/ftl";
    import * as trq from "@generated/ftl-qt";
    import { withCollapsedWhitespace } from "@tslib/i18n";
    import { onDestroy, onMount } from "svelte";
    import { get } from "svelte/store";

    import { getEngine } from "$web/app/backend";
    import { addNormalDeck } from "$web/app/decks";
    import { askUser, chooseFrom, getText, openDialog, openForm, showInfo, tooltip } from "$web/app/dialogs";
    import { attachFrame } from "$web/app/host";
    import { decodeJson64, encodeJson64 } from "$web/app/json64";
    import { popupMenu, type MenuEntry } from "$web/app/menus";
    import {
        ChangeTracker,
        fieldsOnTemplate,
        MODEL_CLOZE,
        type NotetypeDict,
        saveNotetypeDict,
        type TemplateDict,
    } from "$web/app/notetypes";
    import { runOp } from "$web/app/run";
    import { applyCustomFilters, cardBodyClass, loadReviewerSettings, prepareCardText } from "$web/app/reviewer";
    import { avPlayer } from "$web/app/sound";
    import { windows, type WindowHandle } from "$web/app/windows";
    import { hooks, type CardContext } from "$web/plugins/hooks";

    let {
        win,
        note,
        notetype,
        ord: initialOrd = 0,
        fillEmpty: initialFillEmpty = false,
        api,
    }: {
        win: WindowHandle;
        note: Note;
        notetype: NotetypeDict;
        ord?: number;
        fillEmpty?: boolean;
        api: { canClose?: () => Promise<boolean> };
    } = $props();

    // svelte-ignore state_referenced_locally
    const nt = $state(notetype);
    const tracker = new ChangeTracker();
    const isCloze = nt.type === MODEL_CLOZE;

    // svelte-ignore state_referenced_locally
    let ord = $state(isCloze ? initialOrd : Math.min(initialOrd, notetype.tmpls.length - 1));
    let editorIndex = $state<0 | 1 | 2>(0);
    let previewFront = $state(true);
    // svelte-ignore state_referenced_locally
    let fillEmpty = $state(initialFillEmpty);
    let nightMode = $state(document.documentElement.classList.contains("night-mode"));
    let mobile = $state(false);
    let clozeNumbers = $state<number[]>([]);
    let useCount = $state(0);
    let search = $state("");
    let textarea: HTMLTextAreaElement | undefined = $state();
    let iframe: HTMLIFrameElement | undefined = $state();
    let frame: (Window & Record<string, any>) | null = null;
    let markReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => (markReady = resolve));
    let haveAutoplayed = false;
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    let renderGeneration = 0;
    let tags: AVTag[] = [];
    const cleanups: (() => void)[] = [];

    const template = $derived((isCloze ? nt.tmpls[0] : nt.tmpls[ord]) as TemplateDict);
    const editorText = $derived(editorIndex === 0 ? template.qfmt : editorIndex === 1 ? template.afmt : nt.css);
    const noteHasEmptyField = note.fields.some((f) => !f.trim());

    function summarizedName(index: number, tmpl: TemplateDict): string {
        return `${index + 1}: ${tmpl.name}: ${fieldsOnTemplate(tmpl.qfmt)} -> ${fieldsOnTemplate(tmpl.afmt)}`;
    }

    // Editing
    ////////////////////////////////////////////////////////////////////////

    function onEdit(event: Event): void {
        const text = (event.currentTarget as HTMLTextAreaElement).value;
        tracker.markBasic();
        if (editorIndex === 0) {
            template.qfmt = text;
        } else if (editorIndex === 1) {
            template.afmt = text;
        } else {
            nt.css = text;
        }
        scheduleRender();
    }

    function onEditorKey(event: KeyboardEvent): void {
        // tab inserts a tab, as in desktop's plain text editor
        if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
            event.preventDefault();
            const el = event.currentTarget as HTMLTextAreaElement;
            el.setRangeText("\t", el.selectionStart, el.selectionEnd, "end");
            el.dispatchEvent(new Event("input"));
        }
    }

    function setEditor(index: 0 | 1 | 2): void {
        editorIndex = index;
        if (index === 0 && !previewFront) {
            previewFront = true;
            redraw();
        } else if (index === 1 && previewFront) {
            previewFront = false;
            redraw();
        }
    }

    function onSearch(next = false): void {
        if (!textarea || !search) {
            return;
        }
        const text = textarea.value;
        const from = next ? textarea.selectionEnd : textarea.selectionStart;
        let index = text.indexOf(search, from);
        if (index < 0) {
            index = text.indexOf(search);
        }
        if (index < 0) {
            tooltip("No matches found.");
            return;
        }
        textarea.focus();
        textarea.setSelectionRange(index, index + search.length);
        if (next) {
            const lines = text.slice(0, index).split("\n").length;
            textarea.scrollTop = Math.max(0, (lines - 3) * parseFloat(getComputedStyle(textarea).lineHeight || "18"));
        }
    }

    function changeOrd(next: number): void {
        ord = next;
        haveAutoplayed = false;
        redraw();
    }

    // Preview
    ////////////////////////////////////////////////////////////////////////

    function scheduleRender(): void {
        if (renderTimer) {
            clearTimeout(renderTimer);
        }
        renderTimer = setTimeout(() => void renderPreview(), 200);
    }

    function redraw(): void {
        if (renderTimer) {
            clearTimeout(renderTimer);
        }
        void renderPreview();
    }

    function bodyClass(): string {
        const classes = cardBodyClass(ord).split(" ").filter((c) => c !== "nightMode" && c !== "night_mode");
        if (nightMode) {
            classes.push("nightMode", "night_mode");
        }
        return classes.join(" ");
    }

    async function maybeTextInput(text: string, side: "q" | "a"): Promise<string> {
        if (!text.includes("[[type:")) {
            return text;
        }
        const origLen = text.length;
        text = text.replace("<hr id=answer>", "");
        const hadHr = origLen !== text.length;
        const re = /\[\[type:.+?\]\]/;
        let repl: string;
        if (side === "q") {
            repl = "<center><input id='typeans' type=text value='example' readonly='readonly'></center>";
        } else {
            const res = (await compareAnswer({ expected: "example", provided: "sample", combining: true, ignoreCase: false })).val;
            repl = hadHr ? `<hr id=answer>${res}` : res;
        }
        const out = text.replace(re, () => repl);
        const warning = `<center><b>${tr.cardTemplatesTypeBoxesWarning()}</b></center>`;
        return out.replace(/\[\[type:.+?\]\]/g, warning);
    }

    async function renderPreview(): Promise<void> {
        renderTimer = null;
        const generation = ++renderGeneration;
        const output = await renderUncommittedCardLegacy({
            note,
            cardOrd: ord,
            template: encodeJson64(template),
            fillEmpty: fillEmpty,
            partialRender: true,
        }).catch((err: unknown) => {
            console.warn("render failed", err);
            return null;
        });
        if (!output || generation !== renderGeneration) {
            return;
        }
        const context: CardContext = {
            cardId: 0n,
            noteId: note.id,
            ord,
            fields: Object.fromEntries(nt.flds.map((f, i) => [f.name, note.fields[i] ?? ""])),
            questionSide: true,
        };
        // split so svelte does not read it as the component's style block
        const css = `<${"style"}>${nt.css}</${"style"}>`;
        const q = await extractAvTags({
            text: applyCustomFilters(output.questionNodes, context, null),
            questionSide: true,
        });
        let text: string;
        if (previewFront) {
            text = await maybeTextInput(await prepareCardText(css + q.text), "q");
            text = hooks.cardWillShow.run(text, context, "clayoutQuestion");
            tags = q.avTags;
        } else {
            const answerContext = { ...context, questionSide: false };
            const a = await extractAvTags({
                text: applyCustomFilters(output.answerNodes, answerContext, q.text),
                questionSide: false,
            });
            text = await maybeTextInput(await prepareCardText(css + a.text), "a");
            text = hooks.cardWillShow.run(text, answerContext, "clayoutAnswer");
            tags = a.avTags;
        }
        await ready;
        if (generation !== renderGeneration) {
            return;
        }
        frame?._showAnswer?.(text, bodyClass());
        frame?._emulateMobile?.(mobile);
        if (!haveAutoplayed) {
            haveAutoplayed = true;
            avPlayer.playTags(tags);
        }
    }

    function previewSettings(event: MouseEvent): void {
        const items: MenuEntry[] = [];
        if (noteHasEmptyField) {
            items.push({
                label: tr.cardTemplatesFillEmpty(),
                checked: fillEmpty,
                action: () => {
                    fillEmpty = !fillEmpty;
                    haveAutoplayed = false;
                    redraw();
                },
            });
        }
        items.push(
            {
                label: tr.cardTemplatesNightMode(),
                checked: nightMode,
                action: () => {
                    nightMode = !nightMode;
                    frame?.document.documentElement.classList.toggle("night-mode", nightMode);
                    haveAutoplayed = false;
                    redraw();
                },
            },
            {
                label: tr.cardTemplatesAddMobileClass(),
                checked: mobile,
                action: () => {
                    mobile = !mobile;
                    haveAutoplayed = false;
                    redraw();
                },
            },
        );
        popupMenu(items, event.currentTarget as Element);
    }

    function playClicked(cmd: string): void {
        const tag = tags[Number(cmd.split(":")[2])];
        if (tag) {
            avPlayer.playTags([tag]);
        }
    }

    // Card types
    ////////////////////////////////////////////////////////////////////////

    async function templateUseCount(tmpl: TemplateDict): Promise<number> {
        if (tmpl.ord === null || tmpl.ord === undefined) {
            return 0;
        }
        const rows = (await getEngine().db({
            kind: "query",
            sql: "select count() from cards, notes where cards.nid = notes.id and notes.mid = ? and cards.ord = ?",
            args: [nt.id, tmpl.ord],
            first_row_only: true,
        })) as number[][] | null;
        return Number(rows?.[0]?.[0] ?? 0);
    }

    async function onRemove(): Promise<void> {
        if (nt.tmpls.length < 2) {
            await showInfo(tr.cardTemplatesAtLeastOneCardTypeIs());
            return;
        }
        const tmpl = template;
        const count = await templateUseCount(tmpl);
        const msg = tr.cardTemplatesDeleteTheAsCardTypeAnd({
            template: tmpl.name,
            // desktop passes the formatted count, not the number
            cards: tr.cardTemplatesCardCount({ count }) as unknown as number,
        });
        if (!(await askUser(msg)) || !(await tracker.markSchema())) {
            return;
        }
        nt.tmpls.splice(nt.tmpls.indexOf(tmpl), 1);
        changeOrd(Math.min(ord, nt.tmpls.length - 1));
    }

    async function onRename(): Promise<void> {
        const tmpl = template;
        const name = (await getText(tr.actionsNewName(), { value: tmpl.name }))?.replace(/"/g, "");
        if (!name?.trim()) {
            return;
        }
        tracker.markBasic();
        tmpl.name = name;
        redraw();
    }

    async function onReorder(): Promise<void> {
        const count = nt.tmpls.length;
        const currentPos = ord + 1;
        const text = await getText(tr.cardTemplatesEnterNewCardPosition1({ val: count }), {
            value: String(currentPos),
        });
        const pos = Number.parseInt(text ?? "", 10);
        if (!Number.isFinite(pos) || pos < 1 || pos > count || pos === currentPos) {
            return;
        }
        if (!(await tracker.markSchema())) {
            return;
        }
        const [moved] = nt.tmpls.splice(ord, 1);
        nt.tmpls.splice(pos - 1, 0, moved);
        changeOrd(pos - 1);
    }

    function newCardName(): string {
        let n = nt.tmpls.length + 1;
        for (;;) {
            const name = tr.cardTemplatesCard({ val: n }).replace(/[⁨⁩]/g, "");
            if (!nt.tmpls.some((t) => t.name === name)) {
                return name;
            }
            n++;
        }
    }

    async function onAddCard(): Promise<void> {
        const count = useCount;
        if (count && !(await askUser(tr.cardTemplatesThisWillCreateCardProceed({ count })))) {
            return;
        }
        if (!(await tracker.markSchema())) {
            return;
        }
        const stock = decodeJson64<NotetypeDict>(
            (await getStockNotetypeLegacy({ kind: StockNotetype_Kind.BASIC })).json,
        );
        const old = template;
        nt.tmpls.push({ ...stock.tmpls[0], name: newCardName(), ord: null, qfmt: old.qfmt, afmt: old.afmt });
        changeOrd(nt.tmpls.length - 1);
    }

    async function onRestoreToDefault(forceKind?: StockNotetype_Kind): Promise<void> {
        if (forceKind === undefined && !nt.originalStockKind) {
            const kinds = [
                StockNotetype_Kind.BASIC,
                StockNotetype_Kind.BASIC_AND_REVERSED,
                StockNotetype_Kind.BASIC_OPTIONAL_REVERSED,
                StockNotetype_Kind.BASIC_TYPING,
                StockNotetype_Kind.CLOZE,
                StockNotetype_Kind.IMAGE_OCCLUSION,
            ];
            const names = await Promise.all(
                kinds.map(async (kind) => decodeJson64<NotetypeDict>((await getStockNotetypeLegacy({ kind })).json).name),
            );
            const choice = await chooseFrom("", names, { title: "Anki" });
            if (choice !== null) {
                await onRestoreToDefault(kinds[choice]);
            }
            return;
        }
        if (
            !(await askUser(withCollapsedWhitespace(tr.cardTemplatesRestoreToDefaultConfirmation()), {
                defaultNo: true,
            }))
        ) {
            return;
        }
        const out = await runOp(() =>
            restoreNotetypeToStock({ notetypeId: { ntid: BigInt(nt.id) }, forceKind })
        );
        if (out !== undefined) {
            tracker.setUnchanged();
            win.close();
            await showInfo(tr.cardTemplatesRestoredToDefault());
        }
    }

    function onFlip(): void {
        const tmpl = template;
        const match = /^([\s\S]+)<hr id=answer>([\s\S]+)/.exec(tmpl.afmt);
        if (!match) {
            void showInfo(tr.cardTemplatesAnkiCouldntFindTheLineBetween());
            return;
        }
        tracker.markBasic();
        const qfmt = tmpl.qfmt;
        tmpl.qfmt = match[2].trim();
        tmpl.afmt = `{{FrontSide}}\n\n<hr id=answer>\n\n${qfmt}`;
        redraw();
    }

    async function onCopyMarkdown(): Promise<void> {
        const sanitize = (md: string) => md.replaceAll("```", "\\`\\`\\`");
        const tmpl = template;
        const markdown = "## Front Template\n```html\n"
            + `${sanitize(tmpl.qfmt)}\n`
            + "```\n## Back Template\n```html\n"
            + `${sanitize(tmpl.afmt)}\n`
            + "```\n## Styling\n```css\n"
            + `${sanitize(nt.css)}\n`
            + "```\n";
        await navigator.clipboard.writeText(markdown);
        tooltip(trq.aboutCopiedToClipboard());
    }

    async function onBrowserDisplay(): Promise<void> {
        const tmpl = template;
        const values = await openForm(
            [
                { key: "bqfmt", label: tr.browsingOverrideFrontTemplate(), type: "text", value: tmpl.bqfmt ?? "" },
                { key: "bafmt", label: tr.browsingOverrideBackTemplate(), type: "text", value: tmpl.bafmt ?? "" },
                { key: "override", label: tr.browsingOverrideFont(), type: "checkbox", value: !!tmpl.bfont },
                { key: "bfont", label: tr.fieldsFont(), type: "text", value: tmpl.bfont || "Arial" },
                { key: "bsize", label: tr.fieldsSize(), type: "number", value: tmpl.bsize || 12, min: 1, max: 300 },
            ],
            { title: tr.browsingBrowserAppearance() },
        );
        if (!values) {
            return;
        }
        tracker.markBasic();
        tmpl.bqfmt = String(values.bqfmt).trim();
        tmpl.bafmt = String(values.bafmt).trim();
        if (values.override) {
            tmpl.bfont = String(values.bfont);
            tmpl.bsize = Number(values.bsize);
        } else {
            delete tmpl.bfont;
            delete tmpl.bsize;
        }
    }

    async function onTargetDeck(): Promise<void> {
        const tmpl = template;
        let current = "";
        if (tmpl.did) {
            current = (await getDeck({ did: BigInt(tmpl.did) }).catch(() => null))?.name ?? "";
        }
        const name = await getText(
            tr.cardTemplatesEnterDeckToPlaceNew({ val: tmpl.name }),
            { value: current, title: "Anki" },
        );
        if (name === null) {
            return;
        }
        tracker.markBasic();
        if (!name.trim()) {
            tmpl.did = null;
        } else {
            const did = await addNormalDeck(name.trim());
            if (did !== undefined) {
                tmpl.did = Number(did);
            }
        }
    }

    function onMore(event: MouseEvent): void {
        const items: MenuEntry[] = [
            { label: tr.actionsWithEllipsis({ action: tr.cardTemplatesRestoreToDefault() }), action: () => void onRestoreToDefault() },
        ];
        if (!isCloze) {
            items.push(
                { label: tr.cardTemplatesAddCardType(), action: () => void onAddCard() },
                { label: tr.cardTemplatesRemoveCardType(), action: () => void onRemove() },
                { label: tr.cardTemplatesRenameCardType(), action: () => void onRename() },
                { label: tr.cardTemplatesRepositionCardType(), action: () => void onReorder() },
                null,
                {
                    label: tr.cardTemplatesDeckOverride() + (template.did ? tr.cardTemplatesOn() : tr.cardTemplatesOff()),
                    action: () => void onTargetDeck(),
                },
            );
        }
        items.push(
            { label: tr.cardTemplatesCopyInfo(), action: () => void onCopyMarkdown() },
            { label: tr.cardTemplatesBrowserAppearance(), action: () => void onBrowserDisplay() },
        );
        popupMenu(items, event.currentTarget as Element);
    }

    async function onAddField(): Promise<void> {
        const values = await openForm(
            [
                {
                    key: "field",
                    label: tr.fieldsField(),
                    type: "select",
                    value: nt.flds[0]?.name ?? "",
                    options: nt.flds.map((f) => ({ value: f.name, label: f.name })),
                },
                { key: "font", label: tr.fieldsFont(), type: "text", value: "Arial" },
                { key: "size", label: tr.fieldsSize(), type: "number", value: 20, min: 1, max: 300 },
            ],
            { title: tr.fieldsAddField() },
        );
        if (!values || !values.field) {
            return;
        }
        const addition = `\n<div style='font-family: "${values.font}"; font-size: ${values.size}px;'>{{${values.field}}}</div>\n`;
        tracker.markBasic();
        if (editorIndex === 0) {
            template.qfmt += addition;
        } else if (editorIndex === 1) {
            template.afmt += addition;
        }
        redraw();
    }

    // Saving and closing
    ////////////////////////////////////////////////////////////////////////

    let saving = false;

    async function save(): Promise<boolean> {
        if (saving) {
            return false;
        }
        saving = true;
        try {
            const out = await saveNotetypeDict(nt);
            if (out === undefined) {
                return false;
            }
            tracker.setUnchanged();
            tooltip(tr.cardTemplatesChangesSaved());
            win.close();
            return true;
        } finally {
            saving = false;
        }
    }

    async function canClose(): Promise<boolean> {
        if (!tracker.changed()) {
            return true;
        }
        const result = await openDialog({
            text: tr.cardTemplatesDiscardChanges(),
            buttons: [
                { label: tr.actionsCancel(), value: "cancel" },
                { label: tr.actionsDiscard(), value: "discard", danger: true },
                { label: tr.actionsSave(), value: "save", primary: true },
            ],
        });
        if (result.button === "save") {
            await save();
            return false;
        }
        return result.button === "discard";
    }

    // Shortcuts
    ////////////////////////////////////////////////////////////////////////

    function onKey(event: KeyboardEvent): boolean {
        const ctrl = /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
        if (ctrl && !event.shiftKey && !event.altKey) {
            if (event.key === "1" || event.key === "2" || event.key === "3") {
                setEditor((Number(event.key) - 1) as 0 | 1 | 2);
                return true;
            }
            if (event.key === "Enter") {
                void save();
                return true;
            }
        }
        if (!ctrl && !event.altKey && event.key === "F3" && !isCloze && ord > 0) {
            changeOrd(ord - 1);
            return true;
        }
        if (!ctrl && !event.altKey && event.key === "F4" && !isCloze && ord + 1 < nt.tmpls.length) {
            changeOrd(ord + 1);
            return true;
        }
        if (event.altKey && !ctrl && isCloze && /^Digit[1-9]$/.test(event.code)) {
            const index = Number(event.code.slice(5)) - 1;
            if (index < clozeNumbers.length) {
                changeOrd(clozeNumbers[index] - 1);
                return true;
            }
        }
        return false;
    }

    function onWindowKey(event: KeyboardEvent): void {
        if (event.defaultPrevented || get(windows).at(-1)?.handle !== win) {
            return;
        }
        if (onKey(event)) {
            event.preventDefault();
        }
    }

    onMount(async () => {
        api.canClose = canClose;
        frame = iframe!.contentWindow as Window & Record<string, any>;
        cleanups.push(
            attachFrame(frame, {
                window: win,
                onBridge: (cmd) => {
                    if (cmd === "reviewerReady") {
                        frame?.document.documentElement.classList.toggle("night-mode", nightMode);
                        markReady();
                    } else if (cmd.startsWith("play:")) {
                        playClicked(cmd);
                    }
                    return undefined;
                },
                onKey,
                onEscape: () => void win.requestClose(),
            }),
        );
        const counts = await getNotetypeNamesAndCounts({});
        useCount = counts.entries.find((e) => Number(e.id) === Number(nt.id))?.useCount ?? 0;
        if (isCloze) {
            const nums = [...(await clozeNumbersInNote(note)).numbers];
            if (!nums.includes(ord + 1)) {
                nums.push(ord + 1);
            }
            clozeNumbers = nums.sort((a, b) => a - b);
        }
        await loadReviewerSettings();
        redraw();
    });

    onDestroy(() => {
        api.canClose = undefined;
        renderGeneration++;
        if (renderTimer) {
            clearTimeout(renderTimer);
        }
        avPlayer.stopAndClearQueue();
        cleanups.forEach((fn) => fn());
    });
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="clayout">
    <div class="top">
        <label>
            <span>{tr.cardTemplatesCardType()}</span>
            <select
                class="form-select"
                disabled={isCloze}
                value={isCloze ? 0 : ord}
                onchange={(e) => changeOrd(Number((e.currentTarget as HTMLSelectElement).value))}
            >
                {#each nt.tmpls as tmpl, i (tmpl)}
                    <option value={i}>{summarizedName(i, tmpl)}</option>
                {/each}
            </select>
        </label>
        <button type="button" class="btn btn-secondary" onclick={onMore}>{tr.actionsOptions()} ▾</button>
    </div>

    <div class="main">
        <section class="template">
            <div class="tabs" role="tablist">
                {#each [tr.cardTemplatesFrontTemplate(), tr.cardTemplatesBackTemplate(), tr.cardTemplatesTemplateStyling()] as label, i (i)}
                    <button
                        type="button"
                        role="tab"
                        aria-selected={editorIndex === i}
                        class:active={editorIndex === i}
                        title={`Ctrl+${i + 1}`}
                        onclick={() => setEditor(i as 0 | 1 | 2)}
                    >
                        {label}
                    </button>
                {/each}
            </div>
            <textarea
                bind:this={textarea}
                class="editor"
                spellcheck="false"
                autocapitalize="off"
                autocomplete="off"
                value={editorText}
                oninput={onEdit}
                onkeydown={onEditorKey}
            ></textarea>
            <div class="editor-footer">
                <input
                    class="form-control form-control-sm"
                    type="search"
                    placeholder="Search"
                    bind:value={search}
                    oninput={() => onSearch(false)}
                    onkeydown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            onSearch(true);
                        }
                    }}
                />
                <span class="affects">{tr.cardTemplatesChangesWillAffectNotes({ count: useCount })}</span>
            </div>
        </section>

        <section class="preview">
            <div class="preview-bar">
                <label>
                    <input type="radio" name="clayout-side" checked={previewFront} onchange={() => {
                        previewFront = true;
                        haveAutoplayed = false;
                        redraw();
                    }} />
                    {tr.cardTemplatesFrontPreview()}
                </label>
                <label>
                    <input type="radio" name="clayout-side" checked={!previewFront} onchange={() => {
                        previewFront = false;
                        haveAutoplayed = false;
                        redraw();
                    }} />
                    {tr.cardTemplatesBackPreview()}
                </label>
                {#if isCloze}
                    <select
                        class="form-select form-select-sm cloze"
                        value={ord + 1}
                        onchange={(e) => changeOrd(Number((e.currentTarget as HTMLSelectElement).value) - 1)}
                    >
                        {#each clozeNumbers as n (n)}
                            <option value={n}>{tr.cardTemplatesCard({ val: n })}</option>
                        {/each}
                    </select>
                {/if}
                <span class="spacer"></span>
                <button type="button" class="btn btn-secondary btn-sm" onclick={previewSettings}>
                    {tr.cardTemplatesPreviewSettings()} ▾
                </button>
            </div>
            <iframe bind:this={iframe} title={tr.cardTemplatesPreviewBox()} src="/reviewer"></iframe>
        </section>
    </div>

    <div class="buttons">
        {#if editorIndex !== 2}
            <button type="button" class="btn btn-secondary" onclick={() => void onAddField()}>
                {tr.fieldsAddField()}
            </button>
        {/if}
        {#if !isCloze}
            <button type="button" class="btn btn-secondary" onclick={onFlip}>{tr.cardTemplatesFlip()}</button>
        {/if}
        <span class="spacer"></span>
        <button type="button" class="btn btn-secondary" onclick={() => void win.requestClose()}>
            {tr.actionsCancel()}
        </button>
        <button type="button" class="btn btn-primary" title="Ctrl+Enter" onclick={() => void save()}>
            {tr.actionsSave()}
        </button>
    </div>
</div>

<style lang="scss">
    .clayout {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
        padding: 0.75rem;
        height: 100%;
        min-height: 0;
    }

    .top {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        label {
            flex: 1;
            display: flex;
            gap: 0.5rem;
            align-items: center;
            min-width: 0;
            span {
                white-space: nowrap;
            }
        }
        select {
            min-width: 0;
        }
    }

    .main {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.75rem;
    }

    section {
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
        border: 1px solid var(--border-subtle);
        border-radius: var(--border-radius);
        overflow: hidden;
    }

    .tabs {
        display: flex;
        border-bottom: 1px solid var(--border-subtle);
        button {
            flex: 1;
            padding: 0.35rem 0.5rem;
            border: 0;
            background: transparent;
            color: var(--fg-subtle);
            &.active {
                color: var(--fg);
                box-shadow: inset 0 -2px 0 var(--border-focus);
            }
        }
    }

    .editor {
        flex: 1;
        min-height: 12rem;
        resize: none;
        border: 0;
        padding: 0.5rem;
        background: var(--canvas-code, var(--canvas-inset));
        color: var(--fg);
        font-family: Consolas, Menlo, "Liberation Mono", monospace;
        font-size: 0.9em;
        tab-size: 4;
        white-space: pre;
        outline: none;
    }

    .editor-footer {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        padding: 0.35rem 0.5rem;
        border-top: 1px solid var(--border-subtle);
        input {
            max-width: 12rem;
        }
        .affects {
            color: var(--fg-subtle);
            font-size: 0.85em;
        }
    }

    .preview-bar {
        display: flex;
        gap: 0.75rem;
        align-items: center;
        padding: 0.35rem 0.5rem;
        border-bottom: 1px solid var(--border-subtle);
        label {
            display: flex;
            gap: 0.3rem;
            align-items: center;
            white-space: nowrap;
        }
        .cloze {
            width: auto;
        }
    }

    .spacer {
        flex: 1;
    }

    iframe {
        flex: 1;
        border: 0;
        width: 100%;
        min-height: 12rem;
        background: var(--canvas);
    }

    .buttons {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
    }

    @media (max-width: 800px) {
        .main {
            grid-template-columns: 1fr;
            grid-template-rows: 1fr 1fr;
        }
        .editor-footer .affects {
            display: none;
        }
    }
</style>
