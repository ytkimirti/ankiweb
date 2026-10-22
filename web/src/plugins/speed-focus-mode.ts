// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Speed Focus Mode, AnkiWeb 1046608507: the parts the app's built-in Auto
 * Advance (deck options > Auto Advance, toggled with Shift+A) lacks. For each
 * options group it can play an alert after a number of seconds on the
 * question, and rate the card Again or Good, or bury it, a number of seconds
 * after the question was shown, answer side included (the original's "skip
 * answer"). Unlike Auto Advance these always run. A countdown shows in the
 * bottom bar with a "More time!" button (P) that stops the timers for the
 * card, and typing an answer stops them too, as do dialogs opening. The
 * original's other timers, showing the answer and acting on the answer
 * side, are what Auto Advance does, so they are left to it.
 */

import { get } from "svelte/store";

import type { Plugin, PluginApi } from "$web/plugins/loader";

type Action = "again" | "good" | "bury";

interface DeckSettings {
    /** Seconds on the question before the alert; 0 for none. */
    autoAlert: number;
    /** Seconds from the question until the action; 0 for none. */
    autoAgain: number;
    autoAction: Action;
}

interface Config {
    enableMoreTimeButton: boolean;
    stopWhenTypingAnswer: boolean;
    hotkeyMoreTime: string;
    /** By options group id. */
    decks: Record<string, DeckSettings>;
}

const DEFAULTS: Config = { enableMoreTimeButton: true, stopWhenTypingAnswer: true, hotkeyMoreTime: "p", decks: {} };
const NO_TIMERS: DeckSettings = { autoAlert: 0, autoAgain: 0, autoAction: "again" };
const ACTION_LABELS: Record<Action, string> = { again: "Again", good: "Good", bury: "Bury" };

const CSS = `
.sfm-controls { display: inline-flex; margin-inline-end: 0.25rem; }
.sfm-controls[hidden] { display: none; }
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

/** A short beep, standing in for the original's alert.mp3. */
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

async function editDeckSettings(api: PluginApi, config: () => Config, deckId: bigint): Promise<void> {
    const dcid = await configIdFor(api, deckId);
    const group = await api.backend.getDeckConfig({ dcid });
    const current = { ...NO_TIMERS, ...config().decks[String(dcid)] };
    const values = await api.dialogs.openForm(
        [
            { key: "autoAlert", label: "Play an alert after (seconds on the question, 0: off)", type: "number", value: current.autoAlert, min: 0, max: 3600 },
            {
                key: "autoAction",
                label: "Then",
                type: "select",
                value: current.autoAction,
                options: [
                    { value: "again", label: "Rate Again" },
                    { value: "good", label: "Rate Good" },
                    { value: "bury", label: "Bury Card" },
                ],
            },
            { key: "autoAgain", label: "after (seconds from the question, 0: off)", type: "number", value: current.autoAgain, min: 0, max: 3600 },
        ],
        {
            title: `Speed Focus Mode: ${group.name}`,
            text: "For the decks using this options group. Showing the answer, and acting a while after it, "
                + "are set in the deck options under Auto Advance.",
        },
    );
    if (values) {
        const c = config();
        api.setConfig({
            ...c,
            decks: {
                ...c.decks,
                [String(dcid)]: {
                    autoAlert: Math.max(0, Number(values.autoAlert) || 0),
                    autoAgain: Math.max(0, Number(values.autoAgain) || 0),
                    autoAction: values.autoAction as Action,
                },
            },
        });
    }
}

export default {
    name: "Speed Focus Mode",
    setup(api) {
        const config = (): Config => ({ ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) });
        api.addStyle(CSS);

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
        let actionTimer: ReturnType<typeof setTimeout> | null = null;
        let ticker: ReturnType<typeof setInterval> | null = null;
        let generation = 0;

        const clearAll = () => {
            for (const timer of [alertTimer, actionTimer]) {
                if (timer) {
                    clearTimeout(timer);
                }
            }
            if (ticker) {
                clearInterval(ticker);
            }
            alertTimer = actionTimer = ticker = null;
        };
        /** The original's spdfClearCurrentTimeout: stops the card's timers. */
        const stop = () => {
            if (!alertTimer && !actionTimer) {
                return;
            }
            clearAll();
            time.textContent = "Stopped.";
        };
        const moreTime = () => {
            if (alertTimer || actionTimer) {
                stop();
                api.dialogs.tooltip("Timer stopped.");
            }
        };
        button.onclick = moreTime;

        const attach = () => {
            const side = document.querySelector(".reviewer-bar .side.end");
            if (side && controls.parentElement !== side) {
                side.prepend(controls);
            }
            button.title = `Shortcut key: ${config().hotkeyMoreTime.toUpperCase()}`;
        };

        const start = async (cardId: bigint) => {
            const token = ++generation;
            clearAll();
            controls.hidden = true;
            time.textContent = "";
            const card = api.reviewer.card;
            if (!card || card.id !== cardId) {
                return;
            }
            const dcid = await configIdFor(api, card.originalDeckId || card.deckId);
            const settings = { ...NO_TIMERS, ...config().decks[String(dcid)] };
            if (token !== generation) {
                return;
            }
            if (settings.autoAlert > 0) {
                alertTimer = setTimeout(() => {
                    alertTimer = null;
                    beep();
                    api.dialogs.tooltip(`Wake up! You have been looking at the question for ${settings.autoAlert} seconds!`);
                }, settings.autoAlert * 1000);
            }
            if (settings.autoAgain > 0) {
                const label = ACTION_LABELS[settings.autoAction] ?? "Again";
                let left = settings.autoAgain;
                time.textContent = `${label} ${formatCountdown(left)}`;
                ticker = setInterval(() => {
                    left -= 1;
                    time.textContent = left > 0 ? `${label} ${formatCountdown(left)}` : "";
                }, 1000);
                actionTimer = setTimeout(() => {
                    actionTimer = null;
                    if (ticker) {
                        clearInterval(ticker);
                        ticker = null;
                    }
                    void act(cardId, settings.autoAction);
                }, settings.autoAgain * 1000);
                attach();
                controls.hidden = !config().enableMoreTimeButton;
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

        api.hooks.reviewerDidShowQuestion.append((card) => void start(card.cardId));
        api.hooks.reviewerDidShowAnswer.append(() => {
            // the alert is for the question; the action timer runs on
            if (alertTimer) {
                clearTimeout(alertTimer);
                alertTimer = null;
            }
        });
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
            menu.push({ label: "Speed Focus Mode...", action: () => void editDeckSettings(api, config, deckId) });
        });
        api.hooks.reviewerWillShowContextMenu.append((menu) => {
            const card = api.reviewer.card;
            if (card) {
                menu.push(null, {
                    label: "Speed Focus Mode...",
                    action: () => void editDeckSettings(api, config, card.originalDeckId || card.deckId),
                });
            }
        });

        api.setConfigAction(async () => {
            const c = config();
            const values = await api.dialogs.openForm(
                [
                    { key: "enableMoreTimeButton", label: 'Show the countdown and "More time!" button', type: "checkbox", value: c.enableMoreTimeButton },
                    { key: "hotkeyMoreTime", label: "More time shortcut", type: "text", value: c.hotkeyMoreTime },
                    { key: "stopWhenTypingAnswer", label: "Stop the timers when typing an answer", type: "checkbox", value: c.stopWhenTypingAnswer },
                    { key: "deck", label: "Edit the timers of the current deck's options group", type: "checkbox", value: false },
                ],
                { title: "Speed Focus Mode", text: "The timers are set for each options group, from a deck's gear menu." },
            );
            if (values) {
                const { deck, ...rest } = values;
                api.setConfig({ ...c, ...rest, hotkeyMoreTime: String(rest.hotkeyMoreTime).trim() || DEFAULTS.hotkeyMoreTime });
                api.reapplyShortcuts();
                if (deck) {
                    await editDeckSettings(api, config, (await api.backend.getCurrentDeck({})).id);
                }
            }
        });
    },
} satisfies Plugin;
