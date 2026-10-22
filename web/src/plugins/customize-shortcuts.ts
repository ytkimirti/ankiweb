// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Customize Keyboard Shortcuts, AnkiWeb 24411424: changes the keys of the
 * main window, the reviewer and the editor's formatting commands, using the
 * original's action names. "<nop>" turns a shortcut off. Keys are written as
 * elsewhere in the app ("Ctrl+Shift+K", "F5", "Enter"); key sequences such as
 * "Ctrl+T, T" are not supported. Deleting a note keeps its own key, since the
 * reviewer asks before deleting only on that key.
 */

import type { MainState } from "$web/plugins/hooks";
import type { Plugin, PluginApi } from "$web/plugins/loader";

const NOP = "<nop>";

interface Action {
    /** The original's config key. */
    name: string;
    /** The key the app uses, as the shortcut lists write it. */
    key: string;
    /** Where it applies: the main window everywhere, a screen, or the editor. */
    where: "global" | MainState | "editor";
    /** For editor actions and new shortcuts: what the key does. */
    run?: (api: PluginApi, frame?: Window) => void;
}

const exec = (command: string) => (_api: PluginApi, frame?: Window) => void frame?.document.execCommand(command);

const ACTIONS: Action[] = [
    { name: "main deckbrowser", key: "d", where: "global" },
    { name: "main study", key: "s", where: "global" },
    { name: "main add", key: "a", where: "global" },
    { name: "main browse", key: "b", where: "global" },
    { name: "main stats", key: "t", where: "global" },
    { name: "main sync", key: "y", where: "global" },
    { name: "m_toolbox preferences", key: "Ctrl+P", where: "global" },
    { name: "m_toolbox undo", key: "Ctrl+Z", where: "global" },
    { name: "m_toolbox documentation", key: "F1", where: "global" },
    { name: "m_toolbox switch profile", key: "Ctrl+Shift+P", where: "global" },
    { name: "m_toolbox export", key: "Ctrl+E", where: "global" },
    { name: "m_toolbox import", key: "Ctrl+Shift+I", where: "global" },
    { name: "m_toolbox study", key: "/", where: "global" },
    { name: "m_toolbox create filtered deck", key: "f", where: "global" },
    // desktop opens the add-ons with this key; the app has no such shortcut of its own
    { name: "m_toolbox addons", key: "Ctrl+Shift+A", where: "global", run: (api) => void api.actions.onPlugins() },
    { name: "reviewer edit current", key: "e", where: "review" },
    { name: "reviewer flip card 1", key: " ", where: "review" },
    { name: "reviewer flip card 2", key: "Enter", where: "review" },
    { name: "reviewer replay audio 1", key: "r", where: "review" },
    { name: "reviewer replay audio 2", key: "F5", where: "review" },
    ...[1, 2, 3, 4, 5, 6, 7].map((n): Action => ({
        name: `reviewer set flag ${n}`,
        key: `Ctrl+${n}`,
        where: "review",
    })),
    { name: "reviewer mark card", key: "*", where: "review" },
    { name: "reviewer bury note", key: "=", where: "review" },
    { name: "reviewer bury card", key: "-", where: "review" },
    { name: "reviewer suspend note", key: "!", where: "review" },
    { name: "reviewer suspend card", key: "@", where: "review" },
    { name: "reviewer play recorded voice", key: "v", where: "review" },
    { name: "reviewer record voice", key: "Shift+v", where: "review" },
    { name: "reviewer options menu", key: "o", where: "review" },
    { name: "reviewer more options", key: "m", where: "review" },
    { name: "reviewer card info", key: "i", where: "review" },
    { name: "reviewer previous card info", key: "Ctrl+Alt+i", where: "review" },
    { name: "reviewer undo", key: "u", where: "review" },
    { name: "reviewer forget card", key: "Ctrl+Alt+N", where: "review" },
    { name: "reviewer create copy", key: "Ctrl+Alt+E", where: "review" },
    { name: "reviewer set due date", key: "Ctrl+Shift+D", where: "review" },
    { name: "reviewer toggle auto advance", key: "Shift+A", where: "review" },
    ...[1, 2, 3, 4].map((n): Action => ({ name: `reviewer choice ${n}`, key: String(n), where: "review" })),
    { name: "reviewer pause audio", key: "5", where: "review" },
    { name: "reviewer seek backward", key: "6", where: "review" },
    { name: "reviewer seek forward", key: "7", where: "review" },
    { name: "editor bold", key: "Ctrl+B", where: "editor", run: exec("bold") },
    { name: "editor italic", key: "Ctrl+I", where: "editor", run: exec("italic") },
    { name: "editor underline", key: "Ctrl+U", where: "editor", run: exec("underline") },
    { name: "editor superscript", key: "Ctrl+=", where: "editor", run: exec("superscript") },
    { name: "editor subscript", key: "Ctrl++", where: "editor", run: exec("subscript") },
    { name: "editor remove format", key: "Ctrl+R", where: "editor", run: exec("removeFormat") },
];

type Config = Record<string, string>;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The key set for an action, NOP, or null if unchanged. */
function custom(config: Config, action: Action): string | null {
    const value = config[action.name]?.trim();
    return value && !same(value, action.key) ? value : null;
}

function remap(config: Config, where: Action["where"], shortcuts: [string, () => void][], api: PluginApi): void {
    // matched against the app's keys before any change, so that swapped keys
    // and an action moved to another's key still find the right shortcut
    const original = [...shortcuts];
    const changed = new Map<number, string>();
    const added: [string, () => void][] = [];
    for (const action of ACTIONS) {
        if (action.where !== where) {
            continue;
        }
        const key = custom(config, action);
        const index = original.findIndex(([spec]) => same(spec, action.key));
        if (index >= 0) {
            if (key) {
                changed.set(index, key);
            }
        } else if (action.run && key !== NOP) {
            // a shortcut the app lacks
            added.push([key ?? action.key, () => action.run!(api)]);
        }
    }
    const kept = original.flatMap(([spec, run], i): [string, () => void][] => {
        const key = changed.get(i);
        return key === NOP ? [] : [[key ?? spec, run]];
    });
    shortcuts.splice(0, shortcuts.length, ...kept, ...added);
}

export default {
    name: "Customize Keyboard Shortcuts",
    setup(api) {
        const config = () => api.getConfig<Config>({});
        api.hooks.globalShortcutsWillChange.append((shortcuts) => remap(config(), "global", shortcuts, api));
        api.hooks.stateShortcutsWillChange.append((state, shortcuts) => remap(config(), state, shortcuts, api));
        api.hooks.editorDidInitShortcuts.append((shortcuts) => {
            const current = config();
            const changed = ACTIONS.filter((a) => a.where === "editor")
                .map((action) => ({ action, key: custom(current, action) }))
                .filter((c): c is { action: Action; key: string } => !!c.key);
            for (const { action, key } of changed) {
                if (key !== NOP) {
                    shortcuts.push([key, (editor) => action.run!(api, editor.frame)]);
                }
            }
            // the editor's own keys do nothing now, unless another action took them
            for (const { action } of changed) {
                if (!changed.some((c) => same(c.key, action.key))) {
                    shortcuts.push([action.key, () => {}]);
                }
            }
        });
        api.setConfigAction(async () => {
            const current = config();
            const values = await api.dialogs.openForm(
                ACTIONS.map((action) => ({
                    key: action.name,
                    label: action.name,
                    type: "text" as const,
                    value: current[action.name] ?? (action.key === " " ? "Space" : action.key),
                })),
                {
                    title: "Customize Keyboard Shortcuts",
                    text:
                        `Write keys like Ctrl+Shift+K, F5 or Enter; ${NOP} turns a shortcut off. Editor changes apply to editors opened afterwards.`,
                },
            );
            if (values) {
                api.setConfig(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v).trim()])));
                api.reapplyShortcuts();
            }
        });
    },
} satisfies Plugin;
