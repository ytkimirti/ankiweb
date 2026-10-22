// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Enhanced Cloze, AnkiWeb 1990296174: brings the original's "Enhanced Cloze
 * 2.1 v2" note type (templates by RisingOrange, GPL 3), where every cloze of
 * a note shows on one card and is revealed one by one with a tap or J, and
 * "pseudo clozes" ({{c0::...}} or ones of other cards) can be revealed with
 * N. The note type is added when a profile opens (after the sync it opens
 * with), or updated when the add-on brings a newer version of it (keeping its
 * options), and jQuery, which the templates load, is put into the media
 * folder. Tools > Enhanced Cloze has
 * the original's Config, which edits the options in the front template, and
 * resets of the note type and of its styling. A note whose Content has no
 * genuine clozes needs {{c1::.}} in its Cloze99 field (sticky), which the
 * original fills in when a note is saved.
 */

import { get } from "svelte/store";

import { mediaProfile } from "../lib/app/media";
import type { Plugin, PluginApi } from "$web/plugins/loader";
import { readMediaFile } from "../lib/media-file";

import { addNotetype, notetypeIdByName, type NotetypeDict, updateNotetype, withEntries } from "./shared/notetypes";

export const MODEL_NAME = "Enhanced Cloze 2.1 v2";
const FIELDS = ["Content", "Note", "Mnemonics", "Extra", "Cloze99"];
const JQUERY = "_jquery.min.js";
const SEPARATOR = "<!-- ENHANCED_CLOZE -->";

export type Options = Record<string, string | boolean>;

/** The options the original's config window edits, with its labels, in its order. */
export const OPTION_LABELS: [key: string, label: string][] = [
    ["revealNextGenuineClozeShortcut", "Shortcut to reveal next genuine cloze"],
    ["revealAllGenuineClozesShortcut", "Shortcut to reveal all genuine clozes"],
    ["revealNextPseudoClozeShortcut", "Shortcut to reveal next pseudo cloze"],
    ["revealAllPseudoClozesShortcut", "Shortcut to reveal all pseudo clozes"],
    ["swapLeftAndRightBorderActions", "Swap left and right border actions"],
    ["underlineRevealedPseudoClozes", "Underline revealed pseudo clozes"],
    ["underlineRevealedGenuineClozes", "Underline revealed genuine clozes"],
    ["showHintsForPseudoClozes", "Show hints for pseudo clozes"],
    ["revealPseudoClozesByDefault", "Reveal pseudo clozes by default"],
    ["scrollToClozeOnToggle", "Scroll to cloze on toggle"],
    ["animateScroll", "Animate scrolling"],
];

/** The "<!-- VERSION x.y -->" a front template starts with, or null. */
export function templateVersion(front: string): number[] | null {
    const m = /^<!-- VERSION (.+?) -->/.exec(front);
    return m ? m[1].split(".").map(Number) : null;
}

export function olderVersion(a: number[], b: number[]): boolean {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) {
            return (a[i] ?? 0) < (b[i] ?? 0);
        }
    }
    return false;
}

function setVersion(front: string, version: number[]): string {
    return front.replace(/<!-- VERSION (.+?) -->/, `<!-- VERSION ${version.join(".")} -->`);
}

function configSection(front: string): string | null {
    return /([\w\W]*?)<!-- CONFIG END -->/.exec(front)?.[1] ?? null;
}

/** The original's maybe_add_config_option: adds a "var" line after another option's, if missing. */
export function maybeAddConfigOption(front: string, option: string, line: string, previous: string): string {
    const config = configSection(front);
    if (config === null || config.includes(option)) {
        return front;
    }
    const updated = config.replace(
        new RegExp(`(?<=\\n)(.*)(var +${previous}.+)\\n`),
        (_m, indent: string, rest: string) => `${indent}${rest}\n${indent}${line}\n`,
    );
    return updated + front.slice(config.length);
}

/**
 * The original's add_or_update_model for a note type that has a version:
 * the incoming template after the separator, with the current one's options
 * before it.
 */
export function updatedFront(current: string, incoming: string): string {
    const at = current.indexOf(SEPARATOR);
    if (at < 0) {
        return incoming;
    }
    const after = incoming.slice(incoming.indexOf(SEPARATOR) + SEPARATOR.length);
    let front = setVersion(`${current.slice(0, at)}${SEPARATOR}${after}`, templateVersion(incoming) ?? []);
    const added: [string, string, string][] = [
        ["animateScroll", "var animateScroll = true", "scrollToClozeOnToggle"],
        ["showHintsForPseudoClozes", "var showHintsForPseudoClozes = true", "animateScroll"],
        ["underlineRevealedPseudoClozes", "var underlineRevealedPseudoClozes = true", "showHintsForPseudoClozes"],
        ["underlineRevealedGenuineClozes", "var underlineRevealedGenuineClozes = true", "underlineRevealedPseudoClozes"],
        ["revealPseudoClozesByDefault", "var revealPseudoClozesByDefault = false", "underlineRevealedGenuineClozes"],
        ["swapLeftAndRightBorderActions", "var swapLeftAndRightBorderActions = false", "revealPseudoClozesByDefault"],
    ];
    for (const [option, line, previous] of added) {
        front = maybeAddConfigOption(front, option, line, previous);
    }
    return front;
}

/** A JS string literal's value, as written by frontWithOptions or by hand. */
function unquote(literal: string): string {
    try {
        return String(JSON.parse(literal));
    } catch {
        return literal.slice(1, -1);
    }
}

/** The original's config_values_from_model: the options' values in the front template. */
export function optionsFromFront(front: string): Options {
    const out: Options = {};
    for (const raw of (configSection(front) ?? "").split("\n")) {
        const line = raw.trim();
        const m = line.startsWith("var") ? /^var +(.+?) *= *(.+)/.exec(line) : null;
        if (!m) {
            continue;
        }
        const [, key, value] = m;
        out[key] = value === "true"
            ? true
            : value === "false"
            ? false
            : value.startsWith("\"") && value.endsWith("\"")
            ? unquote(value)
            : value;
    }
    return out;
}

/** The original's update_model_options_with_config_values, or null if the template has no options script. */
export function frontWithOptions(front: string, options: Options): string | null {
    const lines = Object.entries(options).map(([key, value]) =>
        `var ${key}=${typeof value === "string" ? JSON.stringify(value).replace(/</g, "\\u003c") : value ? "true" : "false"}`
    );
    const script = `<script>\n${lines.join("\n")}\n</script>`;
    const re = /<script>[\w\W]*?<\/script>(?=\n<!-- CONFIG END -->)/;
    return re.test(front) ? front.replace(re, () => script) : null;
}

async function sources(): Promise<{ front: string; back: string; css: string }> {
    const [front, back, css] = await Promise.all([
        import("./assets/enhanced-cloze/front.html?raw"),
        import("./assets/enhanced-cloze/back.html?raw"),
        import("./assets/enhanced-cloze/css.css?raw"),
    ]);
    return { front: front.default, back: back.default, css: css.default };
}

/** Puts jQuery into the media folder for the templates, unless a file of that name is there. */
async function maybeAddJquery(api: PluginApi): Promise<void> {
    if (await readMediaFile(mediaProfile(), `/${JQUERY}`, null)) {
        return;
    }
    const jquery = (await import("./assets/enhanced-cloze/_jquery.min.js?raw")).default;
    await api.backend.addMediaFile({ desiredName: JQUERY, data: new TextEncoder().encode(jquery) });
}

function fillModel(nt: NotetypeDict, src: { front: string; back: string; css: string }): void {
    nt.name = MODEL_NAME;
    nt.sortf = 0;
    nt.flds = withEntries(nt.flds[0], FIELDS, (name) => ({
        font: "Arial",
        size: name === "Cloze99" ? 1 : 20,
        sticky: name === "Cloze99",
        rtl: false,
    }));
    nt.tmpls = withEntries(nt.tmpls[0], ["Enhanced Cloze"], () => ({ qfmt: src.front, afmt: src.back }));
    nt.css = src.css;
}

/** The original's add_or_update_model; true if the note type is there afterwards. */
async function addOrUpdateModel(api: PluginApi): Promise<boolean> {
    const src = await sources();
    const ntid = await notetypeIdByName(api, MODEL_NAME);
    if (!ntid) {
        await addNotetype(api, true, (nt) => fillModel(nt, src));
        api.main.reset();
        return true;
    }
    const incoming = templateVersion(src.front)!;
    const changed = await updateNotetype(api, ntid, (nt) => {
        const template = nt.tmpls[0];
        const current = template ? templateVersion(template.qfmt) : null;
        // a note type from before versions needs fields removed (a schema change),
        // which the original asks about; it is left as it is
        if (!template || !current || !olderVersion(current, incoming)) {
            return;
        }
        template.qfmt = updatedFront(template.qfmt, src.front);
        template.afmt = src.back;
    });
    if (changed) {
        api.dialogs.tooltip(`Updated the ${MODEL_NAME} note type.`);
        api.main.reset();
    }
    return true;
}

async function openConfig(api: PluginApi): Promise<void> {
    await addOrUpdateModel(api);
    const ntid = await notetypeIdByName(api, MODEL_NAME);
    if (!ntid) {
        return;
    }
    const nt = await api.backend.getNotetype({ ntid });
    const current = optionsFromFront(nt.templates[0]?.config?.qFormat ?? "");
    const values = await api.dialogs.openForm(
        OPTION_LABELS.filter(([key]) => key in current).map(([key, label]) =>
            typeof current[key] === "boolean"
                ? { key, label, type: "checkbox" as const, value: current[key] as boolean }
                : { key, label, type: "text" as const, value: String(current[key]) }
        ),
        { title: "Enhanced Cloze", text: `The options of the ${MODEL_NAME} note type's cards.` },
    );
    if (!values) {
        return;
    }
    const options: Options = { ...current };
    for (const [key, value] of Object.entries(values)) {
        options[key] = typeof current[key] === "boolean" ? !!value : String(value);
    }
    let failed = false;
    await updateNotetype(api, ntid, (dict) => {
        const front = dict.tmpls[0] ? frontWithOptions(dict.tmpls[0].qfmt, options) : null;
        if (front === null) {
            failed = true;
        } else {
            dict.tmpls[0].qfmt = front;
        }
    });
    if (failed) {
        await api.dialogs.showWarning("Could not update note type options.");
    }
}

async function resetNotetype(api: PluginApi): Promise<void> {
    if (
        !(await api.dialogs.askUser(
            "This will reset the Enhanced Cloze note type to its default version.\n\n"
                + "Note: After doing this the next you time you synchronize Anki will require a full sync to AnkiWeb.\n\n"
                + "Continue?",
        ))
    ) {
        return;
    }
    const ntid = await notetypeIdByName(api, MODEL_NAME);
    if (!ntid) {
        await addOrUpdateModel(api);
        return;
    }
    const src = await sources();
    await updateNotetype(api, ntid, (nt) => {
        // fields are matched by name and keep their ids and contents; others are dropped, as the original does
        const fields = new Map(nt.flds.map((f) => [f.name, f]));
        const template = nt.tmpls[0];
        const fresh = structuredClone(nt);
        fillModel(fresh, src);
        nt.flds = fresh.flds.map((f) => {
            const old = fields.get(f.name);
            return old ? { ...f, id: old.id, ord: old.ord } : { ...f, ord: null };
        });
        nt.tmpls = [{ ...template, qfmt: src.front, afmt: src.back }];
        nt.css = src.css;
        nt.sortf = 0;
    });
    api.main.reset();
    api.dialogs.tooltip("Successfully reset Enhanced Cloze note type.");
}

async function resetCss(api: PluginApi): Promise<void> {
    if (
        !(await api.dialogs.askUser(
            "This will reset the styling (css) of the Enhanced Cloze note type to its default version.\n\nContinue?",
        ))
    ) {
        return;
    }
    const ntid = await notetypeIdByName(api, MODEL_NAME);
    if (!ntid) {
        await addOrUpdateModel(api);
        return;
    }
    const { css } = await sources();
    await updateNotetype(api, ntid, (nt) => {
        nt.css = css;
    });
    api.main.reset();
    api.dialogs.tooltip("Successfully reset Enhanced Cloze note type styling.");
}

export default {
    name: "Enhanced Cloze",
    setup(api) {
        let running: Promise<unknown> | null = null;
        const onProfile = () => {
            running ??= Promise.all([addOrUpdateModel(api), maybeAddJquery(api)])
                .catch((err) => console.error("enhanced cloze", err))
                .finally(() => (running = null));
        };
        // as the original, wait for the sync a profile opens with, so a note type the
        // server already has is not added a second time
        let syncing = false;
        let afterSync = false;
        let opening = false;
        const whenNotSyncing = () => {
            if (syncing) {
                afterSync = true;
            } else {
                onProfile();
            }
        };
        api.hooks.syncWillStart.append(() => {
            syncing = true;
        });
        api.hooks.syncDidFinish.append(() => {
            syncing = false;
            if (afterSync) {
                afterSync = false;
                onProfile();
            }
        });
        api.hooks.profileDidOpen.append(() => {
            opening = true;
        });
        api.hooks.stateDidChange.append((state) => {
            if (opening && state === "deckBrowser") {
                opening = false;
                // the automatic sync starts right after the deck list shows
                setTimeout(whenNotSyncing, 0);
            }
        });
        if (["deckBrowser", "overview", "review"].includes(get(api.main.mainState))) {
            whenNotSyncing();
        }
        const run = (fn: (api: PluginApi) => Promise<void>) => () =>
            void (async () => {
                await running;
                await fn(api);
            })().catch((err) => api.dialogs.showError(err));

        api.hooks.mainMenuWillShow.append((sections) => {
            (sections.find((s) => s.title.replace(/&/g, "") === "Tools") ?? sections[3])?.items.push({
                label: "Enhanced Cloze",
                submenu: [
                    { label: "Config", action: run(openConfig) },
                    { label: "Reset Enhanced Cloze note type", action: run(resetNotetype) },
                    { label: "Reset Enhanced Cloze note type styling (css)", action: run(resetCss) },
                ],
            });
        });
        api.setConfigAction(run(openConfig));
    },
} satisfies Plugin;
