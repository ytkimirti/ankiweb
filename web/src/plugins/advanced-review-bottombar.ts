// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Advanced Review Bottombar, AnkiWeb 1136455830: restyles the reviewer's
 * bottom bar. Answer buttons get one of the original's eight designs (text
 * or background colour, wide, neon, fill) with its hover effects and active
 * indicator, the other buttons one of its five; Info, Skip, Show Skipped and
 * Undo buttons can be added left, right or in the middle, with shortcuts;
 * Hard, Good and Easy can be hidden; every label and size can be changed;
 * a tooltip confirms the answer given; and the Show Answer button's border
 * can show the card's ease. Skip buries the card (or suspends it), as the
 * original does with the v3 scheduler, and Show Skipped brings the skipped
 * cards back; both are undoable. Its card info sidebar is left out, since
 * the card info window (I) follows the reviewer here, as are its overview
 * stats, which More Overview Stats provides.
 */

import { BuryOrSuspendCardsRequest_Mode } from "@generated/anki/scheduler_pb";
import { get } from "svelte/store";

import type { FormField } from "$web/app/dialogs";
import type { Plugin, PluginApi } from "$web/plugins/loader";

const EASES = ["again", "hard", "good", "easy"] as const;
type Ease = (typeof EASES)[number];
const EXTRAS = ["info", "skip", "showSkipped", "undo"] as const;
type Extra = (typeof EXTRAS)[number];
type Position = "left" | "middle left" | "middle right" | "right";

interface Config {
    buttonStyle: number;
    generalStyle: number;
    hoverEffect: number;
    activeIndicator: number;
    pointerCursor: boolean;
    intervalStyle: number;
    transitionMs: number;
    borderRadius: number;
    widePercent: number;
    styleMainScreen: boolean;
    customColors: boolean;
    colors: Record<Ease, string>;
    hoverColors: Record<Ease, string>;
    customTextColor: boolean;
    textColor: string;
    customActiveColor: boolean;
    activeColor: string;
    customGeneralText: boolean;
    generalText: string;
    customGeneralBorder: boolean;
    generalBorder: string;
    extras: Record<Extra, boolean>;
    positions: Record<Extra, Position>;
    shortcuts: Record<Extra, string>;
    hide: Record<"hard" | "good" | "easy", boolean>;
    customSizes: boolean;
    height: number;
    widths: Record<"edit" | "showAnswer" | "more" | "review" | Extra, number>;
    textSize: number;
    fontWeight: number;
    labels: Record<"studyNow" | "edit" | "showAnswer" | "more" | Extra | Ease, string>;
    tooltip: boolean;
    tooltipFixed: boolean;
    tooltipMs: number;
    tooltipTextColor: string;
    tooltipWidth: number;
    tooltipHeight: number;
    tooltipX: number;
    tooltipY: number;
    easeBorder: boolean;
    easeThresholds: number[];
    easeColors: string[];
    /** 0: next card and 1: bury (the same with the v3 scheduler), 2: suspend. */
    skipMethod: number;
}

/** The original's defaults. */
export const DEFAULTS: Config = {
    buttonStyle: 0,
    generalStyle: 0,
    hoverEffect: 1,
    activeIndicator: 1,
    pointerCursor: false,
    intervalStyle: 0,
    transitionMs: 500,
    borderRadius: 5,
    widePercent: 80,
    styleMainScreen: true,
    customColors: false,
    colors: { again: "#BA0C0C", hard: "#BF720F", good: "#20A11C", easy: "#188AB8" },
    hoverColors: { again: "#FF1111", hard: "#FF9814", good: "#33FF2D", easy: "#21C0FF" },
    customTextColor: false,
    textColor: "#ffffff",
    customActiveColor: false,
    activeColor: "#ffffff",
    customGeneralText: false,
    generalText: "#FF1111",
    customGeneralBorder: false,
    generalBorder: "#FF1111",
    extras: { info: true, skip: true, showSkipped: false, undo: false },
    positions: { info: "left", skip: "middle left", showSkipped: "middle left", undo: "middle right" },
    shortcuts: { info: "F4", skip: "c", showSkipped: "Alt+c", undo: "x" },
    hide: { hard: false, good: false, easy: false },
    customSizes: false,
    height: 40,
    widths: { edit: 150, showAnswer: 150, more: 150, review: 150, info: 150, skip: 150, showSkipped: 150, undo: 150 },
    textSize: 14,
    fontWeight: 3,
    labels: {
        studyNow: "Study Now",
        edit: "Edit",
        showAnswer: "Show Answer",
        more: "More",
        info: "Info",
        skip: "Skip",
        showSkipped: "Show Skipped",
        undo: "Undo Review",
        again: "Again",
        hard: "Hard",
        good: "Good",
        easy: "Easy",
    },
    tooltip: true,
    tooltipFixed: false,
    tooltipMs: 500,
    tooltipTextColor: "#000000",
    tooltipWidth: 300,
    tooltipHeight: 100,
    tooltipX: 100,
    tooltipY: 100,
    easeBorder: false,
    easeThresholds: [200, 250, 300, 350],
    easeColors: ["#FF1111", "#FF9814", "#33FF2D", "#21C0FF"],
    skipMethod: 0,
};

export function loadConfig(saved: Partial<Config>): Config {
    const merged = { ...DEFAULTS, ...saved };
    for (const key of ["colors", "hoverColors", "extras", "positions", "shortcuts", "hide", "widths", "labels"] as const) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (merged as any)[key] = { ...DEFAULTS[key], ...(saved[key] ?? {}) };
    }
    return merged;
}

const FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const BRIGHT = ["#FF1111", "#FF9814", "#33FF2D", "#21C0FF"];
const DAY_GRADIENTS = [["#B52217", "#CF271A"], ["#BF7707", "#D98708"], ["#1CA810", "#20C212"], ["#0F95BA", "#11AAD4"]];
const DAY_HOVER_GRADIENTS = [["#E02A1C", "#FF3020"], ["#E08C08", "#FF9F09"], ["#22D414", "#27F217"], ["#11A7D1", "#13C0F0"]];

/** A CSS string literal. */
export function cssString(text: string): string {
    return `"${text.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\a ")}"`;
}

/** Keeps colours from closing a declaration. */
function color(value: string): string {
    return value.replace(/[^#\w(),.% -]/g, "");
}

function glow(c: string): string {
    return `box-shadow: 0 0 5px ${c}, 0 0 20px ${c}, 0 0 40px ${c};`;
}

/** The answer buttons' design, for day (night false) or night mode (the original's styles.py). */
export function answerCss(c: Config, night: boolean): string {
    const scope = night ? ".night-mode .reviewer-bar" : ":root:not(.night-mode) .reviewer-bar";
    const style = c.buttonStyle;
    const cursor = c.pointerCursor ? "pointer" : "default";
    const transition = `${(Number(c.transitionMs) || 0) / 1000}s`;
    const radius = `${Number(c.borderRadius) || 0}px`;
    const text = c.customTextColor ? color(c.textColor) : night ? (style > 3 ? "black" : "#dedede") : "black";
    let css = "";
    EASES.forEach((ease, i) => {
        const sel = `${scope} button.ease${i + 1}`;
        const base = c.customColors ? color(c.colors[ease]) : DEFAULTS.colors[ease];
        const hoverColor = c.customColors ? color(c.hoverColors[ease]) : BRIGHT[i];
        const neonColor = c.customColors ? base : BRIGHT[i];
        const shadow = glow(c.customColors ? hoverColor : base);
        if (style === 0 || style === 2) {
            const hover = c.hoverEffect === 1 ? `color: ${hoverColor};` : c.hoverEffect === 2 ? shadow
                : c.hoverEffect === 3 ? `color: ${hoverColor}; ${shadow}` : "";
            css += `${sel} { color: ${base}; cursor: ${cursor}; }\n${sel}:hover { ${hover} }\n`;
        } else if (style === 1 || style === 3) {
            const background = c.customColors || night ? base : `linear-gradient(0deg, ${DAY_GRADIENTS[i][0]}, ${DAY_GRADIENTS[i][1]})`;
            const hoverBackground = c.customColors || night
                ? `background: ${hoverColor};`
                : `background: linear-gradient(0deg, ${DAY_HOVER_GRADIENTS[i][0]}, ${DAY_HOVER_GRADIENTS[i][1]});`;
            const hover = c.hoverEffect === 1 ? hoverBackground : c.hoverEffect === 2 ? shadow
                : c.hoverEffect === 3 ? `${hoverBackground} ${shadow}` : "";
            css += `${sel} { border: hidden; color: ${text}; background: ${background}; cursor: ${cursor}; text-shadow: none; }
${sel}:hover { color: ${text}; ${hover} }\n`;
        } else if (style === 4) {
            css += `${sel} { background: none; color: ${neonColor}; border: 1px solid ${neonColor}; padding: 5px 20px;
    border-radius: ${radius} !important; cursor: ${cursor}; transition: ${transition}; box-shadow: none; }
${sel}:hover { background: ${neonColor}; color: ${text};
    box-shadow: 0 2px 20px 0 ${neonColor} inset, 0 2px 20px 0 ${neonColor}; }\n`;
        } else if (style === 5) {
            css += `${sel} { color: ${text}; border: 1px solid ${neonColor}; padding: 5px 20px; border-radius: ${radius} !important;
    background: ${neonColor}; cursor: ${cursor}; transition: ${transition};
    box-shadow: 0 2px 20px 0 ${neonColor} inset, 0 2px 20px 0 ${neonColor}; }
${sel}:hover { background: none; color: ${neonColor}; box-shadow: none; }\n`;
        } else {
            // fill 1 fills on hover; fill 2 starts filled and empties
            const [from, to] = style === 6 ? ["0%", "180%"] : ["180%", "0%"];
            const [idle, hovered] = style === 6 ? [neonColor, text] : [text, neonColor];
            css += `${sel} { padding: 5px 20px; border: 1px solid ${neonColor}; background: none; cursor: ${cursor};
    transition: ${transition}; position: relative; overflow: hidden; isolation: isolate;
    border-radius: ${radius} !important; color: ${idle}; }
${sel}:hover { color: ${hovered}; }
${sel}::before { content: ""; position: absolute; left: 0; bottom: 0; width: 100%; height: ${from};
    background: ${neonColor}; z-index: -1; transition: ${transition}; border-radius: 50% 50% 0 0; }
${sel}:hover::before { height: ${to}; }\n`;
        }
        if (c.intervalStyle === 1) {
            css += `${sel} .stattxt { color: ${style > 3 || style === 1 || style === 3 ? neonColor : base}; }\n`;
        }
    });
    // the button the user is on (desktop focuses the default one)
    if (c.activeIndicator && style < 4) {
        const active = c.customActiveColor ? color(c.activeColor) : "#21BFFF";
        const extra = c.activeIndicator === 2 ? `border: solid 1px ${active}; ${glow(active)}` : `border: solid 1px ${active};`;
        css += `${scope} button.ease:focus-visible, ${scope} button.ease.default:not(:hover) { ${extra} }\n`;
    }
    return css;
}

/** The other buttons' design (the original's bottombar_neon1 and so on). */
export function generalCss(c: Config, night: boolean, selectors: string[]): string {
    if (!c.generalStyle) {
        return "";
    }
    const scope = night ? ".night-mode" : ":root:not(.night-mode)";
    const sel = selectors.map((s) => `${scope} ${s}`).join(", ");
    const hover = selectors.map((s) => `${scope} ${s}:hover`).join(", ");
    const before = selectors.map((s) => `${scope} ${s}::before`).join(", ");
    const hoverBefore = selectors.map((s) => `${scope} ${s}:hover::before`).join(", ");
    const text = c.customGeneralText ? color(c.generalText) : night ? "#F0F0F0" : "#2F2F31";
    const border = c.customGeneralBorder
        ? color(c.generalBorder)
        : night
        ? (c.generalStyle <= 2 ? "#939399" : "#dedede")
        : (c.generalStyle === 1 ? "#404040" : c.generalStyle === 2 ? "#939399" : "#080808");
    const cursor = c.pointerCursor ? "pointer" : "default";
    const transition = `${(Number(c.transitionMs) || 0) / 1000}s`;
    const radius = `${Number(c.borderRadius) || 0}px`;
    const common = `padding: 5px 20px; border: 1px solid ${border}; border-radius: ${radius} !important;
    cursor: ${cursor}; transition: ${transition};`;
    const dark = night ? "black" : "white";
    switch (c.generalStyle) {
        case 1:
            return `${sel} { ${common} color: ${text}; background: none; }
${hover} { background: ${text}; color: ${dark}; box-shadow: 0 2px 10px 0 ${text}; }\n`;
        case 2:
            return `${sel} { ${common} color: ${dark}; background: ${text}; box-shadow: 0 2px 10px 0 ${text}; }
${hover} { background: none; color: ${text}; box-shadow: none; }\n`;
        default: {
            const [from, to] = c.generalStyle === 3 ? ["0%", "180%"] : ["180%", "0%"];
            const [idle, hovered] = c.generalStyle === 3 ? [text, night ? "#2F2F31" : "white"] : [dark, text];
            return `${sel} { ${common} background: none; position: relative; overflow: hidden; isolation: isolate; color: ${idle}; }
${hover} { color: ${hovered}; }
${before} { content: ""; position: absolute; left: 0; bottom: 0; width: 100%; height: ${from}; background: ${text};
    z-index: -1; transition: ${transition}; border-radius: 50% 50% 0 0; }
${hoverBefore} { height: ${to}; }\n`;
        }
    }
}

/** A replacement label, unless it is the default one, which stays translated. */
function labelCss(selector: string, label: string, fallback: string, size: string): string {
    if (label === fallback) {
        return "";
    }
    return `${selector} { font-size: 0 !important; }
${selector}::after { content: ${cssString(label)}; font-size: ${size}; }
${selector} .stattxt, ${selector} .sfm-time { font-size: small; }\n`;
}

const EDIT = ".reviewer-bar .side.start > button:first-child";
const MORE = ".reviewer-bar .side.end > button:last-child";
const SHOW_ANSWER = ".reviewer-bar .show-answer";

export function layoutCss(c: Config): string {
    const size = c.customSizes ? `${Number(c.textSize) || 14}px` : "inherit";
    const weight = FONT_WEIGHTS[Number(c.fontWeight)] ?? 400;
    const radius = `${Number(c.borderRadius) || 0}px`;
    let css = `.reviewer-bar button, .reviewer-bar .arbb-btn { border-radius: ${radius} !important; font-weight: ${weight};
    cursor: ${c.pointerCursor ? "pointer" : "default"}; }
.arbb-tooltip { position: fixed; z-index: 950; display: flex; align-items: center; justify-content: center;
    border: 2px solid rgba(0, 0, 0, 0.3); pointer-events: none; font-weight: bold; text-align: center; }\n`;
    if (c.styleMainScreen) {
        css += `.overview #study, .bottom-bar button { border-radius: ${radius} !important; font-weight: ${weight}; }\n`;
    }
    (["hard", "good", "easy"] as const).forEach((ease) => {
        if (c.hide[ease]) {
            css += `.reviewer-bar button.ease${EASES.indexOf(ease) + 1} { display: none !important; }\n`;
        }
    });
    if (c.buttonStyle === 2 || c.buttonStyle === 3) {
        css += `.reviewer-bar .middle:has(> .ease) { justify-self: center; width: ${Number(c.widePercent) || 80}%; flex-wrap: nowrap; }
.reviewer-bar .middle > .ease { flex: 1 1 0; min-width: 70px; }\n`;
    }
    if (c.intervalStyle === 2) {
        css += `.reviewer-bar button.ease .stattxt { position: static; display: block; transform: none; }\n`;
    }
    if (c.customSizes) {
        const box = (width: number) => `height: ${Number(c.height) || 40}px; width: ${Number(width) || 150}px; font-size: ${size}; min-width: 5px;`;
        css += `${EDIT} { ${box(c.widths.edit)} }
${MORE} { ${box(c.widths.more)} }
${SHOW_ANSWER} { ${box(c.widths.showAnswer)} }
.reviewer-bar button.ease { ${box(c.widths.review)} }\n`;
        for (const extra of EXTRAS) {
            css += `.reviewer-bar .arbb-${extra} { ${box(c.widths[extra])} }\n`;
        }
    }
    if (c.easeBorder) {
        css += `${SHOW_ANSWER} { border-color: var(--arbb-ease-border, var(--border-subtle)); border-width: 2px; }\n`;
    }
    const labels = c.labels;
    const fallbackSize = c.customSizes ? size : "1rem";
    css += labelCss(EDIT, labels.edit, DEFAULTS.labels.edit, fallbackSize);
    css += labelCss(MORE, labels.more, DEFAULTS.labels.more, fallbackSize);
    css += labelCss(SHOW_ANSWER, labels.showAnswer, DEFAULTS.labels.showAnswer, fallbackSize);
    if (c.styleMainScreen) {
        css += labelCss(".overview #study", labels.studyNow, DEFAULTS.labels.studyNow, "1rem");
    }
    EASES.forEach((ease, i) => {
        css += labelCss(`.reviewer-bar button.ease${i + 1}`, labels[ease], DEFAULTS.labels[ease], fallbackSize);
    });
    return css;
}

/** The colour the Show Answer border takes for a card's ease (the original's _showAnswerButton). */
export function easeBorderColor(cardType: number, factor: number, thresholds: number[], colors: string[]): string | null {
    if (cardType === 0 || cardType === 1) {
        return null;
    }
    const ease = Math.floor(factor / 10);
    for (let i = 0; i < 4; i++) {
        if (ease < (thresholds[i] ?? Infinity)) {
            return colors[i] ?? null;
        }
    }
    return "#7000A8";
}

function normalizeKey(key: string): string {
    return key.split("+").map((part) => part.trim()).filter(Boolean).map((part) =>
        part.length === 1 ? part.toLowerCase() : part[0].toUpperCase() + part.slice(1).toLowerCase()
    ).join("+");
}

export default {
    name: "Advanced Review Bottombar",
    setup(api) {
        const config = (): Config => loadConfig(api.getConfig<Partial<Config>>({}));
        const style = api.addStyle("");
        const generalSelectors = (c: Config) => [
            EDIT,
            MORE,
            SHOW_ANSWER,
            ".reviewer-bar .arbb-btn",
            ...(c.styleMainScreen ? [".overview #study", ".bottom-bar button"] : []),
        ];
        const restyle = () => {
            const c = config();
            style.textContent = layoutCss(c) + answerCss(c, false) + answerCss(c, true)
                + generalCss(c, false, generalSelectors(c)) + generalCss(c, true, generalSelectors(c));
        };
        restyle();

        /** Cards skipped this session, to bring back with Show Skipped. */
        const skipped: bigint[] = [];
        const actions: Record<Extra, () => void> = {
            info: () => api.actions.openCardInfo(),
            undo: () => void api.main.undoAction(),
            skip: () => void skip(),
            showSkipped: () => void showSkipped(),
        };
        const skip = async () => {
            const card = api.reviewer.card;
            if (!card || get(api.main.mainState) !== "review") {
                return;
            }
            const suspend = config().skipMethod === 2;
            await api.backend.buryOrSuspendCards({
                cardIds: [card.id],
                noteIds: [],
                mode: suspend ? BuryOrSuspendCardsRequest_Mode.SUSPEND : BuryOrSuspendCardsRequest_Mode.BURY_USER,
            });
            skipped.push(card.id);
        };
        const showSkipped = async () => {
            if (!skipped.length) {
                api.dialogs.tooltip("There are no skipped cards to show.");
                return;
            }
            const cids = skipped.splice(0);
            await api.backend.restoreBuriedAndSuspendedCards({ cids });
            api.dialogs.tooltip(`${cids.length} skipped card${cids.length === 1 ? "" : "s"} brought back.`);
        };

        const buttons = new Map<Extra, HTMLButtonElement>();
        for (const extra of EXTRAS) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = `arbb-btn arbb-${extra}`;
            button.onclick = () => actions[extra]();
            buttons.set(extra, button);
        }
        api.onUnload(() => buttons.forEach((b) => b.remove()));

        const attach = () => {
            const c = config();
            const bar = document.querySelector(".reviewer-bar");
            if (!bar) {
                return;
            }
            const start = bar.querySelector(".side.start");
            const middle = bar.querySelector(".middle");
            const end = bar.querySelector(".side.end");
            for (const extra of EXTRAS) {
                const button = buttons.get(extra)!;
                if (!c.extras[extra]) {
                    button.remove();
                    continue;
                }
                button.textContent = c.labels[extra];
                button.title = `Shortcut key: ${normalizeKey(c.shortcuts[extra]).toUpperCase()}`;
                const position = c.positions[extra];
                if (position === "left") {
                    start?.append(button);
                } else if (position === "right") {
                    const more = end?.querySelector(":scope > button:last-child");
                    if (more && more !== button) {
                        more.before(button);
                    }
                } else if (position === "middle right") {
                    middle?.append(button);
                } else {
                    middle?.prepend(button);
                }
            }
        };
        const showEase = () => {
            const bar = document.querySelector<HTMLElement>(".reviewer-bar");
            const card = api.reviewer.card;
            const c = config();
            if (!bar || !card) {
                return;
            }
            const border = c.easeBorder ? easeBorderColor(card.ctype, card.easeFactor, c.easeThresholds, c.easeColors) : null;
            if (border) {
                bar.style.setProperty("--arbb-ease-border", color(border));
            } else {
                bar.style.removeProperty("--arbb-ease-border");
            }
        };
        api.hooks.reviewerDidShowQuestion.append(() => {
            attach();
            showEase();
        });
        api.hooks.reviewerDidShowAnswer.append(attach);
        api.hooks.reviewerWillEnd.append(() => buttons.forEach((b) => b.remove()));

        // the answer confirmation tooltip, on the button pressed or at a fixed place
        let pressed: DOMRect | null = null;
        let tooltipTimer: ReturnType<typeof setTimeout> | null = null;
        const tooltip = document.createElement("div");
        tooltip.className = "arbb-tooltip";
        api.onUnload(() => tooltip.remove());
        api.hooks.reviewerWillAnswerCard.append((value, _card) => {
            const ease = value[1];
            pressed = document.querySelector(`.reviewer-bar button.ease${ease}`)?.getBoundingClientRect() ?? null;
            return value;
        });
        api.hooks.reviewerDidAnswerCard.append((_card, ease) => {
            const c = config();
            if (!c.tooltip || ease < 1 || ease > 4) {
                return;
            }
            const key = EASES[ease - 1];
            const background = c.customColors ? color(c.colors[key]) : DEFAULTS.colors[key];
            tooltip.textContent = c.labels[key];
            tooltip.style.background = background;
            tooltip.style.color = color(c.tooltipTextColor);
            if (c.tooltipFixed || !pressed) {
                const width = Math.min(Number(c.tooltipWidth) || 300, innerWidth);
                const height = Math.min(Number(c.tooltipHeight) || 100, innerHeight);
                Object.assign(tooltip.style, {
                    width: `${width}px`,
                    height: `${height}px`,
                    left: `${Math.max(0, Math.min(Number(c.tooltipX) || 0, innerWidth - width))}px`,
                    top: `${Math.max(0, Math.min(Number(c.tooltipY) || 0, innerHeight - height))}px`,
                });
            } else {
                Object.assign(tooltip.style, {
                    width: `${pressed.width}px`,
                    height: `${pressed.height}px`,
                    left: `${pressed.left}px`,
                    top: `${pressed.top}px`,
                });
            }
            document.body.append(tooltip);
            if (tooltipTimer) {
                clearTimeout(tooltipTimer);
            }
            tooltipTimer = setTimeout(() => tooltip.remove(), Number(c.tooltipMs) || 500);
        });

        api.hooks.stateShortcutsWillChange.append((state, shortcuts) => {
            if (state !== "review") {
                return;
            }
            const c = config();
            for (const extra of EXTRAS) {
                if (c.extras[extra] && c.shortcuts[extra].trim()) {
                    shortcuts.push([normalizeKey(c.shortcuts[extra]), actions[extra]]);
                }
            }
        });

        api.setConfigAction(() => configure(api, config, () => {
            restyle();
            attach();
            api.reapplyShortcuts();
        }));
    },
} satisfies Plugin;

const SECTIONS = ["Styles", "Answer tooltip", "Bottom bar buttons", "Button sizes", "Button labels", "Colours"];

async function configure(api: PluginApi, config: () => Config, apply: () => void): Promise<void> {
    const section = await api.dialogs.chooseFrom("Settings to change:", SECTIONS, { title: "Advanced Review Bottombar" });
    if (section === null || section < 0) {
        return;
    }
    const c = config();
    const select = (key: string, label: string, value: number, options: string[]): FormField => ({
        key,
        label,
        type: "select",
        value: String(value),
        options: options.map((o, i) => ({ value: String(i), label: o })),
    });
    let fields: FormField[] = [];
    switch (section) {
        case 0:
            fields = [
                select("buttonStyle", "Answer button style", c.buttonStyle, [
                    "Default + Text Color",
                    "Default + Background Color",
                    "Wide + Text Color",
                    "Wide + Background Color",
                    "Neon 1",
                    "Neon 2",
                    "Fill 1",
                    "Fill 2",
                ]),
                select("generalStyle", "Other buttons' style", c.generalStyle, ["Default", "Neon 1", "Neon 2", "Fill 1", "Fill 2"]),
                select("hoverEffect", "Hover effect", c.hoverEffect, ["Disable", "Brighten", "Glow", "Brighten + Glow"]),
                select("activeIndicator", "Active indicator", c.activeIndicator, ["Disable", "Border", "Glow"]),
                { key: "pointerCursor", label: "Pointer cursor over buttons", type: "checkbox", value: c.pointerCursor },
                select("intervalStyle", "Interval style", c.intervalStyle, ["Stock", "Colored Stock", "Inside the Buttons"]),
                { key: "transitionMs", label: "Transition time (ms)", type: "number", value: c.transitionMs, min: 0, max: 5000 },
                { key: "borderRadius", label: "Border radius (px)", type: "number", value: c.borderRadius, min: 0, max: 50 },
                { key: "widePercent", label: "Wide buttons' width (%)", type: "number", value: c.widePercent, min: 10, max: 100 },
                { key: "styleMainScreen", label: "Style the deck list and overview buttons too", type: "checkbox", value: c.styleMainScreen },
                { key: "easeBorder", label: "Show Answer border shows the card's ease", type: "checkbox", value: c.easeBorder },
                select("skipMethod", "Skip method", c.skipMethod, ["Next Card", "Bury", "Suspend"]),
            ];
            break;
        case 1:
            fields = [
                { key: "tooltip", label: "Review confirmation tooltip", type: "checkbox", value: c.tooltip },
                select("tooltipFixed", "Tooltip position", c.tooltipFixed ? 1 : 0, ["On Buttons", "Fixed Position"]),
                { key: "tooltipMs", label: "Show for (ms)", type: "number", value: c.tooltipMs, min: 100, max: 10000 },
                { key: "tooltipTextColor", label: "Text colour", type: "color", value: c.tooltipTextColor },
                { key: "tooltipWidth", label: "Fixed tooltip width (px)", type: "number", value: c.tooltipWidth, min: 20 },
                { key: "tooltipHeight", label: "Fixed tooltip height (px)", type: "number", value: c.tooltipHeight, min: 20 },
                { key: "tooltipX", label: "Fixed tooltip left (px)", type: "number", value: c.tooltipX, min: 0 },
                { key: "tooltipY", label: "Fixed tooltip top (px)", type: "number", value: c.tooltipY, min: 0 },
            ];
            break;
        case 2:
            fields = EXTRAS.flatMap((extra): FormField[] => [
                { key: `extras.${extra}`, label: `${DEFAULTS.labels[extra]} button`, type: "checkbox", value: c.extras[extra] },
                {
                    key: `positions.${extra}`,
                    label: "Position",
                    type: "select",
                    value: c.positions[extra],
                    options: ["left", "middle left", "middle right", "right"].map((p) => ({ value: p, label: p })),
                },
                { key: `shortcuts.${extra}`, label: "Shortcut", type: "text", value: c.shortcuts[extra] },
            ]).concat((["hard", "good", "easy"] as const).map((ease): FormField => ({
                key: `hide.${ease}`,
                label: `Hide ${DEFAULTS.labels[ease]}`,
                type: "checkbox",
                value: c.hide[ease],
            })));
            break;
        case 3:
            fields = [
                { key: "customSizes", label: "Custom button sizes", type: "checkbox", value: c.customSizes },
                { key: "height", label: "Height of all buttons (px)", type: "number", value: c.height, min: 10, max: 200 },
                ...(["edit", "showAnswer", "more", "review", ...EXTRAS] as const).map((key): FormField => ({
                    key: `widths.${key}`,
                    label: `Width: ${key === "review" ? "answer buttons" : DEFAULTS.labels[key]} (px)`,
                    type: "number",
                    value: c.widths[key],
                    min: 10,
                    max: 600,
                })),
                { key: "textSize", label: "Text size (px)", type: "number", value: c.textSize, min: 6, max: 60 },
                select("fontWeight", "Font weight", c.fontWeight, [
                    "Thin",
                    "Extra Light",
                    "Light",
                    "Normal",
                    "Medium",
                    "Semi Bold",
                    "Bold",
                    "Extra Bold",
                    "Black",
                ]),
            ];
            break;
        case 4:
            fields = (Object.keys(DEFAULTS.labels) as (keyof Config["labels"])[]).map((key): FormField => ({
                key: `labels.${key}`,
                label: DEFAULTS.labels[key],
                type: "text",
                value: c.labels[key],
            }));
            break;
        case 5:
            fields = [
                { key: "customColors", label: "Custom answer button colours", type: "checkbox", value: c.customColors },
                ...EASES.flatMap((ease): FormField[] => [
                    { key: `colors.${ease}`, label: DEFAULTS.labels[ease], type: "color", value: c.colors[ease] },
                    { key: `hoverColors.${ease}`, label: `${DEFAULTS.labels[ease]} on hover`, type: "color", value: c.hoverColors[ease] },
                ]),
                { key: "customTextColor", label: "Custom answer button text colour", type: "checkbox", value: c.customTextColor },
                { key: "textColor", label: "Answer button text colour", type: "color", value: c.textColor },
                { key: "customActiveColor", label: "Custom active indicator colour", type: "checkbox", value: c.customActiveColor },
                { key: "activeColor", label: "Active indicator colour", type: "color", value: c.activeColor },
                { key: "customGeneralText", label: "Custom other buttons' text colour", type: "checkbox", value: c.customGeneralText },
                { key: "generalText", label: "Other buttons' text colour", type: "color", value: c.generalText },
                { key: "customGeneralBorder", label: "Custom other buttons' border colour", type: "checkbox", value: c.customGeneralBorder },
                { key: "generalBorder", label: "Other buttons' border colour", type: "color", value: c.generalBorder },
                ...c.easeColors.map((value, i): FormField => ({
                    key: `easeColors.${i}`,
                    label: `Show Answer border below ${c.easeThresholds[i]}% ease`,
                    type: "color",
                    value,
                })),
            ];
            break;
    }
    const values = await api.dialogs.openForm(fields, { title: `Advanced Review Bottombar: ${SECTIONS[section]}` });
    if (!values) {
        return;
    }
    const next = structuredClone(c) as unknown as Record<string, unknown>;
    for (const [key, raw] of Object.entries(values)) {
        const [head, sub] = key.split(".");
        const current = sub === undefined ? next[head] : (next[head] as Record<string, unknown>)[sub];
        const value = typeof current === "number" ? Number(raw) : typeof current === "boolean" && typeof raw === "string"
            ? raw === "1"
            : raw;
        if (sub === undefined) {
            next[head] = value;
        } else {
            (next[head] as Record<string, unknown>)[sub] = value;
        }
    }
    api.setConfig(next);
    apply();
}
