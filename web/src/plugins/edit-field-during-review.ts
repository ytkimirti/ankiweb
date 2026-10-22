// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Edit Field During Review (Cloze), AnkiWeb 385888438: fields shown with
 * {{edit:Field}} in a card template can be edited on the card while
 * reviewing. Ctrl+click (Cmd+click on macOS) starts editing, or a plain click
 * if "Ctrl+click to edit" is off; the field then shows its stored content,
 * clozes included, and is saved, if changed, when it loses focus (Escape
 * also leaves it).
 * Ctrl+Shift+C and Ctrl+Shift+Alt+C add clozes while editing. Only the
 * current card's note can be changed, and only its {{edit:}} fields.
 */

import type { Plugin, PluginApi } from "$web/plugins/loader";

interface Config {
    ctrlClick: boolean;
    outline: boolean;
    tag: string;
}

const DEFAULTS: Config = { ctrlClick: true, outline: true, tag: "div" };

const PREFIX = "efdrc:";

function escapeAttr(text: string): string {
    return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Runs in the card frame. Self-contained, since it is sent as source text.
 * Card HTML runs its scripts on every card, so it installs its listeners once.
 */
function cardScript(ctrlClick: boolean): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    if (w.__efdrc) {
        w.__efdrc.ctrlClick = ctrlClick;
        return;
    }
    const state = (w.__efdrc = {
        ctrlClick,
        editing: null as HTMLElement | null,
        /** The card's HTML for the field, put back if nothing was typed. */
        rendered: "",
        changed: false,
    });
    const send = (cmd: string, data: unknown, callback?: (value: unknown) => void) =>
        w.pycmd(`efdrc:${cmd}:${JSON.stringify(data)}`, callback);
    const fieldOf = (el: HTMLElement) => ({ nid: el.dataset.efdrcNid, field: el.dataset.efdrcField });
    const editableAt = (target: EventTarget | null) =>
        (target instanceof Element ? target.closest("[data-efdrc-field]") : null) as HTMLElement | null;

    function start(el: HTMLElement): void {
        if (state.editing) {
            return;
        }
        state.editing = el;
        state.rendered = el.innerHTML;
        state.changed = false;
        // editable only once it shows the stored field (clozes and all), so
        // the card's rendering of it is never saved in its place
        send("load", fieldOf(el), (html) => {
            if (state.editing !== el) {
                return;
            }
            if (typeof html !== "string") {
                state.editing = null;
                return;
            }
            el.innerHTML = html;
            el.contentEditable = "true";
            el.focus();
        });
    }

    document.addEventListener("click", (event) => {
        const el = editableAt(event.target);
        if (!el || el.isContentEditable) {
            return;
        }
        if (!state.ctrlClick || event.ctrlKey || event.metaKey) {
            event.preventDefault();
            start(el);
        }
    }, true);
    document.addEventListener("input", (event) => {
        if (state.editing && state.editing.contains(event.target as Node)) {
            state.changed = true;
        }
    });
    document.addEventListener("focusout", (event) => {
        const el = editableAt(event.target);
        if (!el || state.editing !== el || !el.isContentEditable) {
            return;
        }
        state.editing = null;
        el.contentEditable = "false";
        if (state.changed) {
            send("save", { ...fieldOf(el), html: el.innerHTML });
        } else {
            el.innerHTML = state.rendered;
        }
    });
    document.addEventListener("keydown", (event) => {
        const el = state.editing;
        if (!el || !el.contains(event.target as Node)) {
            return;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            el.blur();
        } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyC") {
            event.preventDefault();
            const numbers = [...el.innerHTML.matchAll(/\{\{c(\d+)::/g)].map((m) => Number(m[1]));
            const highest = numbers.length ? Math.max(...numbers) : 0;
            const n = event.altKey ? Math.max(1, highest) : highest + 1;
            const selected = window.getSelection()?.toString() ?? "";
            document.execCommand("insertText", false, `{{c${n}::${selected}}}`);
        }
    }, true);
}

const CSS = `
[data-efdrc-field].efdrc-outline:focus, [data-efdrc-field][contenteditable="true"] { outline: 1px solid #308cc6; outline-offset: 2px; }
`;

async function fieldIndex(
    api: PluginApi,
    nid: bigint,
    field: string,
): Promise<{ index: number; note: Awaited<ReturnType<PluginApi["backend"]["getNote"]>> } | null> {
    const note = await api.backend.getNote({ nid });
    const notetype = await api.backend.getNotetype({ ntid: note.notetypeId });
    const index = notetype.fields.findIndex((f) => f.name === field);
    return index < 0 ? null : { index, note };
}

export default {
    name: "Edit Field During Review",
    setup(api) {
        const config = () => ({ ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) });
        /** The {{edit:}} fields of each card rendered, so a card script cannot reach others. */
        const editable = new Map<bigint, Set<string>>();

        api.hooks.fieldFilter.append((text, fieldName, filterName, card) => {
            if (filterName !== "edit") {
                return text;
            }
            if (!editable.has(card.cardId)) {
                // only the latest cards matter
                if (editable.size > 20) {
                    editable.delete(editable.keys().next().value!);
                }
                editable.set(card.cardId, new Set());
            }
            editable.get(card.cardId)!.add(fieldName);
            const { tag, outline } = config();
            const element = /^[a-z]+$/.test(tag) ? tag : "div";
            return `<${element} data-efdrc-field="${escapeAttr(fieldName)}" data-efdrc-nid="${card.noteId}"${
                outline ? ` class="efdrc-outline"` : ""
            }>${text}</${element}>`;
        });

        api.hooks.cardWillShow.append((html, _card, kind) => {
            if (!kind.startsWith("review") || !html.includes("data-efdrc-field")) {
                return html;
            }
            return `${html}<style>${CSS}</style><script>(${cardScript.toString()})(${config().ctrlClick});</script>`;
        });

        api.hooks.webviewDidReceiveBridgeCommand.append((handled, cmd, context) => {
            if (handled[0] || context !== "reviewer" || !cmd.startsWith(PREFIX)) {
                return handled;
            }
            const rest = cmd.slice(PREFIX.length);
            const colon = rest.indexOf(":");
            const action = rest.slice(0, colon);
            let data: { nid?: string; field?: string; html?: string };
            try {
                data = JSON.parse(rest.slice(colon + 1));
            } catch {
                return handled;
            }
            const card = api.reviewer.card;
            if (!card || String(card.noteId) !== data.nid || !data.field || !editable.get(card.id)?.has(data.field)) {
                return [true, undefined];
            }
            const field = data.field;
            if (action === "load") {
                // null on failure too, so the card stops waiting to edit
                return [
                    true,
                    fieldIndex(api, card.noteId, field).then(
                        (found) => found?.note.fields[found.index] ?? null,
                        () => null,
                    ),
                ];
            }
            if (action === "save" && typeof data.html === "string") {
                const html = data.html;
                return [
                    true,
                    fieldIndex(api, card.noteId, field).then(async (found) => {
                        if (found && found.note.fields[found.index] !== html) {
                            found.note.fields[found.index] = html;
                            await api.backend.updateNotes({ notes: [found.note], skipUndoEntry: false });
                        }
                    }).catch((err) => api.dialogs.showError(err)),
                ];
            }
            return [true, undefined];
        });

        api.setConfigAction(async () => {
            const current = config();
            const values = await api.dialogs.openForm(
                [
                    {
                        key: "ctrlClick",
                        label: "Ctrl+click to edit (otherwise a click)",
                        type: "checkbox",
                        value: current.ctrlClick,
                    },
                    {
                        key: "outline",
                        label: "Outline the field while editing",
                        type: "checkbox",
                        value: current.outline,
                    },
                    {
                        key: "tag",
                        label: "HTML element around fields",
                        type: "select",
                        value: current.tag,
                        options: ["div", "span"].map((v) => ({ value: v, label: v })),
                    },
                ],
                {
                    title: "Edit Field During Review",
                    text: "Put {{edit:Field}} in a card template to make that field editable.",
                },
            );
            if (values) {
                api.setConfig({ ...current, ...values });
            }
        });
    },
} satisfies Plugin;
