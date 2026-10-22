// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Basic Printing Support, AnkiWeb 1025789669: Tools > Print (Shift+P) lays
 * out the answers of the cards in the current deck and its subdecks, in
 * sort field order, in a table with "cardsPerRow" cards a row, for printing.
 * As in the original, card styling is left out and audio is not shown.
 * Desktop writes the page to a file and opens it in a browser; here it opens
 * in a preview with a Print button.
 */

import type { RenderedTemplateNode } from "@generated/anki/card_rendering_pb";

import type { CardContext } from "$web/plugins/hooks";
import type { Plugin, PluginApi } from "$web/plugins/loader";

interface Config {
    cardsPerRow: number;
}

const DEFAULTS: Config = { cardsPerRow: 3 };

const PAGE_CSS = `
img { max-width: 100%; }
tr { page-break-inside:avoid; page-break-after:auto }
td { page-break-after:auto; }
td { border: 1px solid #ccc; padding: 1em; }
.playImage, .replay-button { display: none; }
`;

const OVERLAY_CSS = `
.print-preview {
    position: fixed;
    inset: 0;
    z-index: 900;
    display: flex;
    flex-direction: column;
    background: var(--canvas);
    color: var(--fg);
}
.print-preview header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
    background: var(--canvas-elevated);
}
.print-preview header .title { flex: 1; font-weight: bold; }
.print-preview iframe { flex: 1; border: 0; background: white; width: 100%; }
`;

/** Strips the type-in-the-answer box (the original's esc()). */
export function stripTypeAnswer(html: string): string {
    return html.replace(/\[\[type:[^\]]+\]\]/g, "");
}

/** The table of cards (the original's onPrint). */
export function printPage(answers: string[], cardsPerRow: number, base: string): string {
    const perRow = Math.max(1, Math.floor(cardsPerRow) || 1);
    let rows = "";
    for (let i = 0; i < answers.length; i += perRow) {
        const cells = answers
            .slice(i, i + perRow)
            .map((html) => `<td width="${100 / perRow}%"><center>${stripTypeAnswer(html)}</center></td>`)
            .join("");
        rows += `<tr>${cells}</tr>`;
    }
    return `<html><head><meta charset="utf-8"><base href="${base}">`
        + `<style>${PAGE_CSS}</style></head><body><table cellspacing=10 width=100%>${rows}</table></body></html>`;
}

function applyFilters(api: PluginApi, nodes: RenderedTemplateNode[], ctx: CardContext, frontSide: string): string {
    let out = "";
    for (const node of nodes) {
        if (node.value.case === "text") {
            out += node.value.value;
        } else if (node.value.case === "replacement") {
            const replacement = node.value.value;
            let text = replacement.fieldName === "FrontSide" ? frontSide : replacement.currentText;
            for (const filter of replacement.filters) {
                text = api.hooks.fieldFilter.run(text, replacement.fieldName, filter, ctx);
            }
            out += text;
        }
    }
    return out;
}

/** A card's answer as the reviewer would show it, without its audio. */
async function renderAnswer(api: PluginApi, cardId: bigint): Promise<string> {
    const output = await api.backend.renderExistingCard({ cardId, browser: false, partialRender: true });
    const card = await api.backend.getCard({ cid: cardId });
    const note = await api.backend.getNote({ nid: card.noteId });
    const notetype = await api.backend.getNotetype({ ntid: note.notetypeId });
    const ctx: CardContext = {
        cardId,
        noteId: card.noteId,
        ord: card.templateIdx,
        fields: Object.fromEntries(notetype.fields.map((f, i) => [f.name, note.fields[i] ?? ""])),
        questionSide: true,
    };
    const question = (await api.backend.extractAvTags({
        text: applyFilters(api, output.questionNodes, ctx, ""),
        questionSide: true,
    })).text;
    const answer = (await api.backend.extractAvTags({
        text: applyFilters(api, output.answerNodes, { ...ctx, questionSide: false }, question),
        questionSide: false,
    })).text;
    const shown = answer.replace(/\[anki:play:.:\d+\]/g, "");
    return (await api.backend.encodeIriPaths({ val: shown })).val;
}

/** The current deck and its subdecks' cards in sort field order (the original's sortFieldOrderCids). */
async function cardIds(api: PluginApi): Promise<bigint[]> {
    const current = (await api.backend.getCurrentDeck({})).id;
    const tree = await api.backend.deckTree({ now: 0n });
    const ids: bigint[] = [];
    const collect = (node: typeof tree, inside: boolean) => {
        const within = inside || node.deckId === current;
        if (within) {
            ids.push(node.deckId);
        }
        node.children.forEach((child) => collect(child, within));
    };
    collect(tree, false);
    if (!ids.length) {
        ids.push(current);
    }
    const rows = await api.db.all(
        `select c.id from cards c, notes n where c.did in (${ids.join(",")}) and c.nid = n.id order by n.sfld`,
    );
    return rows.map((row) => BigInt(row[0] as number));
}

async function onPrint(api: PluginApi, config: Config): Promise<void> {
    const overlay = document.createElement("div");
    overlay.className = "print-preview";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Print");
    const header = document.createElement("header");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "Print";
    const print = document.createElement("button");
    print.type = "button";
    print.className = "btn btn-primary";
    print.textContent = "Print";
    print.disabled = true;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn btn-secondary";
    close.textContent = "Close";
    header.append(title, print, close);
    const frame = document.createElement("iframe");
    frame.title = "Print preview";
    overlay.append(header, frame);
    let closed = false;
    const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
            event.stopPropagation();
            finish();
        }
    };
    const finish = () => {
        closed = true;
        overlay.remove();
        removeEventListener("keydown", onKey, true);
    };
    close.onclick = finish;
    print.onclick = () => frame.contentWindow?.print();
    addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    close.focus();

    try {
        const ids = await cardIds(api);
        const answers: string[] = [];
        for (const [i, id] of ids.entries()) {
            if (closed) {
                return;
            }
            answers.push(await renderAnswer(api, id));
            if (i % 50 === 0) {
                title.textContent = `Cards exported: ${i + 1}`;
            }
        }
        if (closed) {
            return;
        }
        title.textContent = `Print: ${ids.length} cards`;
        frame.srcdoc = printPage(answers, config.cardsPerRow, `${location.origin}/`);
        frame.addEventListener("load", () => {
            print.disabled = false;
            print.focus();
        }, { once: true });
    } catch (err) {
        finish();
        await api.dialogs.showError(err);
    }
}

export default {
    name: "Basic Printing Support",
    setup(api) {
        const config = (): Config => ({ ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) });
        api.addStyle(OVERLAY_CSS);
        const run = () => {
            if (document.querySelector(".print-preview")) {
                return;
            }
            void onPrint(api, config());
        };
        api.hooks.mainMenuWillShow.append((sections) => {
            // Tools, whatever the language
            (sections.find((s) => s.title.replace(/&/g, "") === "Tools") ?? sections[3])?.items.push({
                label: "Print",
                shortcut: "Shift+P",
                action: run,
            });
        });
        api.hooks.globalShortcutsWillChange.append((shortcuts) => {
            shortcuts.push(["Shift+P", run]);
        });
        api.setConfigAction(async () => {
            const values = await api.dialogs.openForm(
                [{ key: "cardsPerRow", label: "Cards a row", type: "number", value: config().cardsPerRow, min: 1, max: 10 }],
                { title: "Basic Printing Support" },
            );
            if (values) {
                api.setConfig({ cardsPerRow: Number(values.cardsPerRow) || DEFAULTS.cardsPerRow });
            }
        });
    },
} satisfies Plugin;
