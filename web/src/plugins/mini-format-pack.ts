// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Mini Format Pack, AnkiWeb 295889520: editor buttons and shortcuts for
 * strikethrough, <abbr>, <pre>, <code>, horizontal rules, lists, indenting and
 * alignment, with the original's hotkeys. Anki's editor has gained its own
 * buttons for lists, indenting and alignment since, so only the other buttons
 * are shown by default; all the hotkeys work. Each action's hotkey and button
 * can be changed in Config, as the original's "actions" list allows.
 */

import type { EditorContext } from "$web/plugins/hooks";
import type { Plugin, PluginApi } from "$web/plugins/loader";

interface Action {
    name: string;
    tooltip: string;
    hotkey: string;
    label: string;
    button: boolean;
    run: (editor: EditorContext, api: PluginApi) => void | Promise<void>;
}

const exec = (command: string, value?: string) => (editor: EditorContext) => editor.execCommand(command, value);

const ACTIONS: Action[] = [
    {
        name: "strikeThrough",
        tooltip: "Strikethrough",
        hotkey: "Alt+Shift+5",
        label: "<s>S</s>",
        button: true,
        run: exec("strikeThrough"),
    },
    {
        name: "abbr",
        tooltip: "Abbreviation",
        hotkey: "Ctrl+Shift+Alt+A",
        label: "&lt;abbr&gt;",
        button: true,
        run: async (editor, api) => {
            const restore = editor.keepSelection();
            const title = await api.dialogs.getText("Abbreviation title:", { title: "Abbreviation" });
            await restore();
            if (title !== null) {
                const escaped = title.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
                editor.wrap(`<abbr title="${escaped}">`, "</abbr>");
            }
        },
    },
    {
        name: "formatBlockPre",
        tooltip: "Preformatted text",
        hotkey: "Ctrl+.",
        label: "pre",
        button: true,
        run: exec("formatBlock", "pre"),
    },
    {
        name: "formatInlineCode",
        tooltip: "Code",
        hotkey: "Ctrl+,",
        label: "&lt;/&gt;",
        button: true,
        run: (editor) => editor.wrap("<code>", "</code>"),
    },
    {
        name: "insertHorizontalRule",
        tooltip: "Horizontal rule",
        hotkey: "Ctrl+Shift+Alt+_",
        label: "hr",
        button: true,
        run: exec("insertHorizontalRule"),
    },
    {
        name: "insertUnorderedList",
        tooltip: "Unordered list",
        hotkey: "Ctrl+[",
        label: "•",
        button: false,
        run: exec("insertUnorderedList"),
    },
    {
        name: "insertOrderedList",
        tooltip: "Ordered list",
        hotkey: "Ctrl+]",
        label: "1.",
        button: false,
        run: exec("insertOrderedList"),
    },
    // Ctrl+Shift+] and [ on a US layout, as the browser reports them
    { name: "indent", tooltip: "Indent", hotkey: "Ctrl+Shift+}", label: "⇥", button: false, run: exec("indent") },
    { name: "outdent", tooltip: "Outdent", hotkey: "Ctrl+Shift+{", label: "⇤", button: false, run: exec("outdent") },
    {
        name: "justifyCenter",
        tooltip: "Center",
        hotkey: "Ctrl+Shift+Alt+S",
        label: "C",
        button: false,
        run: exec("justifyCenter"),
    },
    {
        name: "justifyLeft",
        tooltip: "Align left",
        hotkey: "Ctrl+Shift+Alt+L",
        label: "L",
        button: false,
        run: exec("justifyLeft"),
    },
    {
        name: "justifyRight",
        tooltip: "Align right",
        hotkey: "Ctrl+Shift+Alt+R",
        label: "R",
        button: false,
        run: exec("justifyRight"),
    },
    {
        name: "justifyFull",
        tooltip: "Justify",
        hotkey: "Ctrl+Shift+Alt+B",
        label: "J",
        button: false,
        run: exec("justifyFull"),
    },
];

type Config = Record<string, { hotkey?: string; button?: boolean }>;

export default {
    name: "Mini Format Pack",
    setup(api) {
        const settings = (action: Action) => {
            const saved = api.getConfig<Config>({})[action.name] ?? {};
            return { hotkey: saved.hotkey ?? action.hotkey, button: saved.button ?? action.button };
        };
        const run = (action: Action, editor: EditorContext) =>
            void Promise.resolve(action.run(editor, api)).catch((err) => api.dialogs.showError(err));
        api.hooks.editorDidInitButtons.append((buttons) => {
            for (const action of ACTIONS) {
                const { hotkey, button } = settings(action);
                if (button) {
                    buttons.push({
                        id: `mini-format-pack:${action.name}`,
                        label: action.label,
                        tip: action.tooltip,
                        keys: hotkey || undefined,
                        onClick: (editor) => run(action, editor),
                    });
                }
            }
        });
        api.hooks.editorDidInitShortcuts.append((shortcuts) => {
            for (const action of ACTIONS) {
                const { hotkey, button } = settings(action);
                // shown buttons bring their own shortcut
                if (hotkey && !button) {
                    shortcuts.push([hotkey, (editor) => run(action, editor)]);
                }
            }
        });
        api.setConfigAction(async () => {
            const fields = ACTIONS.flatMap((action) => {
                const { hotkey, button } = settings(action);
                return [
                    {
                        key: `${action.name}.hotkey`,
                        label: `${action.tooltip}: hotkey`,
                        type: "text" as const,
                        value: hotkey,
                    },
                    {
                        key: `${action.name}.button`,
                        label: `${action.tooltip}: show a button`,
                        type: "checkbox" as const,
                        value: button,
                    },
                ];
            });
            const values = await api.dialogs.openForm(fields, {
                title: "Mini Format Pack",
                text: "Clear a hotkey to turn it off. Changes apply to editors opened afterwards.",
            });
            if (values) {
                api.setConfig(
                    Object.fromEntries(
                        ACTIONS.map((
                            a,
                        ) => [a.name, {
                            hotkey: String(values[`${a.name}.hotkey`]).trim(),
                            button: !!values[`${a.name}.button`],
                        }]),
                    ),
                );
            }
        });
    },
} satisfies Plugin;
