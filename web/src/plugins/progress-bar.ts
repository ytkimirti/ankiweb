// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Progress Bar for Anki, AnkiWeb 1708250053 (Shigeyuki's fork of the
 * Progress Bar add-on): a bar along the top or bottom of the main window
 * showing how much of today's studying is done, for the current deck in the
 * overview and reviewer and for all decks on the deck list. Like the
 * original, it can count progress since the app opened (its default, "type
 * A"), or today's reviews from the review log ("V3"), for the deck or for all
 * decks. New cards count double by default, and the text can show the cards
 * done, the percentage, the cards left and an estimate of the minutes left.
 */

import type { DeckTreeNode } from "@generated/anki/decks_pb";
import { get } from "svelte/store";

import type { MainState } from "$web/plugins/hooks";
import type { Plugin, PluginApi } from "$web/plugins/loader";

type BarType = "session" | "today" | "todayAll";

interface Config {
    barType: BarType;
    position: "top" | "bottom";
    showNumber: boolean;
    showPercent: boolean;
    showLeftCards: boolean;
    showLeftTime: boolean;
    includeNew: boolean;
    includeLearn: boolean;
    includeReview: boolean;
    /** Counts new cards once the reviews are done, even if includeNew is off. */
    includeNewAfterReviews: boolean;
    weightNew: number;
    weightLearn: number;
    weightReview: number;
    height: number;
    borderRadius: number;
    foregroundColor: string;
    gradientColor: string;
    useGradient: boolean;
    backgroundColor: string;
    /** Empty for the theme's text colour. */
    textColor: string;
}

/** The original's defaults (maxWidth "20" is the bar's thickness). */
export const DEFAULTS: Config = {
    barType: "session",
    position: "top",
    showNumber: false,
    showPercent: false,
    showLeftCards: true,
    showLeftTime: true,
    includeNew: true,
    includeLearn: true,
    includeReview: true,
    includeNewAfterReviews: true,
    weightNew: 2,
    weightLearn: 1,
    weightReview: 1,
    height: 20,
    borderRadius: 0,
    foregroundColor: "#3399cc",
    gradientColor: "#4cedff",
    useGradient: true,
    backgroundColor: "#00000000",
    textColor: "",
};

export interface Counts {
    newCount: number;
    learnCount: number;
    reviewCount: number;
}

/** The weighted number of cards left (the original's get_remain). */
export function remaining(counts: Counts, config: Config): number {
    let remain = 0;
    if (config.includeReview) {
        remain += counts.reviewCount * config.weightReview;
    }
    if (config.includeLearn) {
        remain += counts.learnCount * config.weightLearn;
    }
    if (config.includeNew || (config.includeNewAfterReviews && counts.reviewCount === 0)) {
        remain += counts.newCount * config.weightNew;
    }
    return remain;
}

/**
 * Progress since the app opened, by deck (the original's type A): a deck's
 * total is fixed when it is first seen, and grows only if more cards turn
 * up; what is done is the total less what remains.
 */
export class SessionProgress {
    private total = new Map<string, number>();
    private done = new Map<string, number>();

    /** `resetTotal` keeps what is done and takes the total from it and what remains. */
    update(deckId: bigint, remain: number, resetTotal: boolean): void {
        const key = String(deckId);
        const total = this.total.get(key);
        if (total === undefined) {
            this.total.set(key, remain);
            this.done.set(key, 0);
            return;
        }
        const done = this.done.get(key)!;
        if (resetTotal || remain + done > total) {
            this.total.set(key, done + remain);
        } else {
            this.done.set(key, total - remain);
        }
    }

    values(deckIds: bigint[]): { done: number; total: number } {
        let done = 0;
        let total = 0;
        for (const id of deckIds) {
            done += this.done.get(String(id)) ?? 0;
            total += this.total.get(String(id)) ?? 0;
        }
        return { done, total };
    }
}

/** The text on the bar (the original's make_bar_text). */
export function barText(
    done: number,
    max: number,
    remain: number,
    minutesLeft: number | null,
    config: Pick<Config, "showNumber" | "showPercent" | "showLeftCards" | "showLeftTime">,
): string {
    const parts: string[] = [];
    let text = "";
    if (config.showNumber) {
        text = `${done.toLocaleString("en")} / ${max.toLocaleString("en")}`;
    }
    if (config.showPercent) {
        const percent = max === 0 ? 100 : Math.floor((100 * done) / max);
        text = text ? `${text} (${percent}%)` : `${percent}%`;
    }
    if (text) {
        parts.push(text);
    }
    if (config.showLeftCards) {
        parts.push(`left ${remain.toLocaleString("en")} cards`);
    }
    if (config.showLeftTime && minutesLeft !== null) {
        parts.push(`left ${minutesLeft} min`);
    }
    return parts.join(" | ");
}

const CSS = `
.progress-bar-plugin {
    flex: none;
    position: relative;
    overflow: hidden;
    font-size: 12px;
    line-height: 1;
    user-select: none;
}
.progress-bar-plugin .pb-fill { position: absolute; inset: 0 auto 0 0; transition: width 0.3s; }
.progress-bar-plugin .pb-text {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    white-space: nowrap;
    color: var(--pb-text, var(--fg));
}
.progress-bar-plugin[hidden] { display: none; }
`;

function flatten(node: DeckTreeNode, out: DeckTreeNode[] = []): DeckTreeNode[] {
    for (const child of node.children) {
        out.push(child);
        flatten(child, out);
    }
    return out;
}

function findNode(node: DeckTreeNode, deckId: bigint): DeckTreeNode | null {
    if (node.deckId === deckId) {
        return node;
    }
    for (const child of node.children) {
        const found = findNode(child, deckId);
        if (found) {
            return found;
        }
    }
    return null;
}

/** Seconds per card over the last few days, clamped as the original's time_left. */
async function secondsPerCard(api: PluginApi, dayCutoff: number): Promise<number> {
    const row = await api.db.first("select count(), sum(time) / 1000 from revlog where id > ?", (dayCutoff - 4 * 86400) * 1000);
    const cards = Number(row?.[0] ?? 0);
    const seconds = Number(row?.[1] ?? 0);
    return cards > 0 ? Math.min(60, Math.max(3, seconds / cards)) : 3;
}

export default {
    name: "Progress Bar",
    setup(api) {
        const config = (): Config => ({ ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) });
        const session = new SessionProgress();
        let averageSeconds: number | null = null;
        let generation = 0;
        api.addStyle(CSS);

        const bar = document.createElement("div");
        bar.className = "progress-bar-plugin";
        bar.setAttribute("role", "progressbar");
        bar.setAttribute("aria-label", "Progress");
        const fill = document.createElement("div");
        fill.className = "pb-fill";
        const label = document.createElement("div");
        label.className = "pb-text";
        bar.append(fill, label);
        api.onUnload(() => bar.remove());

        function place(state: MainState): void {
            const app = document.querySelector(".app");
            const main = app?.querySelector(":scope > main.main");
            const studying = state === "deckBrowser" || state === "overview" || state === "review";
            if (!app || !main || !studying) {
                bar.remove();
                return;
            }
            const { position } = config();
            if (position === "bottom") {
                if (bar.previousElementSibling !== main) {
                    main.after(bar);
                }
            } else if (bar.nextElementSibling !== main) {
                main.before(bar);
            }
        }

        function style(): void {
            const c = config();
            bar.style.height = `${Math.max(2, Number(c.height) || DEFAULTS.height)}px`;
            bar.style.background = c.backgroundColor;
            fill.style.borderRadius = bar.style.borderRadius = `${Number(c.borderRadius) || 0}px`;
            fill.style.background = c.useGradient
                ? `linear-gradient(90deg, ${c.foregroundColor}, ${c.gradientColor}, ${c.foregroundColor})`
                : c.foregroundColor;
            bar.style.setProperty("--pb-text", c.textColor || "var(--fg)");
            // a bar too thin for text shows none
            label.hidden = (Number(c.height) || DEFAULTS.height) < 10;
        }

        async function update(resetTotal: boolean): Promise<void> {
            const token = ++generation;
            const state = get(api.main.mainState);
            if (state !== "deckBrowser" && state !== "overview" && state !== "review") {
                bar.remove();
                return;
            }
            const c = config();
            const tree = await api.backend.deckTree({ now: BigInt(Math.floor(Date.now() / 1000)) });
            const timing = await api.backend.schedTimingToday({});
            const dayCutoff = Number(timing.nextDayAt);
            for (const node of flatten(tree)) {
                session.update(node.deckId, remaining(node, c), resetTotal);
            }
            const current = state === "deckBrowser" || c.barType === "todayAll"
                ? null
                : (await api.backend.getCurrentDeck({})).id;
            const node = current === null ? null : findNode(tree, current);
            const topLevel = tree.children;
            const deckIds = node ? [node.deckId, ...flatten(node).map((n) => n.deckId)] : [];

            let done: number;
            let max: number;
            if (c.barType === "session") {
                const values = node ? session.values([node.deckId]) : session.values(topLevel.map((n) => n.deckId));
                done = values.done;
                max = values.total;
            } else {
                const counts = node ? [node] : topLevel;
                const remain = counts.reduce((sum, n) => sum + remaining(n, c), 0);
                const filtered = node?.filtered ?? false;
                const inDecks = deckIds.length
                    ? ` and (c.did in (${deckIds.join(",")})${filtered ? " or r.type = 3" : ""})`
                    : "";
                done = Number(
                    await api.db.scalar(
                        `select count() from revlog r join cards c on r.cid = c.id
                         where r.id > ? and r.ease > 0 and r.time >= 1${inDecks}`,
                        (dayCutoff - 86400) * 1000,
                    ),
                ) || 0;
                max = done + remain;
            }
            const remain = Math.max(0, max - done);
            if (max <= 0) {
                max = 1;
                done = 1;
            }
            if (c.showLeftTime && averageSeconds === null) {
                averageSeconds = await secondsPerCard(api, dayCutoff);
            }
            if (token !== generation) {
                return;
            }
            place(state);
            const minutes = averageSeconds === null ? null : Math.max(0, Math.floor((remain * averageSeconds) / 60));
            style();
            fill.style.width = `${Math.min(100, (100 * done) / max)}%`;
            bar.setAttribute("aria-valuemin", "0");
            bar.setAttribute("aria-valuemax", String(max));
            bar.setAttribute("aria-valuenow", String(done));
            label.textContent = barText(done, max, remain, minutes, c);
        }

        const refresh = (resetTotal: boolean) => void update(resetTotal).catch((err) => console.error("progress bar", err));
        api.hooks.stateDidChange.append(() => {
            averageSeconds = null;
            refresh(true);
        });
        api.hooks.reviewerDidShowQuestion.append(() => refresh(false));
        api.hooks.deckBrowserDidRender.append(() => refresh(false));
        api.hooks.overviewDidRefresh.append(() => refresh(false));
        refresh(true);

        api.setConfigAction(async () => {
            const c = config();
            const values = await api.dialogs.openForm(
                [
                    {
                        key: "barType",
                        label: "Count",
                        type: "select",
                        value: c.barType,
                        options: [
                            { value: "session", label: "Cards done since the app opened" },
                            { value: "today", label: "Today's reviews, in the current deck" },
                            { value: "todayAll", label: "Today's reviews, in all decks" },
                        ],
                    },
                    {
                        key: "position",
                        label: "Position",
                        type: "select",
                        value: c.position,
                        options: [{ value: "top", label: "Top" }, { value: "bottom", label: "Bottom" }],
                    },
                    { key: "showNumber", label: "Show cards done", type: "checkbox", value: c.showNumber },
                    { key: "showPercent", label: "Show percentage", type: "checkbox", value: c.showPercent },
                    { key: "showLeftCards", label: "Show cards left", type: "checkbox", value: c.showLeftCards },
                    { key: "showLeftTime", label: "Show minutes left", type: "checkbox", value: c.showLeftTime },
                    { key: "includeNew", label: "Count new cards", type: "checkbox", value: c.includeNew },
                    {
                        key: "includeNewAfterReviews",
                        label: "Count new cards once reviews are done",
                        type: "checkbox",
                        value: c.includeNewAfterReviews,
                    },
                    { key: "includeLearn", label: "Count learning cards", type: "checkbox", value: c.includeLearn },
                    { key: "includeReview", label: "Count review cards", type: "checkbox", value: c.includeReview },
                    { key: "weightNew", label: "Weight of a new card", type: "number", value: c.weightNew, min: 0, max: 10 },
                    { key: "weightLearn", label: "Weight of a learning card", type: "number", value: c.weightLearn, min: 0, max: 10 },
                    { key: "weightReview", label: "Weight of a review card", type: "number", value: c.weightReview, min: 0, max: 10 },
                    { key: "height", label: "Thickness (px)", type: "number", value: c.height, min: 2, max: 60 },
                    { key: "borderRadius", label: "Corner radius (px)", type: "number", value: c.borderRadius, min: 0, max: 30 },
                    { key: "foregroundColor", label: "Bar colour", type: "color", value: c.foregroundColor },
                    { key: "useGradient", label: "Gradient", type: "checkbox", value: c.useGradient },
                    { key: "gradientColor", label: "Gradient middle colour", type: "color", value: c.gradientColor },
                ],
                { title: "Progress Bar" },
            );
            if (values) {
                api.setConfig({ ...c, ...values });
                refresh(true);
            }
        });
    },
} satisfies Plugin;
