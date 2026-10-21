// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Hook points for web-native plugins, modelled on desktop's gui_hooks. A Hook
 * notifies its listeners; a Filter passes a value through each listener in
 * turn. The app calls these at the same places desktop calls its hooks, so
 * desktop add-ons can be ported hook by hook. See web/README.md.
 */

import type { OpChanges } from "@generated/anki/collection_pb";

import type { MenuEntry } from "../app/menus";

export class Hook<Args extends unknown[]> {
    private listeners: ((...args: Args) => void)[] = [];

    /** Adds a listener; returns a function that removes it. */
    append(listener: (...args: Args) => void): () => void {
        this.listeners.push(listener);
        return () => this.remove(listener);
    }

    remove(listener: (...args: Args) => void): void {
        this.listeners = this.listeners.filter((l) => l !== listener);
    }

    count(): number {
        return this.listeners.length;
    }

    run(...args: Args): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(...args);
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

export const hooks = {
    // main window
    stateWillChange: new Hook<[newState: MainState, oldState: MainState]>(),
    stateDidChange: new Hook<[newState: MainState, oldState: MainState]>(),
    /** Called with the main menu's sections, before it is shown. */
    mainMenuWillShow: new Hook<[sections: { title: string; items: MenuEntry[] }[]]>(),
    operationDidExecute: new Hook<[changes: OpChanges, initiator: unknown]>(),
    profileDidOpen: new Hook<[name: string]>(),
    profileWillClose: new Hook<[name: string]>(),
    syncWillStart: new Hook<[]>(),
    syncDidFinish: new Hook<[]>(),

    // deck browser and overview
    deckBrowserDidRender: new Hook<[]>(),
    deckBrowserWillShowOptionsMenu: new Hook<[menu: MenuEntry[], deckId: bigint]>(),
    overviewDidRefresh: new Hook<[]>(),
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
};

export type Hooks = typeof hooks;
