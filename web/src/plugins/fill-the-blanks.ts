// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Fill the blanks - Multiple type:cloze support, AnkiWeb 1933645497: with
 * {{fill-blanks:cloze:Text}} on the front of a cloze card, each blank of the
 * card becomes a text box to type the answer in. Instant feedback colours a
 * box yellow while what is typed is right so far, green when it is right and
 * red when it is wrong; Ctrl+? types the next letter. Enter shows the answer,
 * where each blank shows the typed answer struck through next to the right
 * one, or in green if it was right. The options are the original's.
 */

import type { Plugin } from "$web/plugins/loader";

interface Config {
    feedbackEnabled: boolean;
    ignoreCase: boolean;
    ignoreAccents: boolean;
    /** Checks on every input, for IMEs that send no key events (the original's experimental-asian-chars). */
    asianChars: boolean;
}

const DEFAULTS: Config = { feedbackEnabled: true, ignoreCase: false, ignoreAccents: false, asianChars: false };

const PREFIX = "ftb:";

const CSS = `
input.ftb { border-radius: 5px; border: 1px solid; min-width: 50px; max-width: 400px; padding: 3px; margin: 2px; font: inherit; }
input.ftb-xs { width: 60px; }
input.ftb-sm { width: 100px; }
input.ftb-md { width: 150px; }
input.ftb-lg { width: 300px; }
input.st-incomplete { background-color: #FFFF77; color: #333; }
input.st-error { background-color: #ff9999; color: #333; }
input.st-ok { background-color: #99ff99; color: #333; }
.cloze.st-error { color: #ff4949; text-decoration: line-through; margin-right: 3px; }
.cloze.st-expected { color: orange; text-decoration: none; }
.cloze.st-ok { color: #3bd03b; }
`;

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Plain text of some HTML, as the reviewer compares typed answers (the original's _clear_correct_value_as_reviewer). */
export function plainAnswer(html: string): string {
    const withSpaces = html.replace(/(\n|<br ?\/?>|<\/?div>)+/gi, " ");
    const template = document.createElement("template");
    template.innerHTML = withSpaces;
    return (template.content.textContent ?? "").replace(/ /g, " ").replace(/​/g, "").trim();
}

/** The width class of a box (the original's _get_length_class). */
export function lengthClass(answer: string, hint: string): string {
    const size = Math.max(answer.length, hint.length);
    return size <= 5 ? "ftb-xs" : size <= 10 ? "ftb-sm" : size > 20 ? "ftb-lg" : "ftb-md";
}

/** Turns the blanks of card `ord` in a rendered cloze field into text boxes. */
export function toBoxes(html: string, ord: number): { html: string; count: number } {
    const template = document.createElement("template");
    template.innerHTML = html;
    let count = 0;
    for (const span of template.content.querySelectorAll<HTMLElement>("span.cloze")) {
        if ((span.dataset.ordinal ?? "-1") !== String(ord + 1)) {
            continue;
        }
        const answer = plainAnswer(span.dataset.cloze ?? span.innerHTML);
        const shown = span.textContent ?? "";
        const hint = shown && shown !== answer && shown !== "[...]" ? shown.replace(/^\[/, "").replace(/\]$/, "") : "";
        const box = document.createElement("span");
        box.className = "ftb-container";
        box.innerHTML = `<input type="text" class="ftb ${lengthClass(answer, hint)}" data-ftb-index="${count}" `
            + `data-ftb-answer="${escapeHtml(answer)}" placeholder="${escapeHtml(hint)}" `
            + `autocomplete="off" autocapitalize="off" spellcheck="false">`;
        span.replaceWith(box);
        count++;
    }
    return { html: count ? template.innerHTML : html, count };
}

/** Marks each blank on the answer side right or wrong (the original's handle_answer). */
export function markAnswers(html: string, typed: string[], ignoreCase: boolean): string {
    const template = document.createElement("template");
    template.innerHTML = html;
    const spans = [...template.content.querySelectorAll<HTMLElement>("span.cloze")];
    if (!spans.length || spans.length !== typed.length) {
        return html;
    }
    spans.forEach((span, i) => {
        const expected = (span.textContent ?? "").trim();
        const given = (typed[i] ?? "").trim();
        const right = given === expected || (ignoreCase && given.toLowerCase() === expected.toLowerCase());
        span.outerHTML = right
            ? `<span class="cloze st-ok">${escapeHtml(expected)}</span>`
            : `<del class="cloze st-error" title="Typed: ${escapeHtml(given)}">${escapeHtml(given)}</del>`
                + `<ins class="cloze st-expected">${escapeHtml(expected)}</ins>`;
    });
    return template.innerHTML;
}

/** Runs in the card frame; self-contained, since it is sent as source text. */
function cardScript(options: Config, cardId: string): void {
    const inputs = [...document.querySelectorAll<HTMLInputElement>("input.ftb")];
    const words = inputs.map(() => "");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pycmd = (window as any).pycmd as (cmd: string) => void;
    const send = () => pycmd(`ftb:typed:${JSON.stringify({ cardId, words })}`);
    const normalize = (text: string) => {
        if (options.ignoreCase) {
            text = text.toLowerCase();
        }
        if (options.ignoreAccents) {
            text = text.normalize("NFD").replace(/[̀-ͯ]/g, "");
        }
        return text;
    };
    inputs.forEach((input, i) => {
        const expected = input.dataset.ftbAnswer ?? "";
        let last = "";
        const check = () => {
            words[i] = input.value.trim();
            if (!options.feedbackEnabled) {
                return;
            }
            const current = input.value.trim();
            if (current === last) {
                return;
            }
            last = current;
            input.classList.remove("st-ok", "st-incomplete", "st-error");
            if (!current) {
                return;
            }
            const typed = normalize(current);
            const reference = normalize(expected);
            input.classList.add(typed === reference ? "st-ok" : reference.startsWith(typed) ? "st-incomplete" : "st-error");
        };
        input.addEventListener("input", () => {
            words[i] = input.value.trim();
            send();
            if (options.asianChars) {
                check();
            }
        });
        input.addEventListener("keyup", () => {
            if (!options.asianChars) {
                check();
            }
        });
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                words[i] = input.value.trim();
                send();
                pycmd("ans");
                return;
            }
            // the next letter of the answer, until the box is right or wrong
            const hintKey = (event.key === "?" && event.ctrlKey) || (event.metaKey && event.shiftKey && event.key === "/");
            if (hintKey) {
                event.preventDefault();
                const current = input.value;
                const settled = input.classList.contains("st-ok") || input.classList.contains("st-error");
                if (!settled && current.length < expected.length) {
                    input.value = current + expected.charAt(current.length);
                    input.dispatchEvent(new Event("input"));
                    check();
                }
            }
        });
    });
    send();
    setTimeout(() => inputs[0]?.focus(), 300);
}

export default {
    name: "Fill the blanks",
    setup(api) {
        const config = (): Config => ({ ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) });
        /** The card whose question has boxes, and what was typed in them. */
        let current: { cardId: bigint; count: number; typed: string[] } | null = null;

        api.hooks.fieldFilter.append((text, _field, filter, card) => {
            if (filter !== "fill-blanks" || !card.questionSide) {
                return text;
            }
            return toBoxes(text, card.ord).html;
        });

        api.hooks.cardWillShow.append((html, card, kind) => {
            if (kind === "reviewQuestion") {
                const count = (html.match(/class="ftb-container"/g) ?? []).length;
                current = count ? { cardId: card.cardId, count, typed: Array(count).fill("") } : null;
                if (!count) {
                    return html;
                }
                return `${html}<style>${CSS}</style><script>(${cardScript.toString()})(${
                    JSON.stringify(config())
                }, "${card.cardId}");</script>`;
            }
            if (kind === "reviewAnswer" && current?.cardId === card.cardId) {
                return `${markAnswers(html, current.typed, config().ignoreCase)}<style>${CSS}</style>`;
            }
            return html;
        });

        api.hooks.webviewDidReceiveBridgeCommand.append((handled, cmd, context) => {
            if (handled[0] || context !== "reviewer" || !cmd.startsWith(`${PREFIX}typed:`)) {
                return handled;
            }
            try {
                const data = JSON.parse(cmd.slice(`${PREFIX}typed:`.length)) as { cardId: string; words: unknown[] };
                if (current && String(current.cardId) === data.cardId && Array.isArray(data.words)) {
                    current.typed = data.words.slice(0, current.count).map(String);
                }
            } catch {
                // ignore malformed messages
            }
            return [true, undefined];
        });

        api.setConfigAction(async () => {
            const c = config();
            const values = await api.dialogs.openForm(
                [
                    { key: "feedbackEnabled", label: "Instant feedback while typing", type: "checkbox", value: c.feedbackEnabled },
                    { key: "ignoreCase", label: "Ignore case", type: "checkbox", value: c.ignoreCase },
                    { key: "ignoreAccents", label: "Ignore accents in instant feedback", type: "checkbox", value: c.ignoreAccents },
                    {
                        key: "asianChars",
                        label: "Check on every input (for Japanese, Chinese and Korean input)",
                        type: "checkbox",
                        value: c.asianChars,
                    },
                ],
                {
                    title: "Fill the blanks",
                    text: "Use {{fill-blanks:cloze:Text}} on the front of a cloze note type instead of {{cloze:Text}}.",
                },
            );
            if (values) {
                api.setConfig({ ...c, ...values });
            }
        });
    },
} satisfies Plugin;
