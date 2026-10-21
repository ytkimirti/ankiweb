// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** desktop's browser/find_and_replace.py */

import { fieldNamesForNotes, findAndReplace, findAndReplaceTag } from "@generated/backend";
import * as tr from "@generated/ftl";

import { openForm, tooltip } from "$web/app/dialogs";
import { getProfileConfig, setProfileConfig } from "$web/app/profiles";
import { runOp } from "$web/app/run";

const KEY = "BrowserFindAndReplace";
const plain = (label: string) => label.replace(/<[^>]+>/g, "").replace(/:$/, "");

export async function openFindReplace(noteIds: bigint[], field?: string): Promise<void> {
    const names = field
        ? [field]
        : noteIds.length
        ? ((await runOp(() => fieldNamesForNotes({ nids: noteIds })))?.fields ?? [])
        : [];
    // "all fields" and "tags" come first, as on desktop
    const options = [
        { value: "\u0000all", label: tr.browsingAllFields() },
        { value: "\u0000tags", label: tr.editingTags() },
        ...names.map((name) => ({ value: name, label: name })),
    ];
    const lastField = getProfileConfig<string>(`${KEY}Field`, "\u0000all");
    const values = await openForm(
        [
            { key: "find", label: plain(tr.browsingFind()), type: "text", value: getProfileConfig(`${KEY}Find`, "") },
            {
                key: "replace",
                label: plain(tr.browsingReplaceWith()),
                type: "text",
                value: getProfileConfig(`${KEY}Replace`, ""),
            },
            {
                key: "field",
                label: plain(tr.browsingIn()),
                type: "select",
                value: field ?? (options.some((o) => o.value === lastField) ? lastField : "\u0000all"),
                options,
            },
            ...(noteIds.length
                ? [
                    {
                        key: "selected",
                        label: tr.browsingSelectedNotesOnly(),
                        type: "checkbox" as const,
                        value: !field,
                    },
                ]
                : []),
            {
                key: "ignoreCase",
                label: tr.browsingIgnoreCase(),
                type: "checkbox",
                value: getProfileConfig(`${KEY}ignoreCase`, true),
            },
            {
                key: "regex",
                label: tr.browsingTreatInputAsRegularExpression(),
                type: "checkbox",
                value: getProfileConfig(`${KEY}Regex`, false),
            },
        ],
        { title: tr.browsingFindAndReplace() },
    );
    if (!values) {
        return;
    }
    const search = String(values.find);
    const replacement = String(values.replace);
    const regex = !!values.regex;
    const matchCase = !values.ignoreCase;
    const chosen = String(values.field);
    setProfileConfig(`${KEY}Find`, search);
    setProfileConfig(`${KEY}Replace`, replacement);
    setProfileConfig(`${KEY}Field`, chosen);
    setProfileConfig(`${KEY}Regex`, regex);
    setProfileConfig(`${KEY}ignoreCase`, !matchCase);
    // an empty list means all notes
    const nids = values.selected ? noteIds : [];

    const out = chosen === "\u0000tags"
        ? await runOp(() => findAndReplaceTag({ noteIds: nids, search, replacement, regex, matchCase }))
        : await runOp(() =>
            findAndReplace({
                nids,
                search,
                replacement,
                regex,
                matchCase,
                fieldName: chosen === "\u0000all" ? "" : chosen,
            })
        );
    if (!out) {
        return;
    }
    tooltip(
        nids.length
            ? tr.findreplaceNotesUpdated({ changed: out.count, total: nids.length })
            : tr.browsingNotesUpdated({ count: out.count }),
    );
}
