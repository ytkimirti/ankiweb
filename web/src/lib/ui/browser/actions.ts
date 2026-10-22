// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** The browser's menu commands (desktop's browser.py actions). */

import { ScheduleCardsAsNewRequest_Context } from "@generated/anki/scheduler_pb";
import {
    clearUnusedTags,
    getCard,
    getDeckNames,
    getNote,
    getSingleNotetypeOfNotes,
    restoreBuriedAndSuspendedCards,
    setDeck,
} from "@generated/backend";
import * as tr from "@generated/ftl";
import * as trq from "@generated/ftl-qt";

import { onExport, onFilteredDeck, onNoteTypes, openAddCards, openCardInfo } from "$web/app/actions";
import { getEngine } from "$web/app/backend";
import {
    addTagsToNotes,
    allFlags,
    buryCards,
    forgetCardsDialog,
    gradeNowWithTooltip,
    MARKED_TAG,
    removeNotesWithTooltip,
    removeTagsFromNotes,
    repositionDialog,
    SET_DUE_BROWSER,
    setCardFlag,
    setDueDateDialog,
    suspendCards,
    unsuspendCards,
} from "$web/app/cardops";
import { addDeckDialog } from "$web/app/decks";
import { chooseFrom, getText, openDialog, tooltip } from "$web/app/dialogs";
import { setWindowCommands } from "$web/app/frontend";
import type { MenuEntry } from "$web/app/menus";
import { runOp } from "$web/app/run";
import { openWindow } from "$web/app/windows";

import { type BrowserPluginContext, hooks } from "$web/plugins/hooks";

import type { BrowserModel } from "./model.svelte";

const QUEUE_SUSPENDED = -1;
const QUEUE_BURIED = [-2, -3];
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

export interface BrowserContext {
    model: BrowserModel;
    /** Saves the note being edited before an operation reads it. */
    saveEditor(): Promise<void>;
    preview(): void;
    focusSearch(): void;
    focusSidebar(): void;
    findReplace(): void;
    findDuplicates(): void;
    searchFor(search: string): Promise<void>;
    /** Saves the editor, then switches between cards and notes. */
    toggleMode(): Promise<void>;
    toggleSidebar(): void;
}

function pluginContext(ctx: BrowserContext): BrowserPluginContext {
    return {
        notesMode: () => ctx.model.notesMode,
        selectedNoteIds: async () => (await ctx.saveEditor(), ctx.model.selectedNoteIds()),
        selectedCardIds: async () => (await ctx.saveEditor(), ctx.model.selectedCardIds()),
        search: (text) => ctx.searchFor(text),
    };
}

async function cards(ctx: BrowserContext): Promise<bigint[]> {
    await ctx.saveEditor();
    const ids = await ctx.model.selectedCardIds();
    if (!ids.length) {
        tooltip(trq.qtMiscPleaseSelect1Card());
    }
    return ids;
}

async function notes(ctx: BrowserContext): Promise<bigint[]> {
    await ctx.saveEditor();
    return ctx.model.selectedNoteIds();
}

export async function changeDeck(ctx: BrowserContext): Promise<void> {
    const ids = await cards(ctx);
    if (!ids.length) {
        return;
    }
    const names = await runOp(() => getDeckNames({ skipEmptyDefault: false, includeFiltered: false }));
    if (!names) {
        return;
    }
    const result = await openDialog({
        title: tr.browsingChangeDeck(),
        text: "",
        choices: { items: names.entries.map((e) => e.name), selected: 0, filter: true },
        buttons: [
            { label: tr.actionsAdd(), value: "add" },
            { label: tr.actionsCancel(), value: "cancel" },
            { label: tr.actionsChoose(), value: "ok", primary: true },
        ],
    });
    let deckId: bigint | undefined;
    if (result.button === "add") {
        deckId = await addDeckDialog();
    } else if (result.button === "ok" && result.choice !== undefined) {
        deckId = names.entries[result.choice].id;
    }
    if (deckId !== undefined) {
        await runOp(() => setDeck({ cardIds: ids, deckId }));
    }
}

export async function toggleSuspend(ctx: BrowserContext): Promise<void> {
    const ids = await cards(ctx);
    const current = await ctx.model.currentCardId();
    if (!ids.length || current === null) {
        return;
    }
    const card = await getCard({ cid: current });
    if (card.queue === QUEUE_SUSPENDED) {
        await unsuspendCards(ids);
    } else {
        await suspendCards(ids);
    }
}

export async function toggleBury(ctx: BrowserContext): Promise<void> {
    const ids = await cards(ctx);
    const current = await ctx.model.currentCardId();
    if (!ids.length || current === null) {
        return;
    }
    const card = await getCard({ cid: current });
    if (QUEUE_BURIED.includes(card.queue)) {
        await runOp(() => restoreBuriedAndSuspendedCards({ cids: ids }));
    } else {
        await buryCards(ids);
    }
}

export async function toggleMark(ctx: BrowserContext): Promise<void> {
    const ids = await notes(ctx);
    const current = await ctx.model.currentNoteId();
    if (!ids.length || current === null) {
        return;
    }
    const note = await getNote({ nid: current });
    if (note.tags.some((t) => t.toLowerCase() === MARKED_TAG)) {
        await removeTagsFromNotes(ids, MARKED_TAG);
    } else {
        await addTagsToNotes(ids, MARKED_TAG);
    }
}

export async function setFlag(ctx: BrowserContext, flag: number): Promise<void> {
    const ids = await cards(ctx);
    const current = await ctx.model.currentCardId();
    if (!ids.length) {
        return;
    }
    // choosing the current card's flag again clears it, as on desktop
    if (current !== null && ((await getCard({ cid: current })).flags & 0b111) === flag) {
        flag = 0;
    }
    await setCardFlag(ids, flag);
}

export async function addTags(ctx: BrowserContext): Promise<void> {
    const ids = await notes(ctx);
    if (!ids.length) {
        return;
    }
    const tags = await getText(tr.browsingEnterTagsToAdd(), { title: tr.browsingAddTags2() });
    if (tags?.trim()) {
        await addTagsToNotes(ids, tags.trim());
    }
}

export async function removeTags(ctx: BrowserContext): Promise<void> {
    const ids = await notes(ctx);
    if (!ids.length) {
        return;
    }
    const tags = await getText(tr.browsingEnterTagsToDelete(), { title: tr.browsingRemoveTags() });
    if (tags?.trim()) {
        await removeTagsFromNotes(ids, tags.trim());
    }
}

export async function clearUnused(): Promise<void> {
    const out = await runOp(() => clearUnusedTags({}), { progress: true });
    if (out) {
        tooltip(tr.browsingRemovedUnusedTagsCount({ count: out.count }));
    }
}

export async function deleteNotes(ctx: BrowserContext): Promise<void> {
    const ids = await notes(ctx);
    if (ids.length) {
        await removeNotesWithTooltip(ids);
    }
}

export async function reposition(ctx: BrowserContext): Promise<void> {
    const ids = await cards(ctx);
    if (!ids.length) {
        return;
    }
    const rows = (await getEngine().db({
        kind: "query",
        sql: "select min(due), max(due) from cards where type=0 and odid=0",
        args: [],
        first_row_only: true,
    })) as (number | null)[][] | null;
    const [min, max] = rows?.[0] ?? [0, 0];
    await repositionDialog(ids, { min: Math.max(min ?? 0, 0), max: max ?? 0 });
}

export async function gradeNow(ctx: BrowserContext): Promise<void> {
    const ids = await cards(ctx);
    if (!ids.length) {
        return;
    }
    const labels = [tr.studyingAgain(), tr.studyingHard(), tr.studyingGood(), tr.studyingEasy()];
    const choice = await chooseFrom(tr.actionsGradeNow(), labels, { selected: 2 });
    if (choice !== null) {
        await gradeNowWithTooltip(ids, choice + 1);
    }
}

export async function changeNotetype(ctx: BrowserContext): Promise<void> {
    const ids = await notes(ctx);
    if (!ids.length) {
        return;
    }
    const out = await runOp(() => getSingleNotetypeOfNotes({ noteIds: ids }));
    if (!out) {
        return;
    }
    const notetypeId = out.ntid;
    const win = openWindow({
        key: "changeNotetype",
        title: tr.browsingChangeNotetype(),
        url: `/change-notetype/${notetypeId}`,
        size: "lg",
    });
    setWindowCommands(win, { changeNotetypeNoteIds: ids });
}

export async function forget(ctx: BrowserContext): Promise<void> {
    const ids = await cards(ctx);
    if (ids.length) {
        await forgetCardsDialog(ids, ScheduleCardsAsNewRequest_Context.BROWSER);
    }
}

export async function setDue(ctx: BrowserContext): Promise<void> {
    const ids = await cards(ctx);
    if (ids.length) {
        await setDueDateDialog(ids, SET_DUE_BROWSER);
    }
}

export async function info(ctx: BrowserContext): Promise<void> {
    const current = await ctx.model.currentCardId();
    if (current !== null) {
        openCardInfo(current);
    }
}

export async function createCopy(ctx: BrowserContext): Promise<void> {
    const current = await ctx.model.currentCardId();
    if (current === null) {
        return;
    }
    const card = await getCard({ cid: current });
    openAddCards({ copyFromNoteId: card.noteId, deckId: card.originalDeckId || card.deckId });
}

export async function exportNotes(ctx: BrowserContext): Promise<void> {
    const ids = await notes(ctx);
    await onExport(ids.length ? { noteIds: ids } : {});
}

/** The browser's menus, as sections for the menu bar (also used for the row context menu). */
export async function browserMenus(ctx: BrowserContext): Promise<{ title: string; items: MenuEntry[] }[]> {
    const { model } = ctx;
    const accel = (label: string) => label.replace(/&(.)/g, "$1");
    const flags = await allFlags();
    const none = model.selected.size === 0;
    const single = model.selected.size === 1;
    const sections: { title: string; items: MenuEntry[] }[] = [
        {
            title: accel(trq.qtAccelEdit()),
            items: [
                { label: accel(trq.qtAccelSelectAll()), shortcut: "Ctrl+Alt+A", action: () => model.selectAll() },
                { label: accel(trq.qtAccelSelectNotes()), action: () => void selectNotes(ctx) },
                { label: accel(trq.qtAccelInvertSelection()), shortcut: "Ctrl+Alt+S", action: () => model.invertSelection() },
                null,
                { label: tr.actionsCreateCopy(), shortcut: "Ctrl+Alt+E", disabled: !single, action: () => void createCopy(ctx) },
                { label: tr.browsingAddNotes(), shortcut: "Ctrl+E", action: () => openAddCards() },
                null,
                { label: accel(trq.qtAccelFind()), shortcut: "Ctrl+F", action: ctx.focusSearch },
                { label: accel(trq.qtAccelFindAndReplace()), shortcut: "Ctrl+Alt+F", action: ctx.findReplace },
                { label: accel(trq.qtAccelFindDuplicates()), action: ctx.findDuplicates },
                null,
                { label: tr.browsingToggleShowingCardsNotes(), shortcut: "Ctrl+Alt+T", action: () => void ctx.toggleMode() },
                { label: accel(trq.qtAccelToggleSidebar()), shortcut: "Ctrl+Shift+R", action: ctx.toggleSidebar },
                { label: accel(trq.qtAccelFilter()), shortcut: "Ctrl+Shift+F", action: ctx.focusSidebar },
            ],
        },
        {
            title: accel(trq.qtAccelNotes()),
            items: [
                { label: tr.browsingAddTags2(), shortcut: "Ctrl+Shift+A", disabled: none, action: () => void addTags(ctx) },
                { label: tr.browsingRemoveTags(), shortcut: "Ctrl+Alt+Shift+A", disabled: none, action: () => void removeTags(ctx) },
                { label: tr.browsingClearUnusedTags(), action: () => void clearUnused() },
                { label: tr.browsingToggleMark(), shortcut: "Ctrl+K", disabled: none, action: () => void toggleMark(ctx) },
                null,
                { label: tr.browsingChangeNotetype(), shortcut: "Ctrl+Shift+M", disabled: none, action: () => void changeNotetype(ctx) },
                { label: tr.browsingManageNoteTypes(), shortcut: "Ctrl+Shift+N", action: () => void onNoteTypes() },
                null,
                { label: accel(trq.qtAccelExportNotes()), shortcut: "Ctrl+Shift+E", action: () => void exportNotes(ctx) },
                {
                    label: tr.actionsDelete(),
                    shortcut: isMac ? "Ctrl+Backspace" : "Ctrl+Delete",
                    disabled: none,
                    action: () => void deleteNotes(ctx),
                },
            ],
        },
        {
            title: accel(trq.qtAccelCards()),
            items: [
                { label: tr.browsingChangeDeck(), shortcut: "Ctrl+D", disabled: none, action: () => void changeDeck(ctx) },
                { label: accel(trq.qtAccelSetDueDate()), shortcut: "Ctrl+Shift+D", disabled: none, action: () => void setDue(ctx) },
                { label: tr.actionsGradeNow(), shortcut: "Ctrl+Shift+G", disabled: none, action: () => void gradeNow(ctx) },
                { label: accel(trq.qtAccelForget()), shortcut: "Ctrl+Alt+N", disabled: none, action: () => void forget(ctx) },
                { label: tr.browsingReposition(), shortcut: "Ctrl+Shift+S", disabled: none, action: () => void reposition(ctx) },
                null,
                { label: tr.browsingToggleSuspend(), shortcut: "Ctrl+J", disabled: none, action: () => void toggleSuspend(ctx) },
                { label: tr.browsingToggleBury(), shortcut: "Ctrl+Shift+J", disabled: none, action: () => void toggleBury(ctx) },
                {
                    label: tr.studyingFlagCard(),
                    disabled: none,
                    submenu: flags.map((flag) => ({
                        label: flag.label,
                        shortcut: `Ctrl+${flag.index}`,
                        action: () => void setFlag(ctx, flag.index),
                    })),
                },
                null,
                { label: accel(trq.qtAccelInfo()), shortcut: "Ctrl+Shift+I", disabled: !single, action: () => void info(ctx) },
                { label: tr.actionsPreview(), shortcut: "Ctrl+Shift+P", action: ctx.preview },
                null,
                {
                    label: trq.qtMiscCreateFilteredDeck(),
                    shortcut: "Ctrl+G",
                    action: () => void onFilteredDeck({ search: model.search }),
                },
            ],
        },
        {
            title: accel(trq.qtAccelGo()),
            items: [
                { label: accel(trq.qtAccelPreviousCard()), shortcut: "Ctrl+P", action: () => model.move(-1) },
                { label: accel(trq.qtAccelNextCard()), shortcut: "Ctrl+N", action: () => model.move(1) },
                { label: tr.browsingFirstCard(), shortcut: "Home", action: () => model.move("first") },
                { label: tr.browsingLastCard(), shortcut: "End", action: () => model.move("last") },
            ],
        },
    ];
    hooks.browserMenusWillShow.run(sections, pluginContext(ctx));
    return sections;
}

async function selectNotes(ctx: BrowserContext): Promise<void> {
    const nids = await notes(ctx);
    if (nids.length) {
        await ctx.searchFor(`nid:${nids.join(",")}`);
        ctx.model.selectAll();
    }
}

/** Keyboard shortcuts for the browser window. */
export function browserShortcuts(ctx: BrowserContext): [string, () => void][] {
    const { model } = ctx;
    const shortcuts: [string, () => void][] = [
        ["Ctrl+F", ctx.focusSearch],
        ["Ctrl+Shift+F", ctx.focusSidebar],
        ["Ctrl+Shift+R", ctx.toggleSidebar],
        ["Ctrl+Alt+A", () => model.selectAll()],
        ["Ctrl+Alt+S", () => model.invertSelection()],
        ["Ctrl+Alt+E", () => void createCopy(ctx)],
        ["Ctrl+E", () => openAddCards()],
        ["Ctrl+Alt+F", ctx.findReplace],
        ["Ctrl+Alt+T", () => void ctx.toggleMode()],
        ["Ctrl+Shift+A", () => void addTags(ctx)],
        ["Ctrl+Alt+Shift+A", () => void removeTags(ctx)],
        ["Ctrl+K", () => void toggleMark(ctx)],
        ["Ctrl+Shift+M", () => void changeNotetype(ctx)],
        ["Ctrl+Shift+N", () => void onNoteTypes()],
        ["Ctrl+Shift+E", () => void exportNotes(ctx)],
        [isMac ? "Ctrl+Backspace" : "Ctrl+Delete", () => void deleteNotes(ctx)],
        ["Ctrl+D", () => void changeDeck(ctx)],
        ["Ctrl+Shift+D", () => void setDue(ctx)],
        ["Ctrl+Shift+G", () => void gradeNow(ctx)],
        ["Ctrl+Alt+N", () => void forget(ctx)],
        ["Ctrl+Shift+S", () => void reposition(ctx)],
        ["Ctrl+J", () => void toggleSuspend(ctx)],
        ["Ctrl+Shift+J", () => void toggleBury(ctx)],
        ...[1, 2, 3, 4, 5, 6, 7].map((flag) => [`Ctrl+${flag}`, () => void setFlag(ctx, flag)] as [string, () => void]),
        ["Ctrl+Shift+I", () => void info(ctx)],
        ["Ctrl+Shift+P", ctx.preview],
        ["Ctrl+G", () => void onFilteredDeck({ search: model.search })],
        ["Ctrl+P", () => model.move(-1)],
        ["Ctrl+N", () => model.move(1)],
    ];
    hooks.browserDidInitShortcuts.run(shortcuts, pluginContext(ctx));
    return shortcuts;
}
