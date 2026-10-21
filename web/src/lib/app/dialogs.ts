// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Promise-based modal dialogs and transient notices, rendered by
 * DialogHost.svelte (desktop's showInfo/askUser/getText/tooltip).
 */

import { writable } from "svelte/store";

export type DialogKind = "info" | "warning" | "critical";

export interface Button {
    label: string;
    value: string;
    primary?: boolean;
    danger?: boolean;
}

export interface DialogRequest {
    id: number;
    title?: string;
    text: string;
    html?: boolean;
    kind?: DialogKind;
    buttons: Button[];
    /** Shows a text field; its value is returned with the button. */
    input?: { value: string; placeholder?: string; multiline?: boolean };
    /** Shows a list of choices; the chosen index is returned with the button. */
    choices?: { items: string[]; selected: number; filter?: boolean };
    /** Shows checkboxes; their final state is returned with the button. */
    checks?: { label: string; checked: boolean }[];
    resolve: (result: DialogResult) => void;
}

export interface DialogResult {
    button: string | null;
    input?: string;
    choice?: number;
    checks?: boolean[];
}

export const dialogs = writable<DialogRequest[]>([]);
export const notices = writable<{ id: number; text: string }[]>([]);

let nextId = 1;

export function openDialog(request: Omit<DialogRequest, "id" | "resolve">): Promise<DialogResult> {
    return new Promise((resolve) => {
        const id = nextId++;
        const entry: DialogRequest = {
            ...request,
            id,
            resolve: (result) => {
                dialogs.update((list) => list.filter((d) => d.id !== id));
                resolve(result);
            },
        };
        dialogs.update((list) => [...list, entry]);
    });
}

const ok = () => ({ label: "OK", value: "ok", primary: true });
const cancel = () => ({ label: "Cancel", value: "cancel" });

export async function showInfo(
    text: string,
    options: { title?: string; kind?: DialogKind; html?: boolean } = {},
): Promise<void> {
    await openDialog({ ...options, text, buttons: [ok()] });
}

export function showWarning(text: string, title?: string): Promise<void> {
    return showInfo(text, { title, kind: "warning" });
}

export async function askUser(
    text: string,
    options: { title?: string; defaultNo?: boolean; yes?: string; no?: string; danger?: boolean } = {},
): Promise<boolean> {
    const result = await openDialog({
        title: options.title,
        text,
        buttons: [
            { label: options.no ?? "No", value: "no", primary: !!options.defaultNo },
            { label: options.yes ?? "Yes", value: "yes", primary: !options.defaultNo, danger: options.danger },
        ],
    });
    return result.button === "yes";
}

export async function getText(
    prompt: string,
    options: { title?: string; value?: string; placeholder?: string; multiline?: boolean } = {},
): Promise<string | null> {
    const result = await openDialog({
        title: options.title,
        text: prompt,
        input: { value: options.value ?? "", placeholder: options.placeholder, multiline: options.multiline },
        buttons: [cancel(), ok()],
    });
    return result.button === "ok" ? result.input ?? "" : null;
}

export async function chooseFrom(
    prompt: string,
    items: string[],
    options: { title?: string; selected?: number; filter?: boolean; okLabel?: string } = {},
): Promise<number | null> {
    const result = await openDialog({
        title: options.title,
        text: prompt,
        choices: { items, selected: options.selected ?? 0, filter: options.filter },
        buttons: [cancel(), { label: options.okLabel ?? "OK", value: "ok", primary: true }],
    });
    return result.button === "ok" && result.choice !== undefined ? result.choice : null;
}

/** Shows a short message that fades away (desktop's tooltip()). */
export function tooltip(text: string, ms = 3000): void {
    const id = nextId++;
    notices.update((list) => [...list, { id, text }]);
    setTimeout(() => notices.update((list) => list.filter((n) => n.id !== id)), ms);
}

export function errorMessage(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

/** Shows an error unless it is an interruption the user asked for. */
export async function showError(err: unknown): Promise<void> {
    const message = errorMessage(err);
    if (message === "500: Interrupted" || (err as { interrupted?: boolean })?.interrupted) {
        return;
    }
    console.error(err);
    await showInfo(message, { kind: "critical" });
}
