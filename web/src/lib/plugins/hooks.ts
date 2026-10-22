// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Hook points for web-native plugins, modelled on desktop's gui_hooks. A Hook
 * notifies its listeners; a Filter passes a value through each listener in
 * turn. The app calls these at the same places desktop calls its hooks, so
 * desktop add-ons can be ported hook by hook. See web/README.md.
 */

import type { OpChanges } from "@generated/anki/collection_pb";
import type { BrowserColumns_Column, BrowserRow, SortOrder } from "@generated/anki/search_pb";

import type { MenuEntry } from "../app/menus";
import type { Shortcut } from "../app/shortcuts";

export class Hook<Args extends unknown[]> {
    private listeners: ((...args: Args) => void | Promise<void>)[] = [];

    /** Adds a listener; returns a function that removes it. */
    append(listener: (...args: Args) => void | Promise<void>): () => void {
        this.listeners.push(listener);
        return () => this.remove(listener);
    }

    remove(listener: (...args: Args) => void | Promise<void>): void {
        this.listeners = this.listeners.filter((l) => l !== listener);
    }

    count(): number {
        return this.listeners.length;
    }

    run(...args: Args): void {
        for (const listener of [...this.listeners]) {
            try {
                void Promise.resolve(listener(...args)).catch((err) => console.error("plugin hook failed", err));
            } catch (err) {
                console.error("plugin hook failed", err);
            }
        }
    }

    /** Runs the listeners in turn, waiting for those that return a promise. */
    async runAsync(...args: Args): Promise<void> {
        for (const listener of [...this.listeners]) {
            try {
                await listener(...args);
            } catch (err) {
                console.error("plugin hook failed", err);
            }
        }
    }
}

export class Filter<Value, Args extends unknown[] = []> {
    private listeners: ((value: Value, ...args: Args) => Value)[] = [];

    append(listener: (value: Value, ...args: Args) => Value): () => void {
        this.listeners.push(listener);
        return () => this.remove(listener);
    }

    remove(listener: (value: Value, ...args: Args) => Value): void {
        this.listeners = this.listeners.filter((l) => l !== listener);
    }

    count(): number {
        return this.listeners.length;
    }

    run(value: Value, ...args: Args): Value {
        for (const listener of [...this.listeners]) {
            try {
                value = listener(value, ...args);
            } catch (err) {
                console.error("plugin filter failed", err);
            }
        }
        return value;
    }
}

export type MainState = "startup" | "profiles" | "deckBrowser" | "overview" | "review";
export type CardSide = "reviewQuestion" | "reviewAnswer" | "previewQuestion" | "previewAnswer" | "clayoutQuestion" | "clayoutAnswer";

/** What a card is being rendered for, passed to card and field filters. */
export interface CardContext {
    cardId: bigint;
    noteId: bigint;
    ord: number;
    /** Field values by name. */
    fields: Record<string, string>;
    questionSide: boolean;
}

/** A button in a bottom bar: [shortcut, command, label], as on desktop. */
export type BarLink = [key: string, cmd: string, label: string];

/** The editor in a window or the browser, given to editor hooks (desktop's Editor). */
export interface EditorContext {
    /** The editor page's window. */
    frame: Window;
    mode: "add" | "current" | "browser";
    /** Surrounds the selection in the focused field (desktop's editor.web.eval("wrap(...)")). */
    wrap(before: string, after: string): void;
    /** Replaces the selection in the focused field with HTML. */
    insertHtml(html: string): void;
    /** The selected text in the focused field. */
    selectedText(): string;
    /** Runs document.execCommand in the editor page. */
    execCommand(command: string, value?: string): void;
    /**
     * Remembers the focused field and selection; the function returned restores
     * them, e.g. after a dialog, once the dialog has given focus back.
     */
    keepSelection(): () => Promise<void>;
}

/** A button added to the editor toolbar (desktop's editor.addButton). */
export interface EditorButton {
    id: string;
    /** Text or HTML shown on the button, e.g. an inline SVG. */
    label: string;
    tip?: string;
    /** A shortcut, written as in shortcuts.ts. */
    keys?: string;
    onClick: (editor: EditorContext) => void;
}

export type EditorShortcut = [key: string, handler: (editor: EditorContext) => void];

/** The open browser, given to browser hooks (desktop's Browser). */
export interface BrowserPluginContext {
    notesMode(): boolean;
    /** Saves the note being edited first, so operations see its changes. */
    selectedNoteIds(): Promise<bigint[]>;
    selectedCardIds(): Promise<bigint[]>;
    search(text: string): Promise<void>;
}

/** The browser's search, before it runs (desktop's SearchContext). */
export interface BrowserSearchContext {
    search: string;
    /** Set to a custom order to sort by a plugin's column. */
    order: SortOrder;
    readonly notesMode: boolean;
    readonly sortColumn: string;
    readonly reverse: boolean;
}

export const hooks = {
    // main window
    stateWillChange: new Hook<[newState: MainState, oldState: MainState]>(),
    stateDidChange: new Hook<[newState: MainState, oldState: MainState]>(),
    /** Called with the main menu's sections, before it is shown. */
    mainMenuWillShow: new Hook<[sections: { title: string; items: MenuEntry[] }[]]>(),
    operationDidExecute: new Hook<[changes: OpChanges, initiator: unknown]>(),
    /** Called with the shortcuts of the screen being shown (keys can be changed in place). */
    stateShortcutsWillChange: new Hook<[state: MainState, shortcuts: Shortcut[]]>(),
    /** As stateShortcutsWillChange, for the shortcuts that work on every screen. */
    globalShortcutsWillChange: new Hook<[shortcuts: Shortcut[]]>(),
    profileDidOpen: new Hook<[name: string]>(),
    profileWillClose: new Hook<[name: string]>(),
    syncWillStart: new Hook<[]>(),
    syncDidFinish: new Hook<[]>(),

    // deck browser and overview
    deckBrowserDidRender: new Hook<[]>(),
    /** Called with an element below the deck list to add content to; it is emptied on each render. */
    deckBrowserWillRenderContent: new Hook<[content: HTMLElement]>(),
    deckBrowserWillShowOptionsMenu: new Hook<[menu: MenuEntry[], deckId: bigint]>(),
    overviewDidRefresh: new Hook<[]>(),
    /** As deckBrowserWillRenderContent, below the overview's study table. */
    overviewWillRenderContent: new Hook<[content: HTMLElement, deckId: bigint]>(),
    overviewWillRenderBottom: new Filter<BarLink[]>(),

    // reviewer
    cardWillShow: new Filter<string, [card: CardContext, kind: CardSide]>(),
    /** Desktop's field_filter: applies a custom {{filter:Field}}. */
    fieldFilter: new Filter<string, [fieldName: string, filterName: string, card: CardContext]>(),
    reviewerDidShowQuestion: new Hook<[card: CardContext]>(),
    reviewerDidShowAnswer: new Hook<[card: CardContext]>(),
    reviewerWillAnswerCard: new Filter<[proceed: boolean, ease: number], [card: CardContext]>(),
    reviewerDidAnswerCard: new Hook<[card: CardContext, ease: number]>(),
    reviewerWillShowContextMenu: new Hook<[menu: MenuEntry[]]>(),
    reviewerWillEnd: new Hook<[]>(),
    /** Desktop's bridge commands the reviewer does not know, e.g. pycmd("myaddon:x"). */
    webviewDidReceiveBridgeCommand: new Filter<[handled: boolean, result: unknown], [cmd: string, context: string]>(),

    // editor
    editorDidLoadNote: new Hook<[frame: Window]>(),
    /** Called when an editor loads; add buttons to the list (desktop's editor_did_init_buttons). */
    editorDidInitButtons: new Hook<[buttons: EditorButton[], editor: EditorContext]>(),
    editorDidInitShortcuts: new Hook<[shortcuts: EditorShortcut[], editor: EditorContext]>(),

    // browser
    /** Add columns to the list; their cells are filled in by browserDidFetchRow. Listeners may be async. */
    browserDidFetchColumns: new Hook<[columns: BrowserColumns_Column[]]>(),
    /** Fill in the cells of plugin columns; listeners may be async. */
    browserDidFetchRow: new Hook<[id: bigint, isNote: boolean, row: BrowserRow, columns: string[]]>(),
    browserWillSearch: new Hook<[context: BrowserSearchContext]>(),
    /** Called with the browser's menus before they are shown (desktop's browser_menus_did_init). */
    browserMenusWillShow: new Hook<[sections: { title: string; items: MenuEntry[] }[], browser: BrowserPluginContext]>(),
    browserDidInitShortcuts: new Hook<[shortcuts: [key: string, handler: () => void][], browser: BrowserPluginContext]>(),
};

export type Hooks = typeof hooks;
