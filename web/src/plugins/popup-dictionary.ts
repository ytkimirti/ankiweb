// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Pop-up Dictionary, AnkiWeb 153625306: double-click a word or phrase on a
 * card while reviewing (or select it and press Alt+Shift+D) to see, in a
 * pop-up, its definition from your "Dictionary Entry" notes and the other
 * notes that contain it, optionally only in the current deck. Words in a
 * pop-up can be looked up in turn, in a pop-up of their own, and the arrow
 * by each note opens it in the browser. As the original does, it adds the
 * Dictionary Entry note type (Term, Definition) when it is missing. The
 * options are the original's.
 */

import { SearchNode, SearchNode_Group_Joiner } from "@generated/anki/search_pb";
import { get } from "svelte/store";

import type { Plugin, PluginApi } from "$web/plugins/loader";

import { addNotetype, notetypeIdByName, withEntries } from "./shared/notetypes";

interface Config {
    generalConfirmEmpty: boolean;
    generalHotkey: string;
    dictionaryEnabled: boolean;
    dictionaryNoteTypeName: string;
    dictionaryTermFieldName: string;
    dictionaryDefinitionFieldName: string;
    snippetsEnabled: boolean;
    snippetsExcludedFields: string[];
    snippetsExcludeNewNotes: boolean;
    snippetsLimitToCurrentDeck: boolean;
    snippetsResultsWarnLimit: number;
}

const DEFAULTS: Config = {
    generalConfirmEmpty: true,
    generalHotkey: "Alt+Shift+D",
    dictionaryEnabled: true,
    dictionaryNoteTypeName: "Dictionary Entry",
    dictionaryTermFieldName: "Term",
    dictionaryDefinitionFieldName: "Definition",
    snippetsEnabled: true,
    snippetsExcludedFields: ["Note ID", "ID (hidden)"],
    snippetsExcludeNewNotes: false,
    snippetsLimitToCurrentDeck: true,
    snippetsResultsWarnLimit: 1000,
};

const PREFIX = "popupDictionary";

const CLOZE_RE = /\{\{c(\d+)::(.*?)(::(.*?))?\}\}/g;

/** Removes cloze markers, keeping the text (the original's cloze_re.sub). */
export function stripClozes(html: string): string {
    return html.replace(CLOZE_RE, "$2");
}

/** A search for notes containing `term`, as the original's query. */
export function snippetSearch(term: string, currentNid: bigint, ignoreNid: string, config: Config): SearchNode {
    const nodes = [
        new SearchNode({ filter: { case: "literalText", value: term } }),
        new SearchNode({ filter: { case: "negated", value: new SearchNode({ filter: { case: "nid", value: currentNid } }) } }),
    ];
    if (/^\d+$/.test(ignoreNid)) {
        nodes.push(new SearchNode({
            filter: { case: "negated", value: new SearchNode({ filter: { case: "nid", value: BigInt(ignoreNid) } }) },
        }));
    }
    if (config.snippetsLimitToCurrentDeck) {
        nodes.push(new SearchNode({ filter: { case: "deck", value: "current" } }));
    }
    if (config.snippetsExcludeNewNotes) {
        nodes.push(new SearchNode({ filter: { case: "parsableText", value: "-is:new" } }));
    }
    return new SearchNode({ filter: { case: "group", value: { nodes, joiner: SearchNode_Group_Joiner.AND } } });
}

const POPUP_CSS = `
.pdict-popup {
    position: absolute; z-index: 10000; box-sizing: border-box;
    max-width: min(440px, calc(100vw - 16px)); max-height: 440px; padding: 4px;
    color: #141414; background: white; border-radius: 8px; box-shadow: 0 0 20px rgba(0, 0, 0, 0.4);
    font: 16px arial, sans-serif; text-align: initial; font-style: normal; font-weight: 400;
}
.nightMode .pdict-popup { color: #fffafa; background: #121212; box-shadow: 0 0 20px rgba(10, 10, 10, 0.4); }
.pdict-popup.pdict-disabled { filter: blur(1px); }
.pdict-popup .pdict-content { margin: 5px 0; padding: 5px 10px; max-height: 400px; overflow-y: auto; }
.pdict-popup img, .pdict-popup iframe { max-width: 100%; max-height: 100%; }
.nightMode .pdict-popup img { background: white; }
.pdict-popup .pdict-reslist { text-align: center; }
.pdict-popup .pdict-res {
    position: relative; margin: 0 0 1em; padding: 0.5em; border: 1px solid #c1c1c1; border-radius: 4px;
}
.nightMode .pdict-popup .pdict-res { border-color: #2f2f31; }
.pdict-popup .pdict-brws {
    position: absolute; bottom: 5px; right: 2px; line-height: 5px; font-size: 1.2em; color: #00a8a8; cursor: pointer;
}
.nightMode .pdict-popup .pdict-brws { color: #ffde59; }
.pdict-popup .pdict-dict { background: #f2f2f2; }
.nightMode .pdict-popup .pdict-dict { background: #0d0d0d; }
.pdict-popup .pdict-dict-title { font-weight: bold; text-align: center; }
.pdict-popup .pdict-fld { margin-top: 0.5em; }
.pdict-popup .pdict-highlight { background: #ffffa5; }
.nightMode .pdict-popup .pdict-highlight { color: black; }
`;

/** Runs in the card frame; self-contained, since it is sent as source text. */
function cardScript(hotkey: string, css: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.__pdictHotkey = hotkey;
    if (w.__pdict) {
        w.__pdict.hideFrom(0);
        return;
    }
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const popups: HTMLElement[] = [];
    const hideFrom = (level: number) => {
        for (const popup of popups.splice(level)) {
            popup.remove();
        }
    };
    const focus = (popup: HTMLElement) => {
        popups.forEach((p) => p.classList.toggle("pdict-disabled", p !== popup));
    };
    w.__pdict = { hideFrom };

    const highlight = (root: HTMLElement, term: string) => {
        const lower = term.toLowerCase();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const hits: Text[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!(node.parentElement?.closest(".pdict-dict")) && node.textContent?.toLowerCase().includes(lower)) {
                hits.push(node as Text);
            }
        }
        for (let node of hits) {
            for (let at = node.textContent!.toLowerCase().indexOf(lower); at >= 0; at = node.textContent!.toLowerCase().indexOf(lower)) {
                const match = node.splitText(at);
                node = match.splitText(term.length);
                const mark = document.createElement("span");
                mark.className = "pdict-highlight";
                match.replaceWith(mark);
                mark.append(match);
            }
        }
    };

    const show = (x: number, y: number) => {
        const selection = getSelection();
        const term = selection?.toString().trim() ?? "";
        const anchor = selection?.rangeCount ? selection.getRangeAt(0).startContainer : null;
        const inside = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest<HTMLElement>(".pdict-popup");
        const level = inside ? popups.indexOf(inside) + 1 : 0;
        hideFrom(level);
        if (term.length < 3) {
            return;
        }
        const resElm = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest<HTMLElement>(".pdict-res");
        const ignoreNid = inside && resElm?.dataset.nid ? resElm.dataset.nid : "";
        w.pycmd(`popupDictionaryLookup:${JSON.stringify([term, ignoreNid])}`, (html: unknown) => {
            if (typeof html !== "string" || !html || popups.length !== level) {
                return;
            }
            const popup = document.createElement("div");
            popup.className = "pdict-popup";
            const content = document.createElement("div");
            content.className = "pdict-content";
            content.innerHTML = html;
            popup.append(content);
            popup.addEventListener("mouseenter", () => focus(popup));
            popup.addEventListener("click", () => popup.classList.remove("pdict-disabled"));
            document.body.append(popup);
            popups.push(popup);
            highlight(content, term);
            // at the pointer, flipped to stay on the page
            const width = popup.offsetWidth;
            const height = popup.offsetHeight;
            const left = x + width > innerWidth + scrollX - 8 ? Math.max(scrollX + 8, x - width) : x;
            const top = y + height > innerHeight + scrollY - 8 ? Math.max(scrollY + 8, y - height) : y;
            popup.style.left = `${left}px`;
            popup.style.top = `${top}px`;
            focus(popup);
        });
    };

    // a double click, or a double click held and dragged over other elements
    let clicks = 0;
    document.addEventListener("mousedown", (event) => {
        clicks++;
        setTimeout(() => (clicks = 0), 500);
        if (clicks === 2) {
            document.addEventListener("mouseup", (up) => {
                show(up.pageX, up.pageY);
                clicks = 0;
            }, { once: true });
        } else {
            const popup = (event.target as Element | null)?.closest?.<HTMLElement>(".pdict-popup");
            hideFrom(popup ? popups.indexOf(popup) + 1 : 0);
        }
    }, true);
    document.addEventListener("click", (event) => {
        const browse = (event.target as Element | null)?.closest?.<HTMLElement>(".pdict-brws");
        const nid = browse?.closest<HTMLElement>(".pdict-res")?.dataset.nid;
        if (nid) {
            w.pycmd(`popupDictionaryBrowse:${nid}`);
        }
    });
    document.addEventListener("keydown", (event) => {
        const parts = String(w.__pdictHotkey).toLowerCase().split("+");
        const key = parts.pop();
        const mods = { ctrl: event.ctrlKey || event.metaKey, alt: event.altKey, shift: event.shiftKey };
        const wanted = { ctrl: parts.includes("ctrl") || parts.includes("cmd"), alt: parts.includes("alt"), shift: parts.includes("shift") };
        if (key && event.code === `Key${key.toUpperCase()}` && mods.ctrl === wanted.ctrl && mods.alt === wanted.alt && mods.shift === wanted.shift) {
            event.preventDefault();
            event.stopImmediatePropagation();
            const range = getSelection()?.rangeCount ? getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
            show((range?.left ?? 0) + scrollX, (range?.bottom ?? 0) + scrollY);
        } else if (event.key === "Escape" && popups.length) {
            event.preventDefault();
            event.stopImmediatePropagation();
            hideFrom(0);
        }
    }, true);
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function lookUp(api: PluginApi, config: Config, term: string, ignoreNid: string): Promise<string> {
    const card = api.reviewer.card;
    if (!card || !term) {
        return "";
    }
    const content: string[] = [];
    if (config.dictionaryEnabled) {
        const search = new SearchNode({
            filter: {
                case: "group",
                value: {
                    joiner: SearchNode_Group_Joiner.AND,
                    nodes: [
                        new SearchNode({ filter: { case: "note", value: config.dictionaryNoteTypeName } }),
                        new SearchNode({
                            filter: { case: "field", value: { fieldName: config.dictionaryTermFieldName, text: term } },
                        }),
                    ],
                },
            },
        });
        const found = await api.backend.searchNotes({
            search: (await api.backend.buildSearchString(search)).val,
            order: { value: { case: "none", value: {} } },
        });
        if (found.ids.length) {
            const nid = found.ids[0];
            const note = await api.backend.getNote({ nid });
            const notetype = await api.backend.getNotetype({ ntid: note.notetypeId });
            const index = notetype.fields.findIndex((f) => f.name === config.dictionaryDefinitionFieldName);
            if (index >= 0) {
                content.push(`<div class="pdict-res pdict-dict" data-nid="${nid}">
    <div class="pdict-dict-title">Definition:</div>
    ${note.fields[index]}
    <div title="Browse..." class="pdict-brws">&rarr;</div>
</div>`);
            }
        }
    }
    let snippets: "none" | "declined" | "found" = "none";
    if (config.snippetsEnabled) {
        const search = (await api.backend.buildSearchString(snippetSearch(term, card.noteId, ignoreNid, config))).val;
        const ids = [...(await api.backend.searchNotes({ search, order: { value: { case: "none", value: {} } } })).ids]
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const limit = Number(config.snippetsResultsWarnLimit) || 0;
        if (ids.length && limit > 0 && ids.length > limit) {
            const proceed = await api.dialogs.askUser(
                `${ids.length} relevant notes found.\nThe pop-up could take a long time to show.\n\nAre you sure you want to proceed?`,
                { title: "Pop-up Dictionary" },
            );
            if (!proceed) {
                snippets = "declined";
            }
        }
        if (ids.length && snippets !== "declined") {
            snippets = "found";
            const excluded = new Set(config.snippetsExcludedFields);
            for (const nid of ids) {
                const note = await api.backend.getNote({ nid });
                const notetype = await api.backend.getNotetype({ ntid: note.notetypeId });
                const fields = notetype.fields
                    .map((f, i) => (excluded.has(f.name) ? "" : `<div class="pdict-fld">${note.fields[i] ?? ""}</div>`))
                    .join("");
                content.push(
                    `<div class="pdict-res" data-nid="${nid}">${stripClozes(fields)}<div title="Browse..." class="pdict-brws">&rarr;</div></div>`,
                );
            }
        }
    }
    if (content.length) {
        return `<div class="pdict-reslist">${content.join("")}</div>`;
    }
    if (snippets === "declined") {
        return "";
    }
    return config.generalConfirmEmpty ? `No other results found for <b>${escapeHtml(term)}</b>.` : "";
}

async function addDictionaryNotetype(api: PluginApi, config: Config): Promise<void> {
    if (await notetypeIdByName(api, config.dictionaryNoteTypeName)) {
        return;
    }
    await addNotetype(api, false, (nt) => {
        nt.name = config.dictionaryNoteTypeName;
        nt.flds = withEntries(nt.flds[0], [config.dictionaryTermFieldName, config.dictionaryDefinitionFieldName]);
        nt.tmpls = withEntries(nt.tmpls[0], ["Definition"], () => ({
            qfmt: `<b>Define</b>: {{${config.dictionaryTermFieldName}}}\n`,
            afmt: `{{FrontSide}}\n\n<hr id=answer>\n\n{{${config.dictionaryDefinitionFieldName}}}\n`,
        }));
        nt.css = ".card {\n    font-family: arial;\n    font-size: 20px;\n    text-align: center;\n    color: black;\n"
            + "    background-color: white;\n}\n";
    });
    api.main.reset();
}

export default {
    name: "Pop-up Dictionary",
    setup(api) {
        const config = (): Config => ({ ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) });
        let adding: Promise<void> | null = null;
        const maybeAddNotetype = () => {
            if (config().dictionaryEnabled && !adding) {
                adding = addDictionaryNotetype(api, config())
                    .catch((err) => console.error("pop-up dictionary", err))
                    .finally(() => (adding = null));
            }
        };
        api.hooks.profileDidOpen.append(maybeAddNotetype);
        if (["deckBrowser", "overview", "review"].includes(get(api.main.mainState))) {
            maybeAddNotetype();
        }

        api.hooks.cardWillShow.append((html, _card, kind) => {
            if (!kind.startsWith("review")) {
                return html;
            }
            return `${html}<script>(${cardScript.toString()})(${JSON.stringify(config().generalHotkey)}, ${
                JSON.stringify(POPUP_CSS)
            });</script>`;
        });

        api.hooks.webviewDidReceiveBridgeCommand.append((handled, cmd, context) => {
            if (handled[0] || context !== "reviewer" || !cmd.startsWith(PREFIX)) {
                return handled;
            }
            const colon = cmd.indexOf(":");
            const sub = cmd.slice(PREFIX.length, colon);
            const arg = cmd.slice(colon + 1);
            if (sub === "Browse" && /^\d+$/.test(arg)) {
                api.actions.openBrowser({ search: new SearchNode({ filter: { case: "nid", value: BigInt(arg) } }) });
                return [true, undefined];
            }
            if (sub === "Lookup") {
                try {
                    const [term, ignoreNid] = JSON.parse(arg) as [string, string];
                    return [true, lookUp(api, config(), String(term).trim(), String(ignoreNid ?? "")).catch((err) => {
                        console.error("pop-up dictionary", err);
                        return "";
                    })];
                } catch {
                    return [true, ""];
                }
            }
            return [true, undefined];
        });

        api.setConfigAction(async () => {
            const c = config();
            const values = await api.dialogs.openForm(
                [
                    { key: "generalHotkey", label: "Shortcut to look up the selection", type: "text", value: c.generalHotkey },
                    { key: "generalConfirmEmpty", label: "Say so when nothing is found", type: "checkbox", value: c.generalConfirmEmpty },
                    { key: "dictionaryEnabled", label: "Show definitions from dictionary notes", type: "checkbox", value: c.dictionaryEnabled },
                    { key: "dictionaryNoteTypeName", label: "Dictionary note type", type: "text", value: c.dictionaryNoteTypeName },
                    { key: "dictionaryTermFieldName", label: "Term field", type: "text", value: c.dictionaryTermFieldName },
                    {
                        key: "dictionaryDefinitionFieldName",
                        label: "Definition field",
                        type: "text",
                        value: c.dictionaryDefinitionFieldName,
                    },
                    { key: "snippetsEnabled", label: "Show other notes containing the term", type: "checkbox", value: c.snippetsEnabled },
                    {
                        key: "snippetsExcludedFields",
                        label: "Fields left out of notes (comma-separated)",
                        type: "text",
                        value: c.snippetsExcludedFields.join(", "),
                    },
                    { key: "snippetsExcludeNewNotes", label: "Leave out new notes", type: "checkbox", value: c.snippetsExcludeNewNotes },
                    {
                        key: "snippetsLimitToCurrentDeck",
                        label: "Only notes in the current deck",
                        type: "checkbox",
                        value: c.snippetsLimitToCurrentDeck,
                    },
                    {
                        key: "snippetsResultsWarnLimit",
                        label: "Ask before showing more notes than (0: never ask)",
                        type: "number",
                        value: c.snippetsResultsWarnLimit,
                        min: 0,
                    },
                ],
                { title: "Pop-up Dictionary" },
            );
            if (values) {
                api.setConfig({
                    ...c,
                    ...values,
                    snippetsExcludedFields: String(values.snippetsExcludedFields).split(",").map((s) => s.trim()).filter(Boolean),
                });
                maybeAddNotetype();
            }
        });
    },
} satisfies Plugin;
