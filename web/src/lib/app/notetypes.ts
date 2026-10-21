// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** Note type editing shared by the note types manager, fields and card layout windows. */

import type { Note } from "@generated/anki/notes_pb";
import {
    addNotetypeLegacy,
    getNote,
    getNotetypeLegacy,
    newNote,
    updateNotetypeLegacy,
} from "@generated/backend";
import * as tr from "@generated/ftl";

import type { WindowCommands } from "./frontend";
import { decodeJson64, encodeJson64 } from "./json64";
import { confirmSchemaModification } from "./profiles";
import { runOp } from "./run";
import { openWindow } from "./windows";

export const MODEL_CLOZE = 1;

/* eslint-disable @typescript-eslint/no-explicit-any */
export type FieldDict = Record<string, any> & { name: string; ord: number | null };
export type TemplateDict = Record<string, any> & { name: string; ord: number | null; qfmt: string; afmt: string };
export type NotetypeDict = Record<string, any> & {
    id: number;
    name: string;
    type: number;
    flds: FieldDict[];
    tmpls: TemplateDict[];
    css: string;
    sortf: number;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function getNotetypeDict(ntid: bigint | number): Promise<NotetypeDict> {
    const out = await getNotetypeLegacy({ ntid: BigInt(ntid) });
    return decodeJson64<NotetypeDict>(out.json);
}

export function saveNotetypeDict(nt: NotetypeDict, skipChecks = false): Promise<unknown> {
    return runOp(() => updateNotetypeLegacy({ json: encodeJson64(nt), skipChecks }));
}

export async function addNotetypeDict(nt: NotetypeDict): Promise<bigint | undefined> {
    return (await runOp(() => addNotetypeLegacy({ json: encodeJson64(nt) })))?.id;
}

/** Desktop's ChangeTracker: whether a dialog made changes, and if they need a full sync. */
export class ChangeTracker {
    private level: 0 | 1 | 2 = 0;

    markBasic(): void {
        if (this.level < 1) {
            this.level = 1;
        }
    }

    /** Asks before a change that requires a full sync; false if the user declined. */
    async markSchema(): Promise<boolean> {
        if (this.level === 2) {
            return true;
        }
        if (!(await confirmSchemaModification())) {
            return false;
        }
        this.level = 2;
        return true;
    }

    changed(): boolean {
        return this.level > 0;
    }

    setUnchanged(): void {
        this.level = 0;
    }
}

/** Checks a new field name as desktop's FieldDialog._uniqueName does; returns a warning or null. */
export function fieldNameProblem(name: string, fields: FieldDict[], old = ""): string | null | "unchanged" {
    if (!name) {
        return "unchanged";
    }
    if ("#^/".includes(name[0])) {
        return tr.fieldsNameFirstLetterNotValid();
    }
    if ([":", "{", "\"", "}"].some((c) => name.includes(c))) {
        return tr.fieldsNameInvalidLetter();
    }
    if (name.toLowerCase() === old.toLowerCase()) {
        return "unchanged";
    }
    if (fields.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
        return tr.fieldsThatFieldNameIsAlreadyUsed();
    }
    return null;
}

/** The fields a template shows, for the card type list (desktop's _fieldsOnTemplate). */
export function fieldsOnTemplate(fmt: string): string {
    const withoutComments = fmt.replace(/<!--[\s\S]*?-->/g, "");
    const matches = withoutComments.match(/{{[^#/}]+?}}/g) ?? [];
    let allowed = 30;
    const names: string[] = [];
    for (const match of matches) {
        const name = match.replace(/[{}]/g, "").split(":").at(-1)!;
        if (name === "FrontSide") {
            continue;
        }
        names.push(name);
        allowed -= name.length;
        if (allowed <= 0) {
            break;
        }
    }
    return names.join("+") + (allowed <= 0 ? "+..." : "");
}

export async function openFieldsDialog(ntid: bigint | number, openAt = 0): Promise<void> {
    const [{ default: Fields }, nt] = await Promise.all([
        import("../ui/notetypes/Fields.svelte"),
        getNotetypeDict(ntid),
    ]);
    const api: { canClose?: () => Promise<boolean> } = {};
    openWindow({
        key: `fields:${ntid}`,
        title: tr.fieldsFieldsFor({ val: nt.name }),
        component: Fields,
        props: { notetype: nt, openAt, api },
        size: "md",
        canClose: async () => (await api.canClose?.()) ?? true,
    });
}

/** Opens the card layout for a note, which need not be saved yet. */
export async function openCardLayout(note: Note, ord = 0, fillEmpty = false): Promise<void> {
    const [{ default: CardLayout }, nt] = await Promise.all([
        import("../ui/notetypes/CardLayout.svelte"),
        getNotetypeDict(note.notetypeId),
    ]);
    const api: { canClose?: () => Promise<boolean> } = {};
    openWindow({
        key: `cardLayout:${note.notetypeId}`,
        title: tr.cardTemplatesCardTypesFor({ val: nt.name }),
        component: CardLayout,
        props: { note, notetype: nt, ord, fillEmpty, api },
        size: "full",
        canClose: async () => (await api.canClose?.()) ?? true,
    });
}

/** A blank note of a notetype, for previewing its templates (desktop's _tmpNote). */
export function blankNote(ntid: bigint): Promise<Note> {
    return newNote({ ntid });
}

interface EditorFrame {
    getNoteInfo?: () => { id: string | null; mid: string; fields: string[] };
}

/** The Fields... and Cards... buttons of an editor in a window (desktop's Editor.onFields/onCardLayout). */
export function editorNotetypeCommands(
    frame: () => (Window & EditorFrame) | null,
    cardOrd: () => number | Promise<number> = () => 0,
): Pick<WindowCommands, "openFieldsDialog" | "openCardsDialog"> {
    const info = () => frame()?.getNoteInfo?.();
    return {
        openFieldsDialog: () => {
            const note = info();
            if (note) {
                void openFieldsDialog(BigInt(note.mid));
            }
        },
        openCardsDialog: () => {
            const noteInfo = info();
            if (!noteInfo) {
                return;
            }
            void (async () => {
                let note: Note;
                if (noteInfo.id && noteInfo.id !== "0") {
                    note = await getNote({ nid: BigInt(noteInfo.id) });
                } else {
                    note = await newNote({ ntid: BigInt(noteInfo.mid) });
                    note.fields = [...noteInfo.fields];
                }
                await openCardLayout(note, await cardOrd(), false);
            })();
        },
    };
}


/** Desktop's ChangeTracker(mw).mark_schema() for a one-off change. */
export function confirmSchema(): Promise<boolean> {
    return confirmSchemaModification();
}
