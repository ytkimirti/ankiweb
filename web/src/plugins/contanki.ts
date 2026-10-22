// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Contanki, AnkiWeb 1898790263: game controller support, through the
 * browser's Gamepad API. The default bindings are those of Contanki's
 * standard gamepad profile, per screen: on the deck list the D-pad moves
 * between decks and A opens one; while reviewing A shows the answer, then
 * A/B/X/Y answer Good/Again/Hard/Easy. The right trigger shows the controls
 * for the screen. Browsers give pages no pointer to move, so the sticks do
 * not drive a cursor as they do on desktop.
 */

import { type DeckTreeNode, SetDeckCollapsedRequest_Scope } from "@generated/anki/decks_pb";
import { get } from "svelte/store";

import type { Plugin, PluginApi } from "$web/plugins/loader";

/** Standard gamepad buttons (https://w3c.github.io/gamepad/#remapping). */
const BUTTONS = [
    "A",
    "B",
    "X",
    "Y",
    "LB",
    "RB",
    "LT",
    "RT",
    "Select",
    "Start",
    "L3",
    "R3",
    "Up",
    "Down",
    "Left",
    "Right",
    "Home",
];

type Screen = "all" | "deckBrowser" | "overview" | "review" | "question" | "answer" | "dialog";
type Bindings = Partial<Record<Screen, Record<string, string>>>;

/** Contanki's "Standard Gamepad (16 Buttons 4 Axes)" profile, by button index. */
const DEFAULT_BINDINGS: Bindings = {
    all: { 0: "Enter", 4: "Undo", 5: "Sync", 7: "Toggle Overlay", 9: "Options" },
    review: { 8: "Card Info", 13: "Replay Audio", 14: "Flag", 15: "Mark Note" },
    question: { 0: "Flip Card" },
    answer: { 0: "Good", 1: "Again", 2: "Hard", 3: "Easy" },
    deckBrowser: {
        0: "Select",
        1: "Expand/Collapse",
        2: "Open Browser",
        3: "Open Statistics",
        12: "Previous Deck",
        13: "Next Deck",
        14: "Previous Due Deck",
        15: "Next Due Deck",
    },
    overview: {
        0: "Select",
        1: "Rebuild",
        2: "Empty",
        3: "Filter",
        12: "Previous Deck",
        13: "Next Deck",
        14: "Previous Due Deck",
        15: "Next Due Deck",
    },
    dialog: { 0: "Select", 4: "Escape", 12: "Up", 13: "Down", 14: "Select Previous", 15: "Select Next" },
};

interface Config {
    bindings: Bindings;
    flags: number[];
    overlayAlwaysOn: boolean;
}

const DEFAULTS: Config = { bindings: DEFAULT_BINDINGS, flags: [1, 2, 3, 4, 5, 6, 7], overlayAlwaysOn: false };

/** Presses a key as if typed, so the app's own shortcuts (and any changes to them) apply. */
function press(key: string, init: KeyboardEventInit = {}): void {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

function dialogOpen(): boolean {
    return !!document.querySelector("[role=dialog]") || !!document.querySelector(".menu, [role=menu]");
}

function moveFocus(delta: number): void {
    const dialogs = document.querySelectorAll("[role=dialog]");
    const root = dialogs[dialogs.length - 1] ?? document.body;
    const items = [
        ...root.querySelectorAll<HTMLElement>(
            "button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])",
        ),
    ]
        .filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
    if (!items.length) {
        return;
    }
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + delta + items.length) % items.length].focus();
}

function visibleDecks(node: DeckTreeNode, out: DeckTreeNode[] = []): DeckTreeNode[] {
    for (const child of node.children) {
        out.push(child);
        if (!child.collapsed) {
            visibleDecks(child, out);
        }
    }
    return out;
}

async function moveDeck(api: PluginApi, delta: number, dueOnly: boolean): Promise<void> {
    const tree = await api.backend.deckTree({ now: BigInt(Math.floor(Date.now() / 1000)) });
    const decks = visibleDecks(tree).filter((d) => !dueOnly || d.newCount + d.learnCount + d.reviewCount > 0);
    if (!decks.length) {
        return;
    }
    const current = (await api.backend.getCurrentDeck({})).id;
    const index = decks.findIndex((d) => d.deckId === current);
    const next = decks[index < 0 ? 0 : (index + delta + decks.length) % decks.length];
    await api.backend.setCurrentDeck({ did: next.deckId });
    api.main.reset();
}

async function toggleCollapsed(api: PluginApi): Promise<void> {
    const current = (await api.backend.getCurrentDeck({})).id;
    const node = visibleDecks(await api.backend.deckTree({ now: 0n })).find((d) => d.deckId === current);
    if (node?.children.length) {
        await api.backend.setDeckCollapsed({
            deckId: current,
            collapsed: !node.collapsed,
            scope: SetDeckCollapsedRequest_Scope.REVIEWER,
        });
        api.main.reset();
    }
}

function actionsFor(
    api: PluginApi,
    config: Config,
    toggleOverlay: () => void,
): Record<string, () => void | Promise<void>> {
    const reviewer = api.reviewer;
    return {
        Enter: () => press("Enter"),
        Escape: () => press("Escape"),
        Undo: () => api.main.undoAction(),
        Sync: () => press("y"),
        Options: async () => {
            if (api.reviewer.card) {
                await api.actions.confirmDeckThenDisplayOptions(api.reviewer.card);
            } else {
                await api.actions.openDeckOptions((await api.backend.getCurrentDeck({})).id);
            }
        },
        "Toggle Overlay": toggleOverlay,
        "Open Browser": () => api.actions.onBrowse(),
        "Open Statistics": () => api.actions.onStats(),
        "Add Notes": () => api.actions.onAddCard(),
        "Go to Main Screen": () => api.main.moveToState("deckBrowser"),
        "Study Deck": () => api.actions.onStudyDeck(),
        Select: () => {
            if (dialogOpen()) {
                const active = document.activeElement as HTMLElement | null;
                if (active && active !== document.body) {
                    active.click();
                } else {
                    press("Enter");
                }
            } else if (get(api.main.mainState) === "deckBrowser") {
                api.main.moveToState("overview");
            } else {
                press("s");
            }
        },
        "Expand/Collapse": () => toggleCollapsed(api),
        "Previous Deck": () => moveDeck(api, -1, false),
        "Next Deck": () => moveDeck(api, 1, false),
        "Previous Due Deck": () => moveDeck(api, -1, true),
        "Next Due Deck": () => moveDeck(api, 1, true),
        Rebuild: () => press("r"),
        Empty: () => press("e"),
        Filter: () => api.actions.onFilteredDeck(),
        Up: () => moveFocus(-1),
        Down: () => moveFocus(1),
        "Select Previous": () => moveFocus(-1),
        "Select Next": () => moveFocus(1),
        "Flip Card": () => reviewer.getTypedAnswer(),
        Again: () => reviewer.answerCard(1),
        Hard: () => reviewer.answerCard(2),
        Good: () => reviewer.answerCard(3),
        Easy: () => reviewer.answerCard(4),
        "Card Info": () => api.actions.openCardInfo(),
        "Previous Card Info": () => api.actions.openPreviousCardInfo(),
        "Replay Audio": () => reviewer.replayAudio(),
        Flag: () => {
            const current = (reviewer.card?.flags ?? 0) & 0b111;
            const flags = config.flags.length ? config.flags : DEFAULTS.flags;
            const next = flags[(flags.indexOf(current) + 1) % flags.length];
            // past the last flag, back to none
            return reviewer.setFlag(flags.indexOf(current) === flags.length - 1 ? current : next);
        },
        "Mark Note": () => reviewer.toggleMark(),
        "Bury Card": () => reviewer.buryCurrentCard(),
        "Bury Note": () => reviewer.buryCurrentNote(),
        "Suspend Card": () => reviewer.suspendCurrentCard(),
        "Suspend Note": () => reviewer.suspendCurrentNote(),
        "Edit Note": () => api.actions.onEditCurrent(),
        "Set Due Date": () => reviewer.setDue(),
        "Record Voice": () => reviewer.recordVoice(),
        "Replay Voice": () => reviewer.replayRecorded(),
    };
}

/** The screens whose bindings apply now, most specific first. */
function screens(api: PluginApi): Screen[] {
    if (dialogOpen()) {
        return ["dialog"];
    }
    const state = get(api.main.mainState);
    if (state === "review") {
        const side = api.reviewer.state === "answer" ? "answer" : "question";
        return [side, "review", "all"];
    }
    if (state === "deckBrowser" || state === "overview") {
        return [state, "all"];
    }
    return ["all"];
}

function binding(config: Config, list: Screen[], button: number): string | undefined {
    for (const screen of list) {
        const action = config.bindings[screen]?.[button];
        if (action) {
            return action;
        }
    }
    return undefined;
}

const CSS = `
.contanki-overlay { position: fixed; right: 1rem; bottom: 4.5rem; z-index: 50; padding: 0.5rem 0.75rem;
    background: var(--canvas-elevated); border: 1px solid var(--border); border-radius: var(--border-radius-medium, 8px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2); font-size: 0.85em; pointer-events: none; }
.contanki-overlay table { border-collapse: collapse; }
.contanki-overlay td { padding: 0.1rem 0.4rem; }
.contanki-overlay td:first-child { font-weight: 600; text-align: end; color: var(--fg-subtle); }
`;

export default {
    name: "Contanki",
    setup(api) {
        const config = (): Config => ({ ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) });
        api.addStyle(CSS);
        const overlay = document.createElement("div");
        overlay.className = "contanki-overlay";
        overlay.hidden = true;
        document.body.append(overlay);
        let overlayOn = false;
        let shownFor = "";
        const toggleOverlay = () => (overlayOn = !overlayOn);

        function drawOverlay(current: Config, list: Screen[]): void {
            const visible = (overlayOn || current.overlayAlwaysOn) && navigator.getGamepads().some(Boolean);
            overlay.hidden = !visible;
            const key = visible ? JSON.stringify(list) : "";
            if (!visible || key === shownFor) {
                return;
            }
            shownFor = key;
            const table = document.createElement("table");
            BUTTONS.forEach((name, index) => {
                const action = binding(current, list, index);
                if (action) {
                    const row = table.insertRow();
                    row.insertCell().textContent = name;
                    row.insertCell().textContent = action;
                }
            });
            overlay.replaceChildren(table);
        }

        let previous: boolean[] = [];
        let frame = 0;
        const poll = () => {
            frame = requestAnimationFrame(poll);
            const pad = navigator.getGamepads().find((p) => p?.connected);
            if (!pad || document.hidden) {
                overlay.hidden = true;
                previous = [];
                return;
            }
            const current = config();
            const list = screens(api);
            const pressed = pad.buttons.map((b) => b.pressed || b.value > 0.5);
            const actions = actionsFor(api, current, toggleOverlay);
            pressed.forEach((down, index) => {
                if (down && !previous[index]) {
                    const action = binding(current, list, index);
                    if (action && actions[action]) {
                        void Promise.resolve()
                            .then(actions[action])
                            .catch((err) => console.error("contanki action failed", err));
                    }
                }
            });
            previous = pressed;
            drawOverlay(current, list);
        };
        const start = () => {
            if (!frame) {
                frame = requestAnimationFrame(poll);
            }
        };
        // browsers list gamepads only once a button is pressed
        addEventListener("gamepadconnected", start);
        if (navigator.getGamepads().some(Boolean)) {
            start();
        }

        api.setConfigAction(async () => {
            const current = config();
            const values = await api.dialogs.openForm(
                [
                    {
                        key: "overlayAlwaysOn",
                        label: "Always show the controls overlay",
                        type: "checkbox",
                        value: current.overlayAlwaysOn,
                    },
                    {
                        key: "flags",
                        label: "Flags the Flag action cycles through",
                        type: "text",
                        value: current.flags.join(", "),
                    },
                    {
                        key: "bindings",
                        label: `Bindings by screen, button index to action. Buttons: ${
                            BUTTONS.map((b, i) => `${i} ${b}`).join(", ")
                        }. Actions: ${Object.keys(actionsFor(api, current, () => {})).join(", ")}.`,
                        type: "textarea",
                        value: JSON.stringify(current.bindings, null, 2),
                        rows: 14,
                    },
                ],
                { title: "Contanki" },
            );
            if (!values) {
                return;
            }
            let bindings: Bindings;
            try {
                bindings = JSON.parse(String(values.bindings));
            } catch (err) {
                await api.dialogs.showWarning(`The bindings are not valid JSON: ${err}`);
                return;
            }
            const flags = String(values.flags).split(/[\s,]+/).map(Number).filter((n) => n >= 1 && n <= 7);
            api.setConfig({ bindings, flags, overlayAlwaysOn: !!values.overlayAlwaysOn } satisfies Config);
        });

        return () => {
            cancelAnimationFrame(frame);
            removeEventListener("gamepadconnected", start);
            overlay.remove();
        };
    },
} satisfies Plugin;
