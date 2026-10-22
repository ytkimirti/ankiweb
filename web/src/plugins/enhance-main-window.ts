// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Enhance main window, AnkiWeb 877182321: more columns in the deck list, in
 * place of the New, Learn and Due ones: what is due today, learning cards
 * now and later, reviews today and beyond the limit, unseen cards, buried
 * and suspended cards, notes and cards, mature and young cards, marked
 * notes, today's reviews, flags, the options group, and bars of today's work
 * and of the deck's make-up. As in the original, a deck without unseen cards
 * is named in red and its parents in green unless its name holds the end
 * symbol ";" (or "/" or "="), and decks with marked notes get a background.
 * Every column of the original can be turned on or off in Config; counts
 * include subdecks.
 */

import type { DeckTreeNode } from "@generated/anki/decks_pb";

import type { Plugin, PluginApi } from "$web/plugins/loader";

/** The original's columns, in its order; `present` is its default. */
export const COLUMNS: { name: string; header: string; description: string; present: boolean; color?: string }[] = [
    { name: "today", header: "Today", description: "Number of reviews you will see today (new, review and learning)", present: true, color: "red" },
    { name: "cards seen today", header: "Seen today", description: "Cards you'll see today which are not new", present: false, color: "red" },
    { name: "learning card", header: "Learning", description: "Cards in learning", present: false, color: "learn" },
    { name: "learning later", header: "Learning later", description: "Learning cards due later", present: false, color: "learn" },
    {
        name: "learning all",
        header: "Learning",
        description: "Cards in learning which are due now (and in parentheses, the number of reviews which are due later)",
        present: true,
        color: "learn",
    },
    { name: "learning now", header: "Learning now", description: "Cards in learning which are due now", present: false, color: "learn" },
    { name: "review", header: "Review", description: "Review cards you will see today (and the ones you will not see today)", present: true, color: "review" },
    { name: "review due", header: "Due", description: "Review cards which are due today (not counting those in learning)", present: false, color: "review" },
    { name: "review today", header: "Review today", description: "Review cards you will see today", present: false, color: "review" },
    {
        name: "unseen new",
        header: "Unseen",
        description: "Unseen cards you will see today, followed by the unseen cards that you will not see today",
        present: true,
        color: "new",
    },
    { name: "unseen", header: "Unseen", description: "Cards that have never been answered. Neither buried nor suspended.", present: false, color: "new" },
    { name: "new today", header: "New", description: "Unseen cards you will see today (what Anki calls New cards)", present: false, color: "new" },
    { name: "buried/suspended", header: "Buried/<br>Suspended", description: "Number of buried cards/number of suspended cards", present: true, color: "buried" },
    { name: "buried", header: "Buried", description: "Number of buried cards", present: false, color: "buried" },
    { name: "suspended", header: "Suspended", description: "Number of suspended cards", present: false, color: "suspended" },
    { name: "notes/cards", header: "Notes/<br>Cards", description: "Number of notes/cards in the deck", present: true, color: "fg" },
    { name: "cards", header: "Cards", description: "Number of cards in the deck", present: false, color: "fg" },
    { name: "notes", header: "Notes", description: "Number of notes in the deck", present: false, color: "fg" },
    {
        name: "mature/young",
        header: "Mature/<br>Young",
        description: "Number of reviewed cards with interval at least 3 weeks/less than 3 weeks",
        present: true,
    },
    { name: "undue", header: "Undue", description: "Number of reviewed cards which are not yet due", present: false },
    { name: "mature", header: "Mature", description: "Number of reviewed cards with interval at least 3 weeks", present: false },
    { name: "young", header: "Young", description: "Number of reviewed cards with interval less than 3 weeks", present: false },
    { name: "marked", header: "Marked", description: "Number of marked notes", present: true, color: "purple" },
    { name: "leech", header: "Leech", description: "Number of notes with a leech card", present: false, color: "purple" },
    { name: "reviewed today", header: "Reviewed today", description: "Number of reviewed cards seen today", present: false, color: "magenta" },
    { name: "repeated today", header: "Repeated today", description: "Number of reviews done today", present: false, color: "magenta" },
    {
        name: "reviewed today/repeated today",
        header: "Reviewed/<br>Repeated<br>today",
        description: "Number of reviewed cards seen today and number of reviews",
        present: true,
        color: "magenta",
    },
    { name: "repeated", header: "Repeated", description: "Number of times you saw a question from this deck", present: true },
    { name: "bar today", header: "Today", description: "Percent bar to do today", present: true },
    { name: "bar total", header: "Total", description: "Percent bar showing the decks' repartition", present: true },
    { name: "due tomorrow", header: "Due<br>tomorrow", description: "Reviewed cards which are due tomorrow", present: true, color: "review" },
    { name: "all flags", header: "Flags", description: "Flags from 0 to 4", present: false },
    { name: "flags", header: "Flags", description: "Flags from 1 to 4", present: true },
    { name: "option", header: "Options", description: "The deck's options group", present: true },
];

interface Config {
    columns: Record<string, boolean>;
    colorEmpty: boolean;
    colorMarked: boolean;
    colorEmptyName: string;
    colorEmptyDescendant: string;
    markedBackground: string;
    endedMarkedBackground: string;
    endSymbol: string;
    givenUpSymbol: string;
    pauseSymbol: string;
    /** Hides the deck list's own New, Learn and Due columns, as the original replaces them. */
    hideStockCounts: boolean;
}

const DEFAULTS: Config = {
    columns: Object.fromEntries(COLUMNS.map((c) => [c.name, c.present])),
    colorEmpty: true,
    colorMarked: true,
    colorEmptyName: "#ff0000",
    colorEmptyDescendant: "#008000",
    markedBackground: "#b0e0e6",
    endedMarkedBackground: "#ffff00",
    endSymbol: ";",
    givenUpSymbol: "/",
    pauseSymbol: "=",
    hideStockCounts: true,
};

const COLORS: Record<string, string> = {
    red: "var(--state-learn, #c35617)",
    learn: "var(--state-learn, #c35617)",
    review: "var(--state-review, #00a000)",
    new: "var(--state-new, #0070f0)",
    buried: "var(--state-buried, #a0a000)",
    suspended: "var(--state-suspended, #a0a000)",
    fg: "var(--fg)",
    purple: "#a050c8",
    magenta: "#d020d0",
};

/** Per deck counts (without subdecks), summed up the tree. */
export interface Counts {
    cards: number;
    unseen: number;
    buried: number;
    suspended: number;
    learning: number;
    learningLater: number;
    reviewDue: number;
    undue: number;
    mature: number;
    young: number;
    dueTomorrow: number;
    flags: number[];
    reviewedToday: number;
    repeatedToday: number;
    repeated: number;
}

export function emptyCounts(): Counts {
    return {
        cards: 0,
        unseen: 0,
        buried: 0,
        suspended: 0,
        learning: 0,
        learningLater: 0,
        reviewDue: 0,
        undue: 0,
        mature: 0,
        young: 0,
        dueTomorrow: 0,
        flags: [0, 0, 0, 0, 0, 0, 0, 0],
        reviewedToday: 0,
        repeatedToday: 0,
        repeated: 0,
    };
}

export function addCounts(into: Counts, from: Counts): void {
    for (const key of Object.keys(into) as (keyof Counts)[]) {
        if (key === "flags") {
            from.flags.forEach((n, i) => (into.flags[i] += n));
        } else {
            into[key] += from[key];
        }
    }
}

interface DeckData {
    counts: Counts;
    notes: Set<number>;
    marked: Set<number>;
    leech: Set<number>;
    node: DeckTreeNode;
    option: string;
    empty: boolean;
    emptyDescendant: boolean;
    ended: boolean;
    markedEnded: boolean;
}

/** Whether a deck's name (its last part) holds one of the symbols that stop colouring. */
export function isEnded(name: string, config: Pick<Config, "endSymbol" | "givenUpSymbol" | "pauseSymbol">): boolean {
    const last = name.split("::").pop() ?? name;
    return [config.endSymbol, config.givenUpSymbol, config.pauseSymbol].some((s) => s && last.includes(s));
}

/** "a (b)", leaving out the part in parentheses when it is 0. */
export function withLater(now: number, later: number): string {
    return later > 0 ? `${now} (${later})` : String(now);
}

async function collect(api: PluginApi, config: Config): Promise<Map<string, DeckData>> {
    const timing = await api.backend.schedTimingToday({});
    const today = timing.daysElapsed;
    const now = Math.floor(Date.now() / 1000);
    const dayStart = (Number(timing.nextDayAt) - 86400) * 1000;
    const tree = await api.backend.deckTree({ now: BigInt(now) });
    const own = new Map<string, Counts>();
    const counts = (did: unknown) => {
        const key = String(did);
        if (!own.has(key)) {
            own.set(key, emptyCounts());
        }
        return own.get(key)!;
    };
    const rows = await api.db.all(
        `select did, count(),
            sum(type = 0 and queue >= 0),
            sum(queue in (-2, -3)),
            sum(queue = -1),
            sum(queue in (1, 3)),
            sum((queue = 1 and due > ?) or (queue = 3 and due > ?)),
            sum(queue = 2 and due <= ?),
            sum(queue = 2 and due > ?),
            sum(type in (2, 3) and ivl >= 21),
            sum(type in (2, 3) and ivl > 0 and ivl < 21),
            sum(queue in (2, 3) and due = ?),
            sum((flags & 7) = 0), sum((flags & 7) = 1), sum((flags & 7) = 2), sum((flags & 7) = 3), sum((flags & 7) = 4)
         from cards group by did`,
        now,
        today,
        today,
        today,
        today + 1,
    );
    for (const row of rows) {
        const c = counts(row[0]);
        const n = row.map((v) => Number(v) || 0);
        [c.cards, c.unseen, c.buried, c.suspended, c.learning, c.learningLater, c.reviewDue, c.undue, c.mature, c.young, c.dueTomorrow] = n.slice(1, 12);
        c.flags = [...n.slice(12, 17), 0, 0, 0];
    }
    for (const row of await api.db.all(
        "select c.did, count(distinct r.cid), count() from revlog r join cards c on c.id = r.cid where r.id > ? group by c.did",
        dayStart,
    )) {
        const c = counts(row[0]);
        c.reviewedToday = Number(row[1]) || 0;
        c.repeatedToday = Number(row[2]) || 0;
    }
    for (const row of await api.db.all("select c.did, count() from revlog r join cards c on c.id = r.cid group by c.did")) {
        counts(row[0]).repeated = Number(row[1]) || 0;
    }
    const notesByDeck = new Map<string, number[]>();
    for (const [did, nid] of await api.db.all("select distinct did, nid from cards")) {
        const key = String(did);
        const list = notesByDeck.get(key);
        if (list) {
            list.push(Number(nid));
        } else {
            notesByDeck.set(key, [Number(nid)]);
        }
    }
    const marked = new Set((await api.db.all("select id from notes where lower(tags) like '% marked %'")).map((r) => Number(r[0])));
    const leech = new Set((await api.db.all("select id from notes where lower(tags) like '% leech %'")).map((r) => Number(r[0])));
    const optionNames = new Map<string, string>();

    const out = new Map<string, DeckData>();
    const visit = async (node: DeckTreeNode, endedParent: boolean): Promise<DeckData> => {
        const ended = endedParent || isEnded(node.name, config);
        const data: DeckData = {
            counts: emptyCounts(),
            notes: new Set(notesByDeck.get(String(node.deckId)) ?? []),
            marked: new Set(),
            leech: new Set(),
            node,
            option: "",
            empty: false,
            emptyDescendant: false,
            ended,
            markedEnded: false,
        };
        addCounts(data.counts, own.get(String(node.deckId)) ?? emptyCounts());
        for (const child of node.children) {
            const sub = await visit(child, ended);
            addCounts(data.counts, sub.counts);
            sub.notes.forEach((nid) => data.notes.add(nid));
            data.emptyDescendant ||= (sub.empty || sub.emptyDescendant) && !sub.ended;
            data.markedEnded ||= sub.markedEnded || (sub.ended && sub.marked.size > 0);
        }
        data.notes.forEach((nid) => {
            if (marked.has(nid)) {
                data.marked.add(nid);
            }
            if (leech.has(nid)) {
                data.leech.add(nid);
            }
        });
        data.empty = data.counts.unseen === 0;
        if (!node.filtered) {
            const deck = await api.backend.getDeck({ did: node.deckId });
            const dcid = deck.kind.case === "normal" ? deck.kind.value.configId : 1n;
            const key = String(dcid);
            if (!optionNames.has(key)) {
                optionNames.set(key, (await api.backend.getDeckConfig({ dcid })).name);
            }
            data.option = optionNames.get(key)!;
        }
        out.set(String(node.deckId), data);
        return data;
    };
    for (const child of tree.children) {
        await visit(child, false);
    }
    return out;
}

function bar(parts: [number, string, string][]): HTMLElement {
    const total = parts.reduce((sum, [n]) => sum + n, 0);
    const el = document.createElement("div");
    el.className = "emw-bar";
    for (const [n, background, title] of parts) {
        if (n > 0 && total > 0) {
            const part = document.createElement("span");
            part.style.width = `${(100 * n) / total}%`;
            part.style.background = background;
            part.title = `${title}: ${n} (${Math.round((100 * n) / total)}%)`;
            el.append(part);
        }
    }
    return el;
}

function cell(name: string, d: DeckData): HTMLElement | string {
    const c = d.counts;
    const node = d.node;
    const pct = (n: number) => (c.cards ? ` (${Math.round((100 * n) / c.cards)}%)` : "");
    switch (name) {
        case "today":
            return String(node.newCount + node.learnCount + node.reviewCount);
        case "cards seen today":
            return String(node.learnCount + node.reviewCount);
        case "learning card":
            return String(c.learning);
        case "learning later":
            return String(c.learningLater);
        case "learning all":
            return withLater(node.learnCount, c.learningLater);
        case "learning now":
            return String(node.learnCount);
        case "review":
            return withLater(node.reviewCount, Math.max(0, c.reviewDue - node.reviewCount));
        case "review due":
            return String(c.reviewDue);
        case "review today":
            return String(node.reviewCount);
        case "unseen new":
            return withLater(node.newCount, Math.max(0, c.unseen - node.newCount));
        case "unseen":
            return String(c.unseen);
        case "new today":
            return String(node.newCount);
        case "buried/suspended":
            return `${c.buried}/${c.suspended}`;
        case "buried":
            return String(c.buried);
        case "suspended":
            return String(c.suspended);
        case "notes/cards":
            return `${d.notes.size}/${c.cards}`;
        case "cards":
            return String(c.cards);
        case "notes":
            return String(d.notes.size);
        case "mature/young":
            return `${c.mature}/${c.young}`;
        case "undue":
            return String(c.undue);
        case "mature":
            return String(c.mature);
        case "young":
            return String(c.young);
        case "marked":
            return `${d.marked.size}${d.marked.size ? pct(d.marked.size) : ""}`;
        case "leech":
            return `${d.leech.size}${d.leech.size ? pct(d.leech.size) : ""}`;
        case "reviewed today":
            return String(c.reviewedToday);
        case "repeated today":
            return String(c.repeatedToday);
        case "reviewed today/repeated today":
            return `${c.reviewedToday}/${c.repeatedToday}`;
        case "repeated":
            return String(c.repeated);
        case "bar today":
            return bar([
                [node.reviewCount, COLORS.review, "Review"],
                [c.learning, COLORS.learn, "Learning"],
                [node.newCount, COLORS.new, "New"],
                [c.reviewedToday, "#909090", "Reviewed today"],
            ]);
        case "bar total":
            return bar([
                [c.mature, "#007700", "Mature"],
                [c.young, "#77cc77", "Young"],
                [c.learning, COLORS.learn, "Learning"],
                [c.unseen, COLORS.new, "Unseen"],
                [c.buried, "#c0c000", "Buried"],
                [c.suspended, "#e0d000", "Suspended"],
            ]);
        case "due tomorrow":
            return String(c.dueTomorrow);
        case "all flags":
        case "flags": {
            const span = document.createElement("span");
            const from = name === "all flags" ? 0 : 1;
            const colors = ["var(--fg)", "var(--flag-1, #e25252)", "var(--flag-2, #ffb347)", "var(--flag-3, #54c414)", "var(--flag-4, #578cff)"];
            for (let i = from; i <= 4; i++) {
                const flag = document.createElement("span");
                flag.textContent = String(c.flags[i]);
                flag.style.color = colors[i];
                span.append(flag, i < 4 ? " " : "");
            }
            return span;
        }
        case "option":
            return d.option;
        default:
            return "";
    }
}

const CSS = `
.deck-browser table.decks.emw-hide-stock th.count, .deck-browser table.decks.emw-hide-stock td.count-cell { display: none; }
/* centred while it fits, scrollable from its start when the columns make it wider than the window */
.deck-browser table.decks.emw-on { align-self: flex-start; margin-inline: auto; }
.deck-browser th.emw-col { font-weight: bold; font-size: 0.85em; padding: 0 6px 5px; white-space: nowrap; text-align: center; }
.deck-browser td.emw-cell { padding: 4px 6px; text-align: center; color: grey; font-variant-numeric: tabular-nums; white-space: nowrap; }
.emw-bar { display: flex; width: 80px; height: 10px; border: 1px solid var(--border); border-radius: 2px; overflow: hidden; }
.emw-bar span { display: block; height: 100%; }
.deck-browser a.deck.emw-name { border-radius: 4px; padding: 0 3px; }
`;

export default {
    name: "Enhance main window",
    setup(api) {
        const config = (): Config => {
            const saved = api.getConfig<Partial<Config>>({});
            return { ...DEFAULTS, ...saved, columns: { ...DEFAULTS.columns, ...(saved.columns ?? {}) } };
        };
        api.addStyle(CSS);
        let data = new Map<string, DeckData>();
        let version = 0;
        let observer: MutationObserver | null = null;
        let generation = 0;

        const shown = () => COLUMNS.filter((c) => config().columns[c.name]);

        /** Adds the columns to the deck table, where they are missing or stale. */
        const decorate = () => {
            const table = document.querySelector<HTMLTableElement>(".deck-browser table.decks");
            if (!table || !data.size) {
                return;
            }
            const c = config();
            const columns = shown();
            const stamp = String(version);
            table.classList.add("emw-on");
            table.classList.toggle("emw-hide-stock", c.hideStockCounts);
            const headRow = table.querySelector("thead tr");
            if (headRow && headRow.getAttribute("data-emw") !== stamp) {
                headRow.querySelectorAll(".emw-col").forEach((el) => el.remove());
                const opts = headRow.querySelector(".optscol");
                for (const column of columns) {
                    const th = document.createElement("th");
                    th.className = "emw-col";
                    th.innerHTML = column.header;
                    th.title = column.description;
                    headRow.insertBefore(th, opts);
                }
                headRow.setAttribute("data-emw", stamp);
            }
            for (const row of table.querySelectorAll<HTMLTableRowElement>("tbody tr.deck")) {
                if (row.getAttribute("data-emw") === stamp) {
                    continue;
                }
                const link = row.querySelector<HTMLAnchorElement>("a.deck");
                const id = link?.getAttribute("href")?.replace("#deck-", "");
                const deck = id ? data.get(id) : undefined;
                row.querySelectorAll(".emw-cell").forEach((el) => el.remove());
                const opts = row.querySelector("td.opts");
                if (deck) {
                    for (const column of columns) {
                        const td = document.createElement("td");
                        td.className = "emw-cell";
                        td.title = column.description;
                        const value = cell(column.name, deck);
                        td.append(value);
                        if (column.color) {
                            td.style.color = COLORS[column.color] ?? column.color;
                        }
                        row.insertBefore(td, opts);
                    }
                    if (link) {
                        const coloured = !deck.ended && c.colorEmpty;
                        link.classList.add("emw-name");
                        link.style.color = coloured && deck.empty
                            ? c.colorEmptyName
                            : coloured && deck.emptyDescendant
                            ? c.colorEmptyDescendant
                            : "";
                        const markedBackground = c.colorMarked && deck.marked.size
                            ? (deck.markedEnded ? c.endedMarkedBackground : c.markedBackground)
                            : "";
                        link.style.background = markedBackground;
                        if (markedBackground && !link.style.color) {
                            link.style.color = "black";
                        }
                    }
                }
                row.setAttribute("data-emw", stamp);
            }
        };

        const refresh = async () => {
            const token = ++generation;
            const next = await collect(api, config());
            if (token !== generation) {
                return;
            }
            data = next;
            version++;
            const content = document.querySelector(".deck-browser .content");
            if (content && !observer) {
                observer = new MutationObserver(() => decorate());
                observer.observe(content, { childList: true, subtree: true });
            }
            decorate();
        };

        api.hooks.deckBrowserDidRender.append(() => {
            void refresh().catch((err) => console.error("enhance main window", err));
        });
        api.hooks.stateWillChange.append((next) => {
            if (next !== "deckBrowser") {
                observer?.disconnect();
                observer = null;
            }
        });
        api.onUnload(() => {
            // a refresh still running finds itself stale
            generation++;
            observer?.disconnect();
            observer = null;
            document.querySelectorAll(".emw-col, .emw-cell").forEach((el) => el.remove());
            document.querySelectorAll<HTMLElement>("a.deck.emw-name").forEach((el) => {
                el.classList.remove("emw-name");
                el.style.color = el.style.background = "";
            });
            document.querySelectorAll("[data-emw]").forEach((el) => el.removeAttribute("data-emw"));
            document.querySelector(".emw-on")?.classList.remove("emw-on", "emw-hide-stock");
        });

        api.setConfigAction(async () => {
            const c = config();
            const values = await api.dialogs.openForm(
                [
                    { key: "hideStockCounts", label: "Hide the deck list's own New, Learn and Due columns", type: "checkbox", value: c.hideStockCounts },
                    ...COLUMNS.map((column) => ({
                        key: `col:${column.name}`,
                        label: `${column.header.replace(/<br>/g, " ")}: ${column.description}`,
                        type: "checkbox" as const,
                        value: c.columns[column.name] ?? false,
                    })),
                    { key: "colorEmpty", label: "Colour the names of decks without unseen cards", type: "checkbox", value: c.colorEmpty },
                    { key: "colorEmptyName", label: "Colour of decks without unseen cards", type: "color", value: c.colorEmptyName },
                    { key: "colorEmptyDescendant", label: "Colour of decks with such a subdeck", type: "color", value: c.colorEmptyDescendant },
                    { key: "colorMarked", label: "Colour the background of decks with marked notes", type: "checkbox", value: c.colorMarked },
                    { key: "markedBackground", label: "Background of decks with marked notes", type: "color", value: c.markedBackground },
                    {
                        key: "endedMarkedBackground",
                        label: "Background of decks with an ended subdeck with marked notes",
                        type: "color",
                        value: c.endedMarkedBackground,
                    },
                    { key: "endSymbol", label: "End symbol", type: "text", value: c.endSymbol },
                    { key: "givenUpSymbol", label: "Given up symbol", type: "text", value: c.givenUpSymbol },
                    { key: "pauseSymbol", label: "Pause symbol", type: "text", value: c.pauseSymbol },
                ],
                { title: "Enhance main window" },
            );
            if (values) {
                const columns: Record<string, boolean> = {};
                const rest: Record<string, unknown> = {};
                for (const [key, value] of Object.entries(values)) {
                    if (key.startsWith("col:")) {
                        columns[key.slice(4)] = !!value;
                    } else {
                        rest[key] = value;
                    }
                }
                api.setConfig({ ...c, ...rest, columns });
                api.main.reset();
            }
        });
    },
} satisfies Plugin;
