// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Review Heatmap, AnkiWeb 1771074083: a calendar heatmap of past reviews and
 * of cards coming due, with streak stats, below the deck list (whole
 * collection) and the overview (that deck and its subdecks). Clicking a day
 * shows its cards in the browser. Its options follow the original's: where
 * it shows, colour theme, a yearly or continuous view, and history and
 * forecast limits.
 */

import { SearchNode } from "@generated/anki/search_pb";

import type { Plugin, PluginApi } from "$web/plugins/loader";

const DAY_MS = 86_400_000;

const THEMES: Record<string, string[]> = {
    lime: [
        "#d6e685",
        "#c3dc76",
        "#a8d06a",
        "#8cc665",
        "#6fb352",
        "#58a043",
        "#44a340",
        "#2f8c30",
        "#1e6823",
        "#0f4a15",
    ],
    olive: [
        "#e3e3b8",
        "#d5d69a",
        "#c5c87c",
        "#b3b863",
        "#a0a64c",
        "#8b9139",
        "#767c2a",
        "#61661e",
        "#4c5014",
        "#383b0b",
    ],
    ice: ["#d6eaf8", "#bcdcf2", "#a1cdeb", "#85bde3", "#69abd9", "#4f98cc", "#3884bc", "#2570a8", "#165c91", "#0a4876"],
    magenta: [
        "#f8d3ee",
        "#f2b7e3",
        "#ea98d6",
        "#df7ac7",
        "#d25cb6",
        "#c041a3",
        "#a92b8e",
        "#901b78",
        "#760f62",
        "#5c074c",
    ],
    flame: [
        "#ffe9a8",
        "#ffd780",
        "#ffc15e",
        "#ffa844",
        "#ff8d33",
        "#f86f28",
        "#e95421",
        "#d13b1b",
        "#b32414",
        "#93110e",
    ],
};
/** Cards coming due, in every theme. */
const FUTURE = [
    "#dde3ea",
    "#cbd3dd",
    "#b8c3d0",
    "#a4b2c3",
    "#90a1b5",
    "#7c90a7",
    "#687f99",
    "#556e8b",
    "#425d7c",
    "#304c6d",
];
/** Multiples of max(20, daily average) where the colour steps up, as in the original. */
const STEPS = [0.125, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];

interface Config {
    deckBrowser: boolean;
    overview: boolean;
    theme: string;
    mode: "year" | "months";
    /** Days of history to show; 0 for all. */
    historyDays: number;
    /** Days of forecast to show; 0 for all. */
    forecastDays: number;
    excludeRescheduled: boolean;
    excludeDeleted: boolean;
}

const DEFAULTS: Config = {
    deckBrowser: true,
    overview: true,
    theme: "lime",
    mode: "year",
    historyDays: 0,
    forecastDays: 0,
    excludeRescheduled: true,
    excludeDeleted: false,
};

interface Activity {
    /** Reviews by days ago (0 is today), and cards due by days ahead (negative keys). */
    counts: Map<number, number>;
    /** The local date Anki counts as today. */
    today: Date;
    stats: { average: number; learnedPct: number; longest: number; current: number };
}

const CSS = `
.review-heatmap { margin: 1.5em auto 0; padding: 0.75rem 1rem; max-width: 100%; text-align: center;
    border: 1px solid var(--border-subtle); border-radius: var(--border-radius-medium, 8px);
    background: var(--canvas-elevated); user-select: none; }
.review-heatmap .rh-bar { display: flex; align-items: center; gap: 0.25rem; justify-content: center; margin-bottom: 0.4rem; }
.review-heatmap .rh-bar .rh-title { font-weight: 600; margin: 0 0.5rem; min-width: 7em; }
.review-heatmap .rh-bar button { all: unset; cursor: pointer; padding: 0 0.4rem; border-radius: 4px; color: var(--fg-subtle); line-height: 1.5; }
.review-heatmap .rh-bar button:hover { background: var(--border-subtle); color: var(--fg); }
.review-heatmap .rh-scroll { overflow-x: auto; }
.review-heatmap svg { display: block; margin: 0 auto; }
.review-heatmap svg text { fill: var(--fg-subtle); font-size: 9px; }
.review-heatmap rect.rh-day { fill: var(--border-subtle); cursor: pointer; }
.review-heatmap rect.rh-day:hover { stroke: var(--fg-subtle); stroke-width: 1px; }
.review-heatmap rect.rh-today { stroke: var(--fg); stroke-width: 1.5px; }
.review-heatmap .rh-stats { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.3rem 1.2rem; margin-top: 0.5rem; font-size: 0.9em; }
.review-heatmap .rh-stats b { color: var(--rh-accent); }
`;

const SVG = "http://www.w3.org/2000/svg";
const CELL = 11;
const GAP = 2;

function svg<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) {
        el.setAttribute(key, String(value));
    }
    return el;
}

function addDays(date: Date, days: number): Date {
    const out = new Date(date);
    out.setDate(out.getDate() + days);
    return out;
}

/** Whole days from a to b, ignoring DST shifts. */
function daysBetween(a: Date, b: Date): number {
    return Math.round(
        (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()))
            / DAY_MS,
    );
}

async function deckIds(api: PluginApi, deckId: bigint): Promise<string> {
    const names = await api.backend.getDeckAndChildNames({ did: deckId });
    return names.entries.map((e) => String(e.id)).join(",") || String(deckId);
}

async function loadActivity(api: PluginApi, config: Config, deckId: bigint | null): Promise<Activity> {
    const timing = await api.backend.schedTimingToday({});
    const cutoff = Number(timing.nextDayAt) * 1000;
    const todayNum = timing.daysElapsed;
    let revFilter = "";
    let cardFilter = "";
    if (deckId !== null) {
        const ids = await deckIds(api, deckId);
        cardFilter = ` and (did in (${ids}) or odid in (${ids}))`;
        revFilter += ` and cid in (select id from cards where did in (${ids}) or odid in (${ids}))`;
    } else if (config.excludeDeleted) {
        revFilter += " and cid in (select id from cards)";
    }
    if (config.excludeRescheduled) {
        // manual and rescheduling entries have no answer button
        revFilter += " and ease > 0";
    }
    if (config.historyDays > 0) {
        revFilter += ` and id >= ${cutoff - config.historyDays * DAY_MS}`;
    }
    const past = await api.db.all(
        `select (? - id - 1) / ${DAY_MS} as ago, count() from revlog where id < ?${revFilter} group by ago`,
        cutoff,
        cutoff,
    );
    // cards in filtered decks keep their day in odue, as prop:due reads it; a
    // preview deck also puts new cards (a position) and learning cards (a
    // timestamp) in the review queue, which the stats' forecast leaves out too
    const day = "(case when odue != 0 then odue else due end)";
    const forecastLimit = config.forecastDays > 0 ? ` and ${day} <= ${todayNum + config.forecastDays}` : "";
    const future = await api.db.all(
        `select ${day} - ? as ahead, count() from cards where queue in (2, 3) and type != 0 and ${day} > ? and ${day} < 1000000000${forecastLimit}${cardFilter} group by ahead`,
        todayNum,
        todayNum,
    );
    const counts = new Map<number, number>();
    for (const [ago, count] of past) {
        counts.set(Number(ago), Number(count));
    }
    for (const [ahead, count] of future) {
        counts.set(-Number(ahead), Number(count));
    }
    return { counts, today: new Date(cutoff - DAY_MS), stats: stats(counts) };
}

function stats(counts: Map<number, number>): Activity["stats"] {
    const days = [...counts.entries()].filter(([ago, n]) => ago >= 0 && n > 0).map(([ago]) => ago).sort((a, b) =>
        a - b
    );
    if (!days.length) {
        return { average: 0, learnedPct: 0, longest: 0, current: 0 };
    }
    const total = days.reduce((sum, ago) => sum + counts.get(ago)!, 0);
    const first = days[days.length - 1];
    let longest = 1;
    let run = 1;
    for (let i = 1; i < days.length; i++) {
        run = days[i] === days[i - 1] + 1 ? run + 1 : 1;
        longest = Math.max(longest, run);
    }
    // a day without reviews yet does not break the streak
    let current = 0;
    if (days[0] <= 1) {
        current = 1;
        while (current < days.length && days[current] === days[current - 1] + 1) {
            current++;
        }
    }
    return {
        average: Math.round(total / days.length),
        learnedPct: first === 0 ? 100 : Math.round((days.length / (first + 1)) * 100),
        longest,
        current,
    };
}

function level(count: number, average: number): number {
    const base = Math.max(20, average);
    return STEPS.filter((step) => count > step * base).length;
}

/** The first and last day shown, and its title. */
function range(config: Config, today: Date, page: number): { start: Date; end: Date; title: string } {
    if (config.mode === "months") {
        const start = new Date(today.getFullYear(), today.getMonth() - 6 + page * 9, 1);
        const end = new Date(start.getFullYear(), start.getMonth() + 9, 0);
        const fmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
        return { start, end, title: `${fmt.format(start)} to ${fmt.format(end)}` };
    }
    const year = today.getFullYear() + page;
    return { start: new Date(year, 0, 1), end: new Date(year, 11, 31), title: String(year) };
}

function drawCalendar(
    api: PluginApi,
    config: Config,
    activity: Activity,
    page: number,
    deckId: bigint | null,
): SVGSVGElement {
    const { start, end } = range(config, activity.today, page);
    const palette = THEMES[config.theme] ?? THEMES.lime;
    // weeks start on Monday
    const weekday = (d: Date) => (d.getDay() + 6) % 7;
    const firstMonday = addDays(start, -weekday(start));
    const weeks = Math.ceil((daysBetween(firstMonday, end) + 1) / 7);
    const left = 24;
    const top = 14;
    const root = svg("svg", { width: left + weeks * (CELL + GAP), height: top + 7 * (CELL + GAP) });
    const dayFmt = new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
    });
    const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short" });
    for (const [row, label] of [[0, "Mon"], [2, "Wed"], [4, "Fri"]] as const) {
        const text = svg("text", { x: 0, y: top + row * (CELL + GAP) + CELL - 2 });
        text.textContent = label;
        root.append(text);
    }
    for (let date = new Date(start); date <= end; date = addDays(date, 1)) {
        const week = Math.floor(daysBetween(firstMonday, date) / 7);
        if (date.getDate() === 1) {
            const text = svg("text", { x: left + week * (CELL + GAP), y: 9 });
            text.textContent = monthFmt.format(date);
            root.append(text);
        }
        const ago = daysBetween(date, activity.today);
        const count = activity.counts.get(ago) ?? 0;
        const rect = svg("rect", {
            class: `rh-day${ago === 0 ? " rh-today" : ""}`,
            x: left + week * (CELL + GAP),
            y: top + weekday(date) * (CELL + GAP),
            width: CELL,
            height: CELL,
            rx: 2,
        });
        if (count) {
            rect.style.fill = (ago < 0 ? FUTURE : palette)[level(count, activity.stats.average)];
        }
        const title = svg("title", {});
        title.textContent = ago < 0
            ? `${count} card${count === 1 ? "" : "s"} due on ${dayFmt.format(date)}`
            : `${count} review${count === 1 ? "" : "s"} on ${dayFmt.format(date)}`;
        rect.append(title);
        if (count) {
            rect.addEventListener("click", () => {
                const deck = deckId === null ? "" : "deck:current ";
                const search = ago < 0 ? `prop:due=${-ago}` : `prop:rated=${-ago}`;
                api.actions.openBrowser({
                    search: new SearchNode({ filter: { case: "parsableText", value: deck + search } }),
                });
            });
        }
        root.append(rect);
    }
    return root;
}

function render(api: PluginApi, content: HTMLElement, deckId: bigint | null): void {
    const config = { ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) };
    const box = document.createElement("div");
    box.className = "review-heatmap";
    box.style.setProperty("--rh-accent", (THEMES[config.theme] ?? THEMES.lime)[7]);
    content.append(box);
    let page = 0;
    void loadActivity(api, config, deckId).then((activity) => {
        const draw = () => {
            const bar = document.createElement("div");
            bar.className = "rh-bar";
            const button = (label: string, title: string, action: () => void) => {
                const el = document.createElement("button");
                el.type = "button";
                el.textContent = label;
                el.title = title;
                el.addEventListener("click", action);
                return el;
            };
            const title = document.createElement("span");
            title.className = "rh-title";
            title.textContent = range(config, activity.today, page).title;
            bar.append(
                button("◀", "Previous", () => (page--, draw())),
                title,
                button("▶", "Next", () => (page++, draw())),
                button("●", "Today", () => (page = 0, draw())),
                button("⚙", "Options", () => void configure(api)),
            );
            const scroll = document.createElement("div");
            scroll.className = "rh-scroll";
            scroll.append(drawCalendar(api, config, activity, page, deckId));
            const { average, learnedPct, longest, current } = activity.stats;
            const statsRow = document.createElement("div");
            statsRow.className = "rh-stats";
            const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
            for (
                const [label, value] of [
                    ["Daily average", `${average} review${average === 1 ? "" : "s"}`],
                    ["Days learned", `${learnedPct}%`],
                    ["Longest streak", days(longest)],
                    ["Current streak", days(current)],
                ]
            ) {
                const item = document.createElement("span");
                const b = document.createElement("b");
                b.textContent = value;
                item.append(`${label}: `, b);
                statsRow.append(item);
            }
            box.replaceChildren(bar, scroll, statsRow);
        };
        draw();
    }).catch((err) => {
        console.error("review heatmap failed", err);
        box.remove();
    });
}

async function configure(api: PluginApi): Promise<void> {
    const config = { ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) };
    const values = await api.dialogs.openForm(
        [
            { key: "deckBrowser", label: "Show on the deck list", type: "checkbox", value: config.deckBrowser },
            { key: "overview", label: "Show on the deck overview", type: "checkbox", value: config.overview },
            {
                key: "theme",
                label: "Colour theme",
                type: "select",
                value: config.theme,
                options: Object.keys(THEMES).map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) })),
            },
            {
                key: "mode",
                label: "View",
                type: "select",
                value: config.mode,
                options: [
                    { value: "year", label: "Yearly overview" },
                    { value: "months", label: "Continuous timeline" },
                ],
            },
            {
                key: "historyDays",
                label: "Days of history to show (0: all)",
                type: "number",
                value: config.historyDays,
                min: 0,
            },
            {
                key: "forecastDays",
                label: "Days of forecast to show (0: all)",
                type: "number",
                value: config.forecastDays,
                min: 0,
            },
            {
                key: "excludeRescheduled",
                label: "Leave out cards rescheduled by hand",
                type: "checkbox",
                value: config.excludeRescheduled,
            },
            {
                key: "excludeDeleted",
                label: "Leave out reviews of deleted cards",
                type: "checkbox",
                value: config.excludeDeleted,
            },
        ],
        { title: "Review Heatmap Options" },
    );
    if (values) {
        api.setConfig({ ...config, ...values });
        api.main.reset();
    }
}

export default {
    name: "Review Heatmap",
    setup(api) {
        api.addStyle(CSS);
        api.setConfigAction(() => configure(api));
        api.hooks.deckBrowserWillRenderContent.append((content) => {
            if (api.getConfig<Partial<Config>>({}).deckBrowser ?? DEFAULTS.deckBrowser) {
                render(api, content, null);
            }
        });
        api.hooks.overviewWillRenderContent.append((content, deckId) => {
            if (api.getConfig<Partial<Config>>({}).overview ?? DEFAULTS.overview) {
                render(api, content, deckId);
            }
        });
    },
} satisfies Plugin;
