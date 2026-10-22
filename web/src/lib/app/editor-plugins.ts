// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Plugin buttons and shortcuts in editors (desktop's editor_did_init_buttons
 * and editor_did_init_shortcuts). Run for every editor page when it reports
 * it is ready: the add, edit current and browser editors.
 */

import { type EditorButton, type EditorContext, type EditorShortcut, hooks } from "../plugins/hooks";
import { matches } from "./keys";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EditorFrame = Window & typeof globalThis & Record<string, any>;

const installed = new WeakMap<Window, () => void>();

function runHandler(handler: (editor: EditorContext) => void, editor: EditorContext): void {
    try {
        handler(editor);
    } catch (err) {
        console.error("plugin editor action failed", err);
    }
}

function escapeAttr(text: string): string {
    return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The focused element, looking inside the shadow roots fields use. */
function deepActiveElement(doc: Document): Element | null {
    let active = doc.activeElement;
    while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
    }
    return active;
}

function selectionIn(frame: EditorFrame): Selection | null {
    const active = deepActiveElement(frame.document);
    const root = active?.getRootNode() as (ShadowRoot & { getSelection?: () => Selection | null }) | undefined;
    return root?.getSelection?.() ?? frame.getSelection();
}

export function editorContext(frame: Window): EditorContext {
    const f = frame as EditorFrame;
    const mode = new URL(f.location.href).searchParams.get("mode");
    return {
        frame,
        mode: mode === "current" || mode === "browser" ? mode : "add",
        wrap: (before, after) => f.wrap?.(before, after),
        insertHtml: (html) => void f.document.execCommand("insertHTML", false, html),
        selectedText: () => selectionIn(f)?.toString() ?? "",
        execCommand: (command, value) => void f.document.execCommand(command, false, value),
        keepSelection: () => {
            const active = deepActiveElement(f.document) as HTMLElement | null;
            const selection = selectionIn(f);
            const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
            return async () => {
                // after the dialog host returns focus to the editor's frame
                await new Promise((resolve) => setTimeout(resolve, 0));
                f.focus();
                // a field puts back the selection it had when it lost focus
                active?.focus();
                const now = selectionIn(f);
                // the field may rebuild its content on blur, which collapses the saved range
                if (now && !now.rangeCount && range && !range.collapsed) {
                    now.addRange(range);
                }
            };
        },
    };
}

function buttonHtml(button: EditorButton): string {
    const tip = button.tip ? `${button.tip}${button.keys ? ` (${button.keys})` : ""}` : button.keys ?? "";
    return `<button tabindex="-1" type="button" class="anki-addon-button linkb" data-plugin-button="${
        escapeAttr(button.id)
    }" title="${escapeAttr(tip)}">${button.label}</button>`;
}

/** Adds the plugins' buttons and shortcuts to an editor page that has just loaded. */
export function setupEditorPlugins(frame: Window): void {
    installed.get(frame)?.();
    const f = frame as EditorFrame;
    const editor = editorContext(frame);
    const buttons: EditorButton[] = [];
    const shortcuts: EditorShortcut[] = [];
    hooks.editorDidInitButtons.run(buttons, editor);
    hooks.editorDidInitShortcuts.run(shortcuts, editor);
    for (const button of buttons) {
        if (button.keys) {
            shortcuts.push([button.keys, button.onClick]);
        }
    }
    if (!buttons.length && !shortcuts.length) {
        return;
    }
    try {
        if (buttons.length) {
            const noteEditor = f.require?.("anki/NoteEditor")?.instances?.[0];
            noteEditor?.toolbar?.toolbar?.append({
                component: f.editorToolbar.AddonButtons,
                id: "plugins",
                props: { buttons: buttons.map(buttonHtml) },
            });
        }
    } catch (err) {
        console.error("adding plugin buttons to the editor failed", err);
    }
    const onClick = (event: MouseEvent) => {
        const target = (event.target as Element | null)?.closest?.("[data-plugin-button]");
        const button = target && buttons.find((b) => b.id === target.getAttribute("data-plugin-button"));
        if (button) {
            event.preventDefault();
            runHandler(button.onClick, editor);
        }
    };
    const onKey = (event: KeyboardEvent) => {
        const shortcut = shortcuts.find(([spec]) => matches(spec, event));
        if (shortcut) {
            event.preventDefault();
            event.stopPropagation();
            runHandler(shortcut[1], editor);
        }
    };
    f.document.addEventListener("click", onClick);
    f.document.addEventListener("keydown", onKey, true);
    installed.set(frame, () => {
        f.document.removeEventListener("click", onClick);
        f.document.removeEventListener("keydown", onKey, true);
    });
}
