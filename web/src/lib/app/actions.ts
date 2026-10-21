// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * The main window's commands (desktop's AnkiQt menu actions and
 * aqt.dialogs): each opens a window or runs an operation.
 */

import type { Card } from "@generated/anki/cards_pb";
import type { SearchNode } from "@generated/anki/search_pb";
import {
    checkDatabase,
    closeCollection,
    getCurrentDeck,
    getDeck,
    getDeckNames,
    getEmptyCards,
    importCollectionPackage,
    openCollection,
} from "@generated/backend";
import * as tr from "@generated/ftl";
import * as trq from "@generated/ftl-qt";
import { get } from "svelte/store";

import { profilePaths } from "../engine/protocol";
import { selectDeck } from "./decks";
import { askUser, chooseFrom, showInfo, showWarning, tooltip } from "./dialogs";
import { displayName, fileToEnginePath, pickFiles } from "./files";
import { setWindowCommands } from "./frontend";
import { mainState, moveToState, reset } from "./main";
import { editorNotetypeCommands } from "./notetypes";
import { backupNow, currentProfile } from "./profiles";
import { reviewer, reviewerCards, startTimebox } from "./reviewer";
import { runOp } from "./run";
import { findWindow, openWindow, type WindowHandle } from "./windows";

// Editing
//////////////////////////////////////////////////////////////////////////////

/** Waits for the editor in a window to report it is ready. */
function editorWindow(
    key: string,
    title: string,
    mode: "add" | "current" | "browser",
    onReady: (frame: any, win: WindowHandle) => void,
): WindowHandle {
    const existing = findWindow(key);
    if (existing) {
        existing.focus();
        if (existing.frame) {
            onReady(existing.frame, existing);
        }
        return existing;
    }
    const notetypeCommands = editorNotetypeCommands(
        () => win.frame,
        () => (mode === "current" ? reviewer.card?.templateIdx ?? 0 : 0),
    );
    const win: WindowHandle = openWindow({
        key,
        title,
        url: `/editor?mode=${mode}`,
        size: "lg",
        onBridge: (cmd, handle) => {
            if (cmd === "editorReady") {
                onReady(handle.frame, handle);
            } else if (cmd === "preview") {
                void import("./previewer").then((p) => p.openPreviewerForEditor(handle));
            } else if (cmd === "cards") {
                notetypeCommands.openCardsDialog?.();
            } else if (cmd === "fields") {
                notetypeCommands.openFieldsDialog?.();
            }
            return undefined;
        },
        // the editor saves, then calls closeAddCards/closeEditCurrent itself
        canClose: async (handle) => {
            const frame = handle.frame as any;
            if (mode === "add" && frame?.closeAddCards) {
                await frame.closeAddCards();
                return false;
            }
            await frame?.saveNow?.();
            return true;
        },
    });
    setWindowCommands(win, notetypeCommands);
    return win;
}

export function openAddCards(
    options: { deckId?: bigint; notetypeId?: bigint; copyFromNoteId?: bigint } = {},
): WindowHandle {
    const win = editorWindow("addCards", tr.actionsAdd(), "add", (frame) => {
        if (options.copyFromNoteId) {
            frame.loadNote({
                notetypeId: options.notetypeId ?? null,
                deckId: options.deckId ?? null,
                originalNoteId: options.copyFromNoteId,
                focusTo: 0,
                initial: true,
            });
        } else {
            frame.loadNote({
                notetypeId: options.notetypeId ?? null,
                deckId: options.deckId ?? null,
                focusTo: 0,
                initial: true,
            });
        }
    });
    setWindowCommands(win, {
        closeAddCards: async (prompt) => {
            if (
                !prompt
                || await askUser(tr.addingDiscardCurrentInput(), {
                    yes: tr.actionsDiscard(),
                    no: tr.addingKeepEditing(),
                    defaultNo: true,
                })
            ) {
                win.close();
                reset();
            }
        },
    });
    return win;
}

export function onAddCard(): void {
    openAddCards();
}

export function onEditCurrent(): void {
    const card = reviewer.card;
    if (!card) {
        return;
    }
    const win = editorWindow("editCurrent", tr.editingEditCurrent(), "current", (frame) => {
        const current = reviewer.card;
        if (current) {
            frame.loadNote({ nid: current.noteId, reviewerCardId: current.id, focusTo: 0, initial: true });
        }
    });
    setWindowCommands(win, { closeEditCurrent: () => win.close() });
}

export function onCreateCopy(card: Card): void {
    openAddCards({ copyFromNoteId: card.noteId, deckId: card.originalDeckId || card.deckId });
}

// Browser, stats, card info
//////////////////////////////////////////////////////////////////////////////

export function openBrowser(options: { search?: SearchNode; cardId?: bigint } = {}): void {
    void import("../ui/browser/Browser.svelte").then(({ default: Browser }) => {
        const existing = findWindow("browser");
        if (existing) {
            existing.focus();
            if (options.search) {
                (existing.spec?.props?.api as BrowserApi | undefined)?.search?.(options.search);
            }
            return;
        }
        const api: BrowserApi = {};
        openWindow({
            key: "browser",
            title: trq.qtMiscBrowse(),
            component: Browser,
            props: { initialSearch: options.search, initialCardId: options.cardId ?? reviewer.card?.id, api },
            size: "full",
            canClose: async () => (await api.canClose?.()) ?? true,
        });
    });
}

interface BrowserApi {
    search?: (node: SearchNode) => void;
    canClose?: () => Promise<boolean>;
}

export function onBrowse(): void {
    openBrowser({ cardId: reviewer.card?.id });
}

export function onStats(): void {
    openWindow({ key: "stats", title: trq.qtMiscStats(), url: "/graphs", size: "xl" });
}

function cardInfoWindow(key: string, cardId: bigint | null, title: string): void {
    if (cardId === null) {
        tooltip(tr.cardStatsNoCard());
        return;
    }
    const existing = findWindow(key);
    if (existing) {
        existing.close();
    }
    openWindow({ key, title, url: `/card-info/${cardId}`, size: "md" });
}

export function openCardInfo(cardId?: bigint): void {
    cardInfoWindow("cardInfo", cardId ?? reviewer.card?.id ?? null, tr.actionsCardInfo());
}

export function openPreviousCardInfo(): void {
    cardInfoWindow("previousCardInfo", get(reviewerCards).previous ?? reviewer.lastCardId(), tr.actionsPreviousCardInfo());
}

// keep an open card info window following the reviewer
reviewerCards.subscribe(({ current }) => {
    const win = findWindow("cardInfo");
    if (win && current !== null) {
        cardInfoWindow("cardInfo", current, tr.actionsCardInfo());
    }
});

// Deck options
//////////////////////////////////////////////////////////////////////////////

export async function openDeckOptions(deckId: bigint): Promise<void> {
    const deck = await runOp(() => getDeck({ did: deckId }));
    if (!deck) {
        return;
    }
    if (deck.kind.case === "filtered") {
        await onFilteredDeck({ deckId });
        return;
    }
    openWindow({
        key: "deckOptions",
        title: tr.actionsOptionsFor({ val: deck.name }),
        url: `/deck-options/${deckId}`,
        size: "lg",
        // the page asks about unsaved changes, then calls deckOptionsRequireClose
        canClose: async (win) => {
            const anki = (win.frame as any)?.anki;
            if (anki?.deckOptionsPendingChanges) {
                await anki.deckOptionsPendingChanges();
                return false;
            }
            return true;
        },
    });
}

export async function confirmDeckThenDisplayOptions(card?: Card): Promise<void> {
    const current = await runOp(() => getCurrentDeck({}));
    if (!current) {
        return;
    }
    const decks = [current];
    if (card) {
        if (card.originalDeckId && card.originalDeckId !== current.id) {
            decks.push(await getDeck({ did: card.originalDeckId }));
        }
        if (!decks.some((d) => d.id === card.deckId)) {
            decks.push(await getDeck({ did: card.deckId }));
        }
    }
    if (decks.length === 1) {
        await openDeckOptions(decks[0].id);
        return;
    }
    decks.sort((a, b) => Number(a.kind.case === "filtered") - Number(b.kind.case === "filtered"));
    const choice = await chooseFrom(tr.deckConfigWhichDeck(), decks.map((d) => d.name));
    if (choice !== null) {
        await openDeckOptions(decks[choice].id);
    }
}

// Studying
//////////////////////////////////////////////////////////////////////////////

export function onStudyKey(): void {
    if (get(mainState) === "overview") {
        startTimebox();
        moveToState("review");
    } else {
        moveToState("overview");
    }
}

export async function onStudyDeck(): Promise<void> {
    const names = await runOp(() => getDeckNames({ skipEmptyDefault: true, includeFiltered: true }));
    if (!names) {
        return;
    }
    const choice = await chooseFrom(trq.qtMiscChooseDeck(), names.entries.map((e) => e.name), {
        title: trq.qtMiscStudyDeck(),
        filter: true,
        okLabel: tr.studyingStudyNow(),
    });
    if (choice !== null && await selectDeck(names.entries[choice].id)) {
        moveToState("overview");
    }
}

export async function onCustomStudy(deckId?: bigint): Promise<void> {
    const did = deckId ?? (await runOp(() => getCurrentDeck({})))?.id;
    if (did === undefined) {
        return;
    }
    const { default: CustomStudy } = await import("../ui/dialogs/CustomStudy.svelte");
    openWindow({ key: "customStudy", title: tr.actionsCustomStudy(), component: CustomStudy, props: { deckId: did }, size: "sm" });
}

export async function onFilteredDeck(options: { deckId?: bigint; search?: string; search2?: string } = {}): Promise<void> {
    const { default: FilteredDeck } = await import("../ui/dialogs/FilteredDeck.svelte");
    openWindow({
        key: "filteredDeck",
        title: options.deckId ? tr.actionsOptions() : trq.qtMiscCreateFilteredDeck(),
        component: FilteredDeck,
        props: options,
        size: "md",
    });
}

// Importing and exporting
//////////////////////////////////////////////////////////////////////////////

const IMPORT_ENDINGS = [".apkg", ".colpkg", ".zip", ".csv", ".tsv", ".txt", ".anki-json"];

export async function onImport(): Promise<void> {
    const [file] = await pickFiles({ accept: IMPORT_ENDINGS.join(",") });
    if (file) {
        await importFile(file);
    }
}

export async function importFile(file: File): Promise<void> {
    const name = file.name.toLowerCase();
    if (name === "collection.apkg" || (name.startsWith("backup-") && name.endsWith(".apkg")) || name.endsWith(".colpkg")) {
        if (await askUser(tr.importingThisWillDeleteYourExistingCollection(), { defaultNo: true, danger: true })) {
            await importCollectionPackageFile(file);
        }
        return;
    }
    const path = await fileToEnginePath(file, file.name);
    let page: string;
    if (name.endsWith(".apkg") || name.endsWith(".zip")) {
        page = "import-anki-package";
    } else if (name.endsWith(".csv") || name.endsWith(".tsv") || name.endsWith(".txt")) {
        page = "import-csv";
    } else if (name.endsWith(".anki-json")) {
        page = "import-page";
    } else {
        await showWarning("Unsupported file type.");
        return;
    }
    openImportPage(page, path);
}

function openImportPage(page: string, path: string): void {
    const win = openWindow({
        title: `${tr.decksImportFile()}: ${displayName(path)}`,
        url: `/${page}/${encodeURIComponent(path)}`,
        size: "lg",
        onClose: () => reset(),
    });
    setWindowCommands(win, {});
}

/** Replaces the collection with a .colpkg (desktop's ColpkgImporter). */
export async function importCollectionPackageFile(file: Blob): Promise<boolean> {
    if (!get(currentProfile)) {
        return false;
    }
    return replaceCollection(await fileToEnginePath(file, "import.colpkg"));
}

/** Replaces the collection with a .colpkg at an engine path, e.g. a backup. */
export async function replaceCollection(colpkgPath: string): Promise<boolean> {
    const name = get(currentProfile);
    if (!name) {
        return false;
    }
    const paths = profilePaths(name);
    let ok = false;
    await runOp(async () => {
        await backupNow(true).catch(() => false);
        await closeCollection({ downgradeToSchema11: false });
        try {
            await importCollectionPackage({
                colPath: paths.collection,
                backupPath: colpkgPath,
                mediaFolder: paths.mediaFolder,
                mediaDb: paths.mediaDb,
            });
            ok = true;
        } finally {
            await openCollection({
                collectionPath: paths.collection,
                mediaFolderPath: paths.mediaFolder,
                mediaDbPath: paths.mediaDb,
            });
        }
    }, { progress: true, cancellable: true });
    moveToState("deckBrowser");
    reset();
    if (ok) {
        tooltip(tr.importingImportingComplete());
    }
    return ok;
}

export async function onExport(options: { deckId?: bigint; noteIds?: bigint[]; cardIds?: bigint[] } = {}): Promise<void> {
    const { default: ExportDialog } = await import("../ui/dialogs/ExportDialog.svelte");
    openWindow({ key: "export", title: tr.actionsExport(), component: ExportDialog, props: options, size: "sm" });
}

// Tools
//////////////////////////////////////////////////////////////////////////////

export async function onCheckDB(): Promise<void> {
    const out = await runOp(async () => {
        await backupNow(true).catch(() => false);
        return checkDatabase({});
    }, { progress: true });
    if (!out) {
        return;
    }
    const text = out.problems.length ? out.problems.join("\n") : tr.databaseCheckRebuilt();
    await showInfo(text);
    reset();
}

export async function onCheckMedia(): Promise<void> {
    const { openMediaCheck } = await import("../ui/dialogs/media-check");
    await openMediaCheck();
}

export async function onEmptyCards(): Promise<void> {
    const report = await runOp(() => getEmptyCards({}), { progress: true });
    if (!report) {
        return;
    }
    if (!report.notes.length) {
        tooltip(tr.emptyCardsNotFound());
        return;
    }
    const { default: EmptyCards } = await import("../ui/dialogs/EmptyCards.svelte");
    openWindow({ key: "emptyCards", title: tr.emptyCardsWindowTitle(), component: EmptyCards, props: { report }, size: "md" });
}

export async function onNoteTypes(): Promise<void> {
    const { default: NoteTypes } = await import("../ui/notetypes/NoteTypes.svelte");
    openWindow({ key: "noteTypes", title: tr.notetypesNoteTypes(), component: NoteTypes, size: "md" });
}

export async function onPrefs(): Promise<void> {
    const { default: Preferences } = await import("../ui/dialogs/Preferences.svelte");
    openWindow({ key: "preferences", title: tr.preferencesPreferences(), component: Preferences, size: "md" });
}

export async function onAbout(): Promise<void> {
    const { default: About } = await import("../ui/dialogs/About.svelte");
    openWindow({ key: "about", title: trq.aboutAboutAnki(), component: About, size: "md" });
}

export async function onPlugins(): Promise<void> {
    const { default: Plugins } = await import("../ui/dialogs/Plugins.svelte");
    openWindow({ key: "plugins", title: trq.qtMiscAddons(), component: Plugins, size: "md" });
}

export function onDocumentation(): void {
    window.open("https://docs.ankiweb.net/", "_blank", "noopener");
}

export async function onCreateBackup(): Promise<void> {
    const created = await runOp(() => backupNow(true), { progress: trq.qtMiscBackingUp() });
    if (created) {
        tooltip(tr.profilesBackupCreated());
    }
}

export async function onOpenBackup(): Promise<void> {
    const { default: Backups } = await import("../ui/dialogs/Backups.svelte");
    openWindow({ key: "backups", title: trq.qtMiscRevertToBackup(), component: Backups, size: "sm" });
}

// Recording
//////////////////////////////////////////////////////////////////////////////

export async function recordAudioBlob(): Promise<Blob | null> {
    const { default: RecordAudio } = await import("../ui/dialogs/RecordAudio.svelte");
    return new Promise((resolve) => {
        let result: Blob | null = null;
        openWindow({
            title: tr.editingRecordAudio(),
            component: RecordAudio,
            props: { onDone: (blob: Blob | null) => (result = blob) },
            size: "sm",
            onClose: () => resolve(result),
        });
    });
}

/** Records audio for the editor, returning a path the engine can add as media. */
export async function recordAudioDialog(): Promise<string | null> {
    const blob = await recordAudioBlob();
    if (!blob) {
        return null;
    }
    const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm";
    return fileToEnginePath(blob, `rec${Date.now()}.${ext}`);
}
