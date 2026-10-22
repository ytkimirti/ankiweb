// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Batch Editing, AnkiWeb 291119185: Edit > Batch Edit... (Ctrl+Alt+B) in the
 * browser adds text before or after a field, or replaces it, in every
 * selected note, as one undoable change. Plain text is added on a new line
 * (a <br>) unless the field already breaks there; "Insert as HTML" adds the
 * text as it is.
 */

import type { Note } from "@generated/anki/notes_pb";

import type { BrowserPluginContext } from "$web/plugins/hooks";
import type { Plugin, PluginApi } from "$web/plugins/loader";

const BREAKS = ["<div>", "</div>", "<br>", "<br/>"];

/** As the original's collection.py. */
export function combine(existing: string, text: string, mode: "before" | "after" | "replace", html: boolean): string {
    if (mode === "replace") {
        return html ? text : text.replace(/\n/g, "<br/>");
    }
    const added = html ? text : text.replace(/\n/g, "<br/>");
    const spacerNeeded = html
        ? !(mode === "after" ? existing.endsWith("\n") : existing.startsWith("\n"))
        : !BREAKS.some((b) => (mode === "after" ? existing.endsWith(b) : existing.startsWith(b)));
    const spacer = spacerNeeded ? (html ? "\n" : "<br/>") : "";
    return mode === "after" ? existing + spacer + added : added + spacer + existing;
}

async function batchEdit(api: PluginApi, browser: BrowserPluginContext): Promise<void> {
    const nids = await browser.selectedNoteIds();
    if (!nids.length) {
        api.dialogs.tooltip("No cards selected.");
        return;
    }
    const first = await api.backend.getNote({ nid: nids[0] });
    const notetype = await api.backend.getNotetype({ ntid: first.notetypeId });
    const fieldNames = notetype.fields.map((f) => f.name);
    const result = await api.dialogs.openDialog({
        title: "Batch Edit Selected Notes",
        text: "",
        form: [
            { key: "text", label: "Content to add to or replace with:", type: "textarea", value: "", rows: 6 },
            {
                key: "field",
                label: "In this field:",
                type: "select",
                value: fieldNames[0] ?? "",
                options: fieldNames.map((name) => ({ value: name, label: name })),
            },
            { key: "html", label: "Insert as HTML", type: "checkbox", value: false },
        ],
        buttons: [
            { label: "Cancel", value: "cancel" },
            { label: "Replace", value: "replace" },
            { label: "Add before", value: "before" },
            { label: "Add after", value: "after", primary: true },
        ],
    });
    const mode = result.button;
    if (mode !== "before" && mode !== "after" && mode !== "replace") {
        return;
    }
    const text = String(result.form?.text ?? "");
    const field = String(result.form?.field ?? "");
    const html = !!result.form?.html;
    if (
        mode === "replace"
        && !(await api.dialogs.askUser(
            `This will replace the contents of the '${field}' field in ${nids.length} selected note(s). Proceed?`,
            { defaultNo: true },
        ))
    ) {
        return;
    }
    const notes: Note[] = [];
    const fieldIndex = new Map<bigint, number>();
    for (const nid of nids) {
        const note = await api.backend.getNote({ nid });
        if (!fieldIndex.has(note.notetypeId)) {
            const nt = note.notetypeId === notetype.id
                ? notetype
                : await api.backend.getNotetype({ ntid: note.notetypeId });
            fieldIndex.set(note.notetypeId, nt.fields.findIndex((f) => f.name === field));
        }
        const index = fieldIndex.get(note.notetypeId)!;
        if (index >= 0) {
            note.fields[index] = combine(note.fields[index], text, mode, html);
            notes.push(note);
        }
    }
    await api.backend.updateNotes({ notes, skipUndoEntry: false });
    api.dialogs.tooltip(`Updated ${notes.length} note${notes.length === 1 ? "" : "s"}.`);
}

export default {
    name: "Batch Editing",
    setup(api) {
        api.hooks.browserMenusWillShow.append((sections, browser) => {
            sections[0]?.items.push(null, {
                label: "Batch Edit...",
                shortcut: "Ctrl+Alt+B",
                action: () => void batchEdit(api, browser).catch((err) => api.dialogs.showError(err)),
            });
        });
        api.hooks.browserDidInitShortcuts.append((shortcuts, browser) => {
            shortcuts.push([
                "Ctrl+Alt+B",
                () => void batchEdit(api, browser).catch((err) => api.dialogs.showError(err)),
            ]);
        });
    },
} satisfies Plugin;
