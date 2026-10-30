// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Remaining time, AnkiWeb 1508357010 (trgkanki/remaining_time, 26.8.28): a
 * thin bar along the top or bottom of the reviewer and overview with the time
 * spent this sitting, the estimated time left and when you will finish. Each
 * answer adds a segment, coloured by how it went (new, correct, wrong) and as
 * wide as it took. The estimate is the original's: the work left is twice the
 * new cards plus the learning and review cards, and the pace is an
 * exponentially smoothed ratio of the work each answer cleared to the time it
 * took, capped at a cutoff, kept for each deck across sittings. A sitting
 * starts over after a long idle time or with the reset link. Until a deck has
 * a pace, the estimate uses the average answer time of the last few days,
 * where the original shows "> day".
 */

import { get } from "svelte/store";

import type { MainState } from "$web/plugins/hooks";
import type { Plugin, PluginApi } from "$web/plugins/loader";

export type LogType = "new" | "good" | "again" | "rev-good" | "rev-again" | "unknown";

export interface LogEntry {
    /** Seconds since the previous answer, or the sitting's start. */
    dt: number;
    /** Work cleared by the answer. */
    dy: number;
    type: LogType;
}

/** Decayed totals of answer time and work cleared. */
export interface Rate {
    weightedTime: number;
    weightedWork: number;
}

export interface Counts {
    newCount: number;
    learnCount: number;
    reviewCount: number;
}

interface Settings {
    showAtBottom: boolean;
    /** Seconds without answers after which a sitting starts over; 0 for never. */
    autoResetIdleSeconds: number;
    /** An answer slower than this many seconds counts as this long, clearing nothing. */
    reviewTimeCutoff: number;
    resetHotkey: string;
    resetPaceOnManualReset: boolean;
    fixedSegmentWidth: boolean;
    messageFormat: string;
    barCSS: string;
}

interface Sitting {
    /** Seconds since the epoch. */
    startTime: number;
    logs: LogEntry[];
    /** The counts at the last update, for the work the next answer cleared. */
    lastCounts: Counts | null;
}

interface Stored extends Settings {
    sitting?: Sitting;
    /** By deck id. */
    rates?: Record<string, Rate>;
}

export const DEFAULTS: Settings = {
    showAtBottom: false,
    autoResetIdleSeconds: 18000,
    reviewTimeCutoff: 300,
    resetHotkey: "",
    resetPaceOnManualReset: false,
    fixedSegmentWidth: false,
    messageFormat: "Elapsed %(elapsedTime),  Remaining %(remainingTime), ETA %(ETA)",
    barCSS: "",
};

const HISTORY_DECAY = 1 / 1.005;
const MINIMUM_RATE = 1e-6;
const LONG_SEGMENT = 1800;
const ALPHA = { clampMinTime: 10, clampMaxTime: 120, minAlpha: 0.3, maxAlpha: 0.7 };

const now = () => Date.now() / 1000;

/** The work left: new cards count twice, as they come back to learn. */
export function remainingLoad(c: Counts): number {
    return 2 * c.newCount + c.learnCount + c.reviewCount;
}

/** The sitting and the deck's pace (the original's Estimator). */
export class Estimator {
    constructor(
        public sitting: Sitting,
        public rate: Rate,
        private cutoff: number,
    ) {}

    static fresh(rate: Rate = { weightedTime: 0, weightedWork: 0 }, cutoff = DEFAULTS.reviewTimeCutoff, at = now()) {
        return new Estimator({ startTime: at, logs: [], lastCounts: null }, rate, cutoff);
    }

    elapsed(at = now()): number {
        return at - this.sitting.startTime;
    }

    lastActivity(): number {
        return this.sitting.startTime + this.sitting.logs.reduce((sum, log) => sum + log.dt, 0);
    }

    /** Starts the sitting over; the deck's pace stays. */
    reset(at = now()): void {
        this.sitting = { startTime: at, logs: [], lastCounts: this.sitting.lastCounts };
    }

    private applySample(dt: number, dy: number, sign: 1 | -1): void {
        const within = dt <= this.cutoff;
        const time = (within ? dt : this.cutoff) * (1 - HISTORY_DECAY);
        const work = (within ? dy : 0) * (1 - HISTORY_DECAY);
        const r = this.rate;
        if (sign === 1) {
            r.weightedTime = r.weightedTime * HISTORY_DECAY + time;
            r.weightedWork = r.weightedWork * HISTORY_DECAY + work;
        } else {
            r.weightedTime = (r.weightedTime - time) / HISTORY_DECAY;
            r.weightedWork = (r.weightedWork - work) / HISTORY_DECAY;
        }
    }

    update(dy: number, type: LogType, at = now()): void {
        const dt = Math.max(0, at - this.lastActivity());
        // an unusual jump in the counts should not dominate the pace
        dy = Math.max(-10, Math.min(10, dy));
        this.applySample(dt, dy, 1);
        this.sitting.logs.push({ dt, dy, type });
    }

    undo(): void {
        const removed = this.sitting.logs.pop();
        if (removed) {
            this.applySample(removed.dt, removed.dy, -1);
        }
    }

    /** Whether answers have cleared any work yet; until then the pace says nothing. */
    hasPace(): boolean {
        return this.rate.weightedTime > 0 && this.rate.weightedWork > 1e-9;
    }

    /** Work cleared per second. */
    pace(): number {
        const { weightedTime, weightedWork } = this.rate;
        return weightedTime > 0 ? Math.max(weightedWork / weightedTime, MINIMUM_RATE) : MINIMUM_RATE;
    }

    remaining(counts: Counts): number {
        return remainingLoad(counts) / this.pace();
    }
}

/** A duration as the original shows it. */
export function t2s(seconds: number): string {
    if (seconds < 60) {
        return `${seconds | 0}s`;
    }
    if (seconds < 86400) {
        return `${Math.floor(seconds / 60)}m`;
    }
    return " > day ";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The bar's text, filling in the original's %(name) variables. */
export function formatMessage(format: string, logs: LogEntry[], elapsed: number, remaining: number, at: Date): string {
    const eta = new Date(at.getTime() + remaining * 1000);
    const late = remaining >= 86400;
    const hours12 = ((eta.getHours() + 11) % 12) + 1;
    const good = logs.filter((l) => l.type === "rev-good").length;
    const again = logs.filter((l) => l.type === "rev-again").length;
    const values: Record<string, string> = {
        elapsedTime: t2s(elapsed),
        remainingTime: t2s(remaining),
        totalTime: t2s(elapsed + remaining),
        ETA: late ? "> day" : `${pad(eta.getHours())}:${pad(eta.getMinutes())}`,
        ETA12: late ? "> day" : `${pad(hours12)}:${pad(eta.getMinutes())} ${eta.getHours() >= 12 ? "PM" : "AM"}`,
        CPM: (elapsed > 0 ? (logs.length / elapsed) * 60 : 0).toFixed(2),
        RR: `${((100 * good) / (good + again)).toFixed(1)}%`,
    };
    return format.replace(/%\((\w+)\)/g, (match, name: string) => values[name] ?? match);
}

const TOOLTIPS: Record<LogType, string> = {
    new: "New card",
    good: "Correct",
    again: "Wrong",
    "rev-good": "(Review) Correct",
    "rev-again": "(Review) Wrong",
    unknown: "[unrecognized]",
};

function segmentAlpha(dt: number): number {
    if (dt > LONG_SEGMENT) {
        return ALPHA.minAlpha / 4;
    }
    if (dt < ALPHA.clampMinTime) {
        return ALPHA.maxAlpha;
    }
    if (dt > ALPHA.clampMaxTime) {
        return ALPHA.minAlpha / 2;
    }
    const t = (dt - ALPHA.clampMinTime) / (ALPHA.clampMaxTime - ALPHA.clampMinTime);
    return ALPHA.maxAlpha + (ALPHA.minAlpha - ALPHA.maxAlpha) * t;
}

/** The bar: a segment per answer, filling the part of the sitting done. */
export function barSvg(logs: LogEntry[], progress: number, fixedWidth: boolean): string {
    const total = logs.reduce((sum, l) => sum + Math.min(l.dt, LONG_SEGMENT), 0);
    let x = 0;
    const paths = logs.map((log) => {
        const dt = Math.min(log.dt, LONG_SEGMENT);
        const w = fixedWidth ? progress / logs.length : total > 0 ? (dt / total) * progress : 0;
        let path = `<path class="rt-log-segment rt-log-${log.type}" d="M${x} 0 h${w} V1 h-${w} Z" opacity="${
            segmentAlpha(log.dt)
        }"><title>${TOOLTIPS[log.type]} (${t2s(log.dt)})</title></path>`;
        if (log.dt > LONG_SEGMENT) {
            path += `<path class="rt-log-segment-truncated" d="M${x} .1 l${w} .8 Z M${x} .9 l${w} -.8 Z"/>`;
        }
        x += w;
        return path;
    });
    return `<svg class="rt-bar" viewBox="0 0 1 1" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${
        paths.join("")
    }</svg>`;
}

const CSS = `
.remaining-time-plugin { flex: none; position: relative; height: 16px; }
.remaining-time-plugin[hidden] { display: none; }
`;

const SHADOW_CSS = `
:host { display: block; }
.rt-container {
    position: relative; height: 16px; line-height: 16px; overflow: hidden;
    font-family: sans-serif; font-size: 12.8px; color: var(--fg);
    background: var(--canvas); box-sizing: border-box;
}
.rt-container.top { border-bottom: 1px solid #aaa; }
.rt-container.bottom { border-top: 1px solid #aaa; }
.rt-bar { position: absolute; inset: 0; width: 100%; height: 100%; }
.rt-message {
    position: relative; text-align: center; white-space: nowrap;
    pointer-events: none; user-select: none;
}
.rt-reset {
    pointer-events: all; color: #fa0; font-weight: bold; padding: 0 2px 1px;
    text-decoration: none; cursor: pointer;
}
.rt-log-segment { shape-rendering: crispEdges; }
.rt-log-good, .rt-log-rev-good { fill: rgb(103, 239, 79); }
.rt-log-again, .rt-log-rev-again { fill: rgb(239, 103, 79); }
.rt-log-new { fill: rgb(114, 166, 249); }
.rt-log-unknown { fill: rgb(135, 135, 135); }
.rt-log-segment-truncated { stroke: rgb(135, 135, 135); opacity: 0.7; stroke-width: 0.005; }
`;

/** Seconds per answer over the last few days, for a deck without a pace yet. */
async function averageAnswerSeconds(api: PluginApi): Promise<number> {
    const timing = await api.backend.schedTimingToday({});
    const since = (Number(timing.nextDayAt) - 4 * 86400) * 1000;
    const row = await api.db.first("select count(), sum(min(time, 60000)) / 1000.0 from revlog where id > ? and ease > 0", since);
    const cards = Number(row?.[0] ?? 0);
    const seconds = Number(row?.[1] ?? 0);
    return cards > 0 ? Math.max(1, seconds / cards) : 8;
}

/** The queue a card was in, as the original classifies answers. */
function logType(queue: number, ease: number): LogType {
    if (queue === 0) {
        return "new";
    }
    if (queue === 1 || queue === 3) {
        return ease === 1 ? "again" : "good";
    }
    if (queue === 2) {
        return ease === 1 ? "rev-again" : "rev-good";
    }
    return "unknown";
}

type Event = { kind: "answer"; type: LogType } | { kind: "undo" };

export default {
    name: "Remaining time",
    setup(api) {
        const stored = (): Stored => ({ ...DEFAULTS, ...api.getConfig<Partial<Stored>>({}) });
        const settings = (): Settings => {
            const { sitting: _s, rates: _r, ...rest } = stored();
            return rest;
        };
        api.addStyle(CSS);

        const host = document.createElement("div");
        host.className = "remaining-time-plugin";
        const shadow = host.attachShadow({ mode: "open" });
        api.onUnload(() => {
            generation++;
            host.remove();
        });

        let estimator: Estimator | null = null;
        let deckKey: string | null = null;
        /** Answers and undos since the last update (the original's event queue). */
        const pending: Event[] = [];
        let answering: { cardId: bigint; queue: number } | null = null;
        let fallbackSeconds: number | null = null;
        let generation = 0;

        const save = () => {
            if (!estimator) {
                return;
            }
            const s = stored();
            const rates = { ...s.rates };
            if (deckKey) {
                rates[deckKey] = { ...estimator.rate };
            }
            api.setConfig({ ...s, sitting: estimator.sitting, rates });
        };

        /** The estimator for the current deck: the stored sitting, with this deck's pace. */
        const load = (deckId: bigint): Estimator => {
            const key = String(deckId);
            const s = stored();
            const cutoff = Number(s.reviewTimeCutoff) || DEFAULTS.reviewTimeCutoff;
            const rate = { weightedTime: 0, weightedWork: 0, ...s.rates?.[key] };
            if (!estimator) {
                estimator = s.sitting ? new Estimator(s.sitting, rate, cutoff) : Estimator.fresh(rate, cutoff);
            } else if (key !== deckKey) {
                estimator.rate = rate;
            }
            deckKey = key;
            return estimator;
        };

        function place(state: MainState): void {
            const main = document.querySelector(".app > main.main");
            if (!main || (state !== "overview" && state !== "review")) {
                host.remove();
                return;
            }
            // stays where it is on the right side of main, so other bars there keep their places
            const placed = host.parentElement === main.parentElement;
            const before = placed && !!(host.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING);
            if (settings().showAtBottom) {
                if (!placed || before) {
                    main.after(host);
                }
            } else if (!before) {
                main.before(host);
            }
        }

        const reset = async () => {
            if (!(await api.dialogs.askUser("[Remaining time] Reset the progress bar?"))) {
                return;
            }
            if (estimator) {
                estimator.reset();
                if (settings().resetPaceOnManualReset) {
                    estimator.rate = { weightedTime: 0, weightedWork: 0 };
                }
                save();
            }
            refresh(false);
        };

        function render(e: Estimator, counts: Counts): void {
            const c = settings();
            const elapsed = e.elapsed();
            const remaining = e.hasPace() || fallbackSeconds === null
                ? e.remaining(counts)
                : remainingLoad(counts) * fallbackSeconds;
            const progress = elapsed + remaining > 0 ? elapsed / (elapsed + remaining) : 0;
            const message = formatMessage(c.messageFormat || DEFAULTS.messageFormat, e.sitting.logs, elapsed, remaining, new Date());
            shadow.innerHTML = `<style>${SHADOW_CSS}${c.barCSS}</style>
                <div class="rt-container ${c.showAtBottom ? "bottom" : "top"}">
                    ${barSvg(e.sitting.logs, Math.min(1, progress), c.fixedSegmentWidth)}
                    <div class="rt-message"></div>
                </div>`;
            const text = shadow.querySelector(".rt-message")!;
            text.textContent = `${message} `;
            const link = document.createElement("a");
            link.className = "rt-reset";
            link.title = "Reset progress bar for this deck";
            link.textContent = "[⥻]";
            link.onclick = () => void reset();
            text.append(link);
        }

        /** The original's main(): on a question or the overview, take in the answers, then draw. */
        async function update(takeAnswers: boolean): Promise<void> {
            const token = ++generation;
            const state = get(api.main.mainState);
            if (state !== "overview" && state !== "review") {
                host.remove();
                return;
            }
            const deck = await api.backend.getCurrentDeck({});
            const queued = await api.backend.getQueuedCards({ fetchLimit: 0, intradayLearningOnly: false });
            const counts: Counts = {
                newCount: queued.newCount,
                learnCount: queued.learningCount,
                reviewCount: queued.reviewCount,
            };
            if (token !== generation) {
                return;
            }
            const e = load(deck.id);
            if (takeAnswers) {
                const idle = Number(settings().autoResetIdleSeconds) || 0;
                if (idle > 0 && now() - e.lastActivity() > idle) {
                    e.reset();
                }
                const last = e.sitting.lastCounts;
                let dy = last ? remainingLoad(last) - remainingLoad(counts) : 0;
                for (const event of pending.splice(0)) {
                    if (event.kind === "undo") {
                        e.undo();
                    } else {
                        e.update(dy, event.type);
                        dy = 0;
                    }
                }
                e.sitting.lastCounts = counts;
                save();
            }
            if (!e.hasPace() && fallbackSeconds === null) {
                fallbackSeconds = await averageAnswerSeconds(api);
                if (token !== generation) {
                    return;
                }
            }
            place(state);
            render(e, counts);
        }

        const refresh = (takeAnswers: boolean) =>
            void update(takeAnswers).catch((err) => console.error("remaining time", err));

        api.hooks.reviewerWillAnswerCard.append((answer) => {
            const card = api.reviewer.card;
            answering = card ? { cardId: card.id, queue: card.queue } : null;
            return answer;
        });
        api.hooks.reviewerDidAnswerCard.append((card, ease) => {
            if (answering?.cardId === card.cardId) {
                pending.push({ kind: "answer", type: logType(answering.queue, ease) });
            }
            answering = null;
        });
        api.hooks.stateDidUndo.append((changes) => {
            if (get(api.main.mainState) === "review" && changes.changes?.card) {
                pending.push({ kind: "undo" });
            }
        });
        api.hooks.reviewerDidShowQuestion.append(() => refresh(true));
        api.hooks.overviewDidRefresh.append(() => refresh(true));
        api.hooks.stateDidChange.append((state) => {
            fallbackSeconds = null;
            if (state !== "overview" && state !== "review") {
                generation++;
                host.remove();
            }
        });
        api.hooks.stateShortcutsWillChange.append((state, shortcuts) => {
            const key = settings().resetHotkey.trim();
            if (state === "review" && key) {
                shortcuts.push([key, () => void reset()]);
            }
        });
        refresh(false);

        api.setConfigAction(async () => {
            const c = settings();
            const values = await api.dialogs.openForm(
                [
                    {
                        key: "messageFormat",
                        label: "Text: %(elapsedTime), %(remainingTime), %(totalTime), %(ETA), %(ETA12), %(CPM) (cards a minute), %(RR) (retention)",
                        type: "text",
                        value: c.messageFormat,
                    },
                    { key: "showAtBottom", label: "Show at the bottom", type: "checkbox", value: c.showAtBottom },
                    { key: "fixedSegmentWidth", label: "Same width for every answer", type: "checkbox", value: c.fixedSegmentWidth },
                    { key: "autoResetIdleSeconds", label: "Start over after this many idle seconds (0: never)", type: "number", value: c.autoResetIdleSeconds, min: 0 },
                    { key: "reviewTimeCutoff", label: "Count an answer as at most (seconds)", type: "number", value: c.reviewTimeCutoff, min: 1, max: 3600 },
                    { key: "resetHotkey", label: "Reset shortcut", type: "text", value: c.resetHotkey },
                    { key: "resetPaceOnManualReset", label: "Resetting also forgets the deck's pace", type: "checkbox", value: c.resetPaceOnManualReset },
                    { key: "barCSS", label: "Extra CSS for the bar", type: "textarea", value: c.barCSS, rows: 3 },
                ],
                { title: "Remaining time" },
            );
            if (values) {
                api.setConfig({ ...stored(), ...values });
                // the cutoff is read when the estimator is made
                estimator = null;
                api.reapplyShortcuts();
                refresh(false);
            }
        });
    },
} satisfies Plugin;
