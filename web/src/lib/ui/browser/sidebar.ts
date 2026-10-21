// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** The browser sidebar's tree (desktop's browser/sidebar/tree.py). */

import type { DeckTreeNode } from "@generated/anki/decks_pb";
import {
    SearchNode,
    SearchNode_CardState as CardState,
    SearchNode_Flag as Flag,
    SearchNode_Group_Joiner as Joiner,
    SearchNode_Rating as Rating,
} from "@generated/anki/search_pb";
import type { TagTreeNode } from "@generated/anki/tags_pb";
import { deckTree, getConfigJson, getNotetype, getNotetypeNamesAndCounts, tagTree } from "@generated/backend";
import * as tr from "@generated/ftl";

import { allFlags } from "$web/app/cardops";

export type ItemKind =
    | "savedSearchRoot"
    | "savedSearch"
    | "todayRoot"
    | "today"
    | "flagRoot"
    | "flag"
    | "cardStateRoot"
    | "cardState"
    | "deckRoot"
    | "deck"
    | "notetypeRoot"
    | "notetype"
    | "notetypeTemplate"
    | "notetypeField"
    | "tagRoot"
    | "tag";

export interface SidebarItem {
    key: string;
    name: string;
    kind: ItemKind;
    icon: string;
    /** CSS color for the icon. */
    color?: string;
    search?: SearchNode;
    children: SidebarItem[];
    expanded: boolean;
    /** Deck id, tag full name, notetype id, saved search name, flag index. */
    id?: bigint | string;
    /** Full deck or tag name; the part before name is its parents. */
    fullName?: string;
    /** Template or field index, for notetype children. */
    index?: number;
}

type Filter = NonNullable<ConstructorParameters<typeof SearchNode>[0]>["filter"];

const node = (filter: Filter) => new SearchNode({ filter });

export const group = (joiner: Joiner, nodes: SearchNode[]): SearchNode =>
    node({ case: "group", value: { joiner, nodes } });

const and = (...nodes: SearchNode[]) => group(Joiner.AND, nodes);

function item(
    key: string,
    name: string,
    kind: ItemKind,
    icon: string,
    search?: SearchNode,
    extra: Partial<SidebarItem> = {},
): SidebarItem {
    return { key, name, kind, icon, search, children: [], expanded: false, ...extra };
}

const SAVED_KEY = "savedFilters";

export async function savedSearches(): Promise<Record<string, string>> {
    try {
        const out = await getConfigJson({ val: SAVED_KEY }, { alertOnError: false });
        return JSON.parse(new TextDecoder().decode(out.json)) ?? {};
    } catch {
        return {};
    }
}

export const SAVED_SEARCHES_KEY = SAVED_KEY;

/** Remembers which root sections are expanded, as desktop does per collection. */
const expandedRoots = new Set<ItemKind>(["deckRoot"]);

export function setRootExpanded(kind: ItemKind, expanded: boolean): void {
    if (expanded) {
        expandedRoots.add(kind);
    } else {
        expandedRoots.delete(kind);
    }
}

export async function buildSidebar(): Promise<SidebarItem[]> {
    const [saved, decks, notetypes, tags, flags] = await Promise.all([
        savedSearches(),
        deckTree({ now: 0n }),
        getNotetypeNamesAndCounts({}),
        tagTree({}),
        allFlags(),
    ]);
    const roots: SidebarItem[] = [];

    const savedRoot = item("saved", tr.browsingSidebarSavedSearches(), "savedSearchRoot", "♡");
    savedRoot.children = Object.entries(saved)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, search]) =>
            item(`saved:${name}`, name, "savedSearch", "♡", node({ case: "parsableText", value: search }), { id: name })
        );
    roots.push(savedRoot);

    const today = item("today", tr.browsingToday(), "todayRoot", "◷");
    today.children = [
        item("today:due", tr.browsingSidebarDueToday(), "today", "◷", node({ case: "dueOnDay", value: 0 })),
        item("today:added", tr.browsingAddedToday(), "today", "◷", node({ case: "addedInDays", value: 1 })),
        item("today:edited", tr.browsingEditedToday(), "today", "◷", node({ case: "editedInDays", value: 1 })),
        item(
            "today:studied",
            tr.browsingStudiedToday(),
            "today",
            "◷",
            node({ case: "rated", value: { days: 1, rating: Rating.ANY } }),
        ),
        item("today:first", tr.browsingSidebarFirstReview(), "today", "◷", node({ case: "introducedInDays", value: 1 })),
        item(
            "today:rescheduled",
            tr.browsingSidebarRescheduled(),
            "today",
            "◷",
            node({ case: "rated", value: { days: 1, rating: Rating.BY_RESCHEDULE } }),
        ),
        item(
            "today:again",
            tr.browsingAgainToday(),
            "today",
            "◷",
            node({ case: "rated", value: { days: 1, rating: Rating.AGAIN } }),
        ),
        item(
            "today:overdue",
            tr.browsingSidebarOverdue(),
            "today",
            "◷",
            and(node({ case: "cardState", value: CardState.DUE }), node({ case: "negated", value: node({ case: "dueOnDay", value: 0 }) })),
        ),
    ];
    roots.push(today);

    const flagRoot = item("flags", tr.browsingSidebarFlags(), "flagRoot", "⚑", node({ case: "flag", value: Flag.ANY }));
    flagRoot.children = [
        item("flag:none", tr.browsingNoFlag(), "flag", "⚐", node({ case: "flag", value: Flag.NONE })),
        ...flags.map((flag) =>
            item(`flag:${flag.index}`, flag.label, "flag", "⚑", node({ case: "flag", value: flag.index + 1 }), {
                color: `var(--flag-${flag.index})`,
                id: String(flag.index),
            })
        ),
    ];
    roots.push(flagRoot);

    const stateRoot = item("states", tr.browsingSidebarCardState(), "cardStateRoot", "○");
    stateRoot.children = [
        item("state:new", tr.actionsNew(), "cardState", "●", node({ case: "cardState", value: CardState.NEW }), {
            color: "var(--state-new)",
        }),
        item("state:learn", tr.schedulingLearning(), "cardState", "●", node({ case: "cardState", value: CardState.LEARN }), {
            color: "var(--state-learn)",
        }),
        item(
            "state:review",
            tr.browsingSidebarCardStateReview(),
            "cardState",
            "●",
            node({ case: "cardState", value: CardState.REVIEW }),
            { color: "var(--state-review)" },
        ),
        item(
            "state:suspended",
            tr.browsingSuspended(),
            "cardState",
            "●",
            node({ case: "cardState", value: CardState.SUSPENDED }),
            { color: "var(--state-suspended)" },
        ),
        item("state:buried", tr.browsingBuried(), "cardState", "●", node({ case: "cardState", value: CardState.BURIED }), {
            color: "var(--state-buried)",
        }),
    ];
    roots.push(stateRoot);

    const deckRoot = item("decks", tr.browsingSidebarDecks(), "deckRoot", "▤", node({ case: "deck", value: "_*" }));
    deckRoot.children = [
        item("deck:current", tr.browsingCurrentDeck(), "deck", "▤", node({ case: "deck", value: "current" })),
        ...renderDecks(decks.children, ""),
    ];
    roots.push(deckRoot);

    const ntRoot = item("notetypes", tr.browsingSidebarNotetypes(), "notetypeRoot", "▦", node({ case: "note", value: "_*" }));
    ntRoot.children = await Promise.all(
        notetypes.entries.map(async (entry) => {
            const nt = await getNotetype({ ntid: entry.id });
            const ntItem = item(`nt:${entry.id}`, entry.name, "notetype", "▦", node({ case: "note", value: entry.name }), {
                id: entry.id,
            });
            const byName = node({ case: "note", value: entry.name });
            ntItem.children = [
                ...nt.templates.map((t, i) =>
                    item(
                        `nt:${entry.id}:t:${i}`,
                        t.name,
                        "notetypeTemplate",
                        "▭",
                        and(byName, node({ case: "template", value: i })),
                        { id: entry.id, index: i },
                    )
                ),
                ...nt.fields.map((f, i) =>
                    item(
                        `nt:${entry.id}:f:${i}`,
                        f.name,
                        "notetypeField",
                        "≡",
                        and(byName, node({ case: "fieldName", value: f.name })),
                        { id: entry.id, index: i },
                    )
                ),
            ];
            return ntItem;
        }),
    );
    roots.push(ntRoot);

    const tagRoot = item("tags", tr.browsingSidebarTags(), "tagRoot", "#", node({ case: "tag", value: "_*" }));
    tagRoot.children = [
        item("tag:untagged", tr.browsingSidebarUntagged(), "tag", "#", node({ case: "negated", value: node({ case: "tag", value: "_*" }) })),
        ...renderTags(tags.children, ""),
    ];
    roots.push(tagRoot);

    for (const root of roots) {
        root.expanded = expandedRoots.has(root.kind);
    }
    return roots;
}

function renderDecks(nodes: DeckTreeNode[], head: string): SidebarItem[] {
    return nodes.map((deck) => {
        const full = head + deck.name;
        const result = item(`deck:${deck.deckId}`, deck.name, "deck", deck.filtered ? "⚙" : "▤", node({ case: "deck", value: full }), {
            id: deck.deckId,
            fullName: full,
            expanded: !deck.collapsed,
        });
        result.children = renderDecks(deck.children, `${full}::`);
        return result;
    });
}

function renderTags(nodes: TagTreeNode[], head: string): SidebarItem[] {
    return nodes.map((tag) => {
        const full = head + tag.name;
        const result = item(`tag:${full}`, tag.name, "tag", "#", node({ case: "tag", value: full }), {
            id: full,
            fullName: full,
            expanded: !tag.collapsed,
        });
        result.children = renderTags(tag.children, `${full}::`);
        return result;
    });
}

/** Items whose name matches, with their ancestors (desktop's sidebar search). */
export function filterTree(items: SidebarItem[], text: string): SidebarItem[] {
    const needle = text.trim().toLowerCase();
    if (!needle) {
        return items;
    }
    const out: SidebarItem[] = [];
    for (const it of items) {
        const children = filterTree(it.children, needle);
        if (children.length || it.name.toLowerCase().includes(needle)) {
            out.push({ ...it, children, expanded: true });
        }
    }
    return out;
}
