// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** Deck operations shared by the deck browser, overview and browser (aqt.operations.deck). */

import { DeckTreeNode, SetDeckCollapsedRequest_Scope } from "@generated/anki/decks_pb";
import {
    addDeck,
    deckTree,
    getDeck,
    getDeckIdByName,
    newDeck,
    removeDecks,
    renameDeck,
    reparentDecks,
    setCurrentDeck,
    setDeckCollapsed,
} from "@generated/backend";
import * as tr from "@generated/ftl";

import { getText, tooltip } from "./dialogs";
import { runOp } from "./run";

export function nowSeconds(): bigint {
    return BigInt(Math.floor(Date.now() / 1000));
}

export function dueTree(): Promise<DeckTreeNode> {
    return deckTree({ now: nowSeconds() });
}

export function findDeckInTree(node: DeckTreeNode, deckId: bigint): DeckTreeNode | null {
    if (node.deckId === deckId) {
        return node;
    }
    for (const child of node.children) {
        const found = findDeckInTree(child, deckId);
        if (found) {
            return found;
        }
    }
    return null;
}

export function selectDeck(deckId: bigint): Promise<unknown> {
    return runOp(() => setCurrentDeck({ did: deckId }));
}

export async function addNormalDeck(name: string): Promise<bigint | undefined> {
    return runOp(async () => {
        const existing = await getDeckIdByName({ val: name }, { alertOnError: false }).catch(() => null);
        if (existing && existing.did) {
            return existing.did;
        }
        const deck = await newDeck({});
        deck.name = name;
        return (await addDeck(deck)).id;
    });
}

export async function addDeckDialog(defaultText = ""): Promise<bigint | undefined> {
    const name = (await getText(tr.decksNewDeckName(), { value: defaultText, title: tr.decksCreateDeck() }))?.trim();
    return name ? addNormalDeck(name) : undefined;
}

export async function renameDeckDialog(deckId: bigint): Promise<void> {
    const deck = await runOp(() => getDeck({ did: deckId }));
    if (!deck) {
        return;
    }
    const newName = await getText(tr.decksNewDeckName(), { value: deck.name, title: tr.actionsRename() });
    if (newName && newName !== deck.name) {
        await runOp(() => renameDeck({ deckId, newName }));
    }
}

export async function removeDecksWithTooltip(deckIds: bigint[], deckName: string): Promise<void> {
    const out = await runOp(() => removeDecks({ dids: deckIds }));
    if (out) {
        tooltip(tr.browsingCardsDeletedWithDeckname({ count: out.count, deckName }));
    }
}

export async function reparent(deckIds: bigint[], newParent: bigint): Promise<void> {
    const out = await runOp(() => reparentDecks({ deckIds, newParent }));
    if (out) {
        tooltip(tr.browsingReparentedDecks({ count: out.count }));
    }
}

export function setCollapsed(
    deckId: bigint,
    collapsed: boolean,
    scope = SetDeckCollapsedRequest_Scope.REVIEWER,
): Promise<unknown> {
    return runOp(() => setDeckCollapsed({ deckId, collapsed, scope }));
}
