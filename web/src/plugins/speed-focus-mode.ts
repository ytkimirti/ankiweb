// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Speed Focus Mode (auto-alert, auto-reveal, auto-answer), AnkiWeb
 * 1046608507, as its version 1.0. For each options group it can play an alert
 * after a number of seconds on the question, show the answer after a number
 * of seconds, and rate the card Again or Good, or bury it, a number of
 * seconds after the answer was shown, or after the question was shown with
 * "Skip answer". The settings are kept in the options group as the original
 * keeps them (autoAlert, autoAnswer, autoAgain, autoAction, autoSkip), so they
 * sync, and desktop with the add-on uses the same ones. A countdown to the
 * next action shows in the bottom bar with a "More time!" button (P) that
 * stops it, as typing an answer and opening a dialog do. The alert is the
 * original's sound, or one picked in the add-on's settings (its user_files
 * alert.mp3). Unlike deck options' Auto Advance, the timers always run.
 */

import { get } from "svelte/store";

import type { Plugin, PluginApi } from "$web/plugins/loader";

export type Action = "again" | "good" | "bury";

/** The options group's keys, as the original stores them. */
export interface DeckSettings {
    /** Seconds on the question before the alert; 0 for none. */
    autoAlert: number;
    /** Seconds on the question before the answer is shown; 0 for none. */
    autoAnswer: number;
    /** Seconds before the action, from the answer (or the question with autoSkip); 0 for none. */
    autoAgain: number;
    autoAction: Action;
    /** Counts autoAgain from the question, skipping the answer. */
    autoSkip: boolean;
}

interface Config {
    enableMoreTimeButton: boolean;
    stopWhenTypingAnswer: boolean;
    hotkeyMoreTime: string;
    /** Settings by options group id, from before they were kept in the options group. */
    decks?: Record<string, Partial<DeckSettings>>;
}

const DEFAULTS: Config = { enableMoreTimeButton: true, stopWhenTypingAnswer: true, hotkeyMoreTime: "p" };
export const NO_TIMERS: DeckSettings = { autoAlert: 0, autoAnswer: 0, autoAgain: 0, autoAction: "again", autoSkip: false };
const KEYS = Object.keys(NO_TIMERS) as (keyof DeckSettings)[];
const ACTIONS: Action[] = ["again", "good", "bury"];
const ACTION_LABELS: Record<Action, string> = { again: "Again", good: "Good", bury: "Bury" };
const ALERT_FILE = "alert";
/** The original's alert sound; Vite emits it with the plugin. */
const alertUrl = () => new URL("./assets/speed-focus-mode/alert.mp3", import.meta.url).href;

const CSS = `
.sfm-controls { display: inline-flex; margin-inline-end: 0.25rem; }
.sfm-controls[hidden] { display: none; }
.sfm-controls button { position: relative; }
.sfm-controls .sfm-time {
    position: absolute; top: -3px; left: 50%; transform: translate(-50%, -100%);
    white-space: nowrap; font-size: small; font-weight: normal; color: var(--fg);
}
`;

/** m:ss, as the original's countdown. */
export function formatCountdown(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The settings among an options group's other keys, missing or invalid ones off. */
export function readSettings(other: Record<string, unknown>): DeckSettings {
    const seconds = (value: unknown) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : 0;
    };
    return {
        autoAlert: seconds(other.autoAlert),
        autoAnswer: seconds(other.autoAnswer),
        autoAgain: seconds(other.autoAgain),
        autoAction: ACTIONS.includes(other.autoAction as Action) ? (other.autoAction as Action) : "again",
        autoSkip: other.autoSkip === true,
    };
}

export type Timer = { kind: "alert" | "reveal" | "action"; seconds: number };

/**
 * The timers to start when a side is shown, the original's
 * set_answer_timeouts (question) and set_question_timeouts (answer). The
 * countdown shows the reveal or action timer; with Skip answer the action
 * replaces the reveal.
 */
export function timersFor(side: "question" | "answer", s: DeckSettings): Timer[] {
    const timers: Timer[] = [];
    if (side === "question") {
        if (s.autoAlert > 0) {
            timers.push({ kind: "alert", seconds: s.autoAlert });
        }
        if (s.autoSkip && s.autoAgain > 0) {
            timers.push({ kind: "action", seconds: s.autoAgain });
        } else if (s.autoAnswer > 0) {
            timers.push({ kind: "reveal", seconds: s.autoAnswer });
        }
    } else if (!s.autoSkip && s.autoAgain > 0) {
        timers.push({ kind: "action", seconds: s.autoAgain });
    }
    return timers;
}

/** A short beep, if the alert sound cannot play. */
function beep(): void {
    try {
        const audio = new AudioContext();
        const gain = audio.createGain();
        gain.connect(audio.destination);
        gain.gain.setValueAtTime(0.25, audio.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.6);
        for (const [freq, at] of [[880, 0], [1320, 0.15]]) {
            const osc = audio.createOscillator();
            osc.frequency.value = freq;
            osc.connect(gain);
            osc.start(audio.currentTime + at);
            osc.stop(audio.currentTime + at + 0.3);
        }
        setTimeout(() => void audio.close(), 1000);
    } catch {
        // no audio
    }
}

/** Runs in the card frame: tells the app when an answer is typed. */
function cardScript(): void {
    const input = document.getElementById("typeans");
    if (!input) {
        return;
    }
    const onKeyup = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).pycmd("spdf:typeans");
        input.removeEventListener("keyup", onKeyup);
    };
    input.addEventListener("keyup", onKeyup);
}

async function configIdFor(api: PluginApi, deckId: bigint): Promise<bigint> {
    const deck = await api.backend.getDeck({ did: deckId });
    return deck.kind.case === "normal" ? deck.kind.value.configId : 1n;
}

function decodeJson(bytes: Uint8Array): Record<string, unknown> {
    try {
        const value = JSON.parse(new TextDecoder().decode(bytes));
        return value && typeof value === "object" ? value : {};
    } catch {
        return {};
    }
}

/** Writes the settings into the options group, as desktop's add-on does. */
async function saveSettings(api: PluginApi, dcid: bigint, settings: DeckSettings): Promise<void> {
    const legacy = decodeJson((await api.backend.getDeckConfigLegacy({ dcid })).json);
    Object.assign(legacy, settings);
    await api.backend.addOrUpdateDeckConfigLegacy({ json: new TextEncoder().encode(JSON.stringify(legacy)) });
}

export default {
    name: "Speed Focus Mode",
    setup(api) {
        const config = (): Config => ({ ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) });
        api.addStyle(CSS);

        /**
         * The options group's settings. Ones this plugin kept on this device
         * before move into the group, counted from the question as they were.
         */
        const settingsFor = async (dcid: bigint): Promise<DeckSettings> => {
            const group = await api.backend.getDeckConfig({ dcid });
            const other = group.config ? decodeJson(group.config.other) : {};
            const local = config().decks?.[String(dcid)];
            if (local && !KEYS.some((key) => key in other)) {
                const settings = readSettings({ ...local, autoSkip: true });
                await saveSettings(api, dcid, settings);
                const { [String(dcid)]: _, ...rest } = config().decks ?? {};
                api.setConfig({ ...config(), decks: rest });
                return settings;
            }
            return readSettings(other);
        };

        const editDeckSettings = async (deckId: bigint): Promise<void> => {
            const dcid = await configIdFor(api, deckId);
            const group = await api.backend.getDeckConfig({ dcid });
            const current = await settingsFor(dcid);
            const values = await api.dialogs.openForm(
                [
                    { key: "autoAlert", label: "Automatically play alert after (seconds)", type: "number", value: current.autoAlert, min: 0, max: 3600 },
                    { key: "autoAnswer", label: "Automatically show answer after (seconds)", type: "number", value: current.autoAnswer, min: 0, max: 3600 },
                    {
                        key: "autoAction",
                        label: "Automatically",
                        type: "select",
                        value: current.autoAction,
                        options: [
                            { value: "again", label: "Rate Again" },
                            { value: "good", label: "Rate Good" },
                            { value: "bury", label: "Bury Card" },
                        ],
                    },
                    { key: "autoAgain", label: "after (seconds)", type: "number", value: current.autoAgain, min: 0, max: 3600 },
                    { key: "autoSkip", label: "Skip answer (start counting on the question side)", type: "checkbox", value: current.autoSkip },
                ],
                {
                    title: `Speed Focus Mode: ${group.name}`,
                    text: "For the decks using this options group; 0 turns a timer off. "
                        + "Kept in the options group, so they sync and desktop's Speed Focus Mode uses them too.",
                },
            );
            if (values) {
                await saveSettings(api, dcid, readSettings(values));
            }
        };

        const controls = document.createElement("span");
        controls.className = "sfm-controls";
        controls.hidden = true;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "More time!";
        const time = document.createElement("span");
        time.className = "sfm-time";
        button.append(time);
        controls.append(button);
        api.onUnload(() => controls.remove());

        let alertTimer: ReturnType<typeof setTimeout> | null = null;
        /** The reveal or action timer the countdown shows. */
        let currentTimer: ReturnType<typeof setTimeout> | null = null;
        let ticker: ReturnType<typeof setInterval> | null = null;
        let generation = 0;

        const clearAll = () => {
            for (const timer of [alertTimer, currentTimer]) {
                if (timer) {
                    clearTimeout(timer);
                }
            }
            if (ticker) {
                clearInterval(ticker);
            }
            alertTimer = currentTimer = ticker = null;
        };
        /** The original's spdfClearCurrentTimeout: stops the side's timers. */
        const stop = (): boolean => {
            if (!alertTimer && !currentTimer) {
                return false;
            }
            clearAll();
            time.textContent = "Stopped.";
            return true;
        };
        const moreTime = () => {
            if (stop()) {
                api.dialogs.tooltip("Timer stopped.");
            }
        };
        button.onclick = () => void stop();

        const attach = () => {
            const side = document.querySelector(".reviewer-bar .side.end");
            if (side && controls.parentElement !== side) {
                side.prepend(controls);
            }
            button.title = `Shortcut key: ${config().hotkeyMoreTime.toUpperCase()}`;
        };

        const playAlert = async () => {
            try {
                const custom = await api.files.get(ALERT_FILE).catch(() => null);
                const url = custom ? URL.createObjectURL(custom) : alertUrl();
                const audio = new Audio(url);
                if (custom) {
                    audio.onended = audio.onerror = () => URL.revokeObjectURL(url);
                }
                await audio.play();
            } catch {
                beep();
            }
        };

        const act = async (cardId: bigint, action: Action) => {
            const reviewer = api.reviewer;
            if (get(api.main.mainState) !== "review" || reviewer.card?.id !== cardId) {
                return;
            }
            if (action === "bury") {
                await reviewer.buryCurrentCard();
                return;
            }
            if (reviewer.state === "question") {
                await reviewer.showAnswer();
            }
            if (reviewer.card?.id === cardId) {
                await reviewer.answerCard(action === "good" ? 3 : 1);
            }
        };

        const start = async (cardId: bigint, side: "question" | "answer") => {
            const token = ++generation;
            clearAll();
            if (side === "question") {
                controls.hidden = true;
                time.textContent = "";
            }
            const card = api.reviewer.card;
            if (!card || card.id !== cardId) {
                return;
            }
            const settings = await settingsFor(await configIdFor(api, card.originalDeckId || card.deckId));
            if (token !== generation) {
                return;
            }
            let countdown = false;
            for (const timer of timersFor(side, settings)) {
                const ms = timer.seconds * 1000;
                if (timer.kind === "alert") {
                    alertTimer = setTimeout(() => {
                        alertTimer = null;
                        void playAlert();
                        api.dialogs.tooltip(`Wake up! You have been looking at the question for ${timer.seconds} seconds!`, 1000);
                    }, ms);
                    continue;
                }
                const label = timer.kind === "reveal" ? "Reveal" : ACTION_LABELS[settings.autoAction];
                let left = Math.round(timer.seconds);
                time.textContent = `${label} ${formatCountdown(left)}`;
                ticker = setInterval(() => {
                    left -= 1;
                    time.textContent = left > 0 ? `${label} ${formatCountdown(left)}` : "";
                }, 1000);
                currentTimer = setTimeout(() => {
                    currentTimer = null;
                    if (ticker) {
                        clearInterval(ticker);
                        ticker = null;
                    }
                    if (timer.kind === "reveal") {
                        if (get(api.main.mainState) === "review" && api.reviewer.card?.id === cardId && api.reviewer.state === "question") {
                            void api.reviewer.showAnswer();
                        }
                    } else {
                        void act(cardId, settings.autoAction);
                    }
                }, ms);
                countdown = true;
            }
            if (countdown) {
                attach();
                controls.hidden = !config().enableMoreTimeButton;
            } else {
                controls.hidden = true;
            }
        };

        api.hooks.reviewerDidShowQuestion.append((card) => void start(card.cardId, "question"));
        api.hooks.reviewerDidShowAnswer.append((card) => void start(card.cardId, "answer"));
        api.hooks.reviewerWillEnd.append(() => {
            generation++;
            clearAll();
            controls.hidden = true;
        });
        // opening a dialog or window stops the timers, as on desktop
        const stopIfOpen = (open: unknown[]) => {
            if (open.length && get(api.main.mainState) === "review") {
                stop();
            }
        };
        const unsubscribe = [api.windows.windows.subscribe(stopIfOpen), api.dialogs.dialogs.subscribe(stopIfOpen)];
        api.onUnload(() => {
            generation++;
            clearAll();
            unsubscribe.forEach((u) => u());
        });

        api.hooks.cardWillShow.append((html, _card, kind) =>
            kind === "reviewQuestion" && html.includes("typeans")
                ? `${html}<script>(${cardScript.toString()})();</script>`
                : html
        );
        api.hooks.webviewDidReceiveBridgeCommand.append((handled, cmd, context) => {
            if (handled[0] || context !== "reviewer" || !cmd.startsWith("spdf:")) {
                return handled;
            }
            if (cmd === "spdf:typeans" && config().stopWhenTypingAnswer) {
                stop();
            }
            return [true, undefined];
        });
        api.hooks.stateShortcutsWillChange.append((state, shortcuts) => {
            if (state === "review") {
                shortcuts.push([config().hotkeyMoreTime, moreTime]);
            }
        });

        api.hooks.deckBrowserWillShowOptionsMenu.append((menu, deckId) => {
            menu.push({ label: "Speed Focus Mode...", action: () => void editDeckSettings(deckId) });
        });
        api.hooks.reviewerWillShowContextMenu.append((menu) => {
            const card = api.reviewer.card;
            if (card) {
                menu.push(null, {
                    label: "Speed Focus Mode...",
                    action: () => void editDeckSettings(card.originalDeckId || card.deckId),
                });
            }
        });

        api.setConfigAction(async () => {
            const c = config();
            const hasCustom = (await api.files.list()).includes(ALERT_FILE);
            const values = await api.dialogs.openForm(
                [
                    { key: "enableMoreTimeButton", label: 'Show the countdown and "More time!" button', type: "checkbox", value: c.enableMoreTimeButton },
                    { key: "hotkeyMoreTime", label: "More time shortcut", type: "text", value: c.hotkeyMoreTime },
                    { key: "stopWhenTypingAnswer", label: "Stop the timers when typing an answer", type: "checkbox", value: c.stopWhenTypingAnswer },
                    { key: "alert", label: "Alert sound (leave empty to keep the current one)", type: "file", value: null, accept: "audio/*" },
                    { key: "defaultAlert", label: "Use the original alert sound", type: "checkbox", value: !hasCustom },
                    { key: "deck", label: "Edit the timers of the current deck's options group", type: "checkbox", value: false },
                ],
                { title: "Speed Focus Mode", text: "The timers are set for each options group, from a deck's gear menu." },
            );
            if (values) {
                const { deck, alert, defaultAlert, ...rest } = values;
                api.setConfig({ ...c, ...rest, hotkeyMoreTime: String(rest.hotkeyMoreTime).trim() || DEFAULTS.hotkeyMoreTime });
                api.reapplyShortcuts();
                if (alert instanceof File) {
                    await api.files.put(ALERT_FILE, alert);
                } else if (defaultAlert && hasCustom) {
                    await api.files.remove(ALERT_FILE);
                }
                if (deck) {
                    await editDeckSettings((await api.backend.getCurrentDeck({})).id);
                }
            }
        });
    },
} satisfies Plugin;
