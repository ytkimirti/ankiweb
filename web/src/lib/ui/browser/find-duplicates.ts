// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** desktop's browser/find_duplicates.py and Collection.find_dupes() */

import { StripHtmlRequest_Mode } from "@generated/anki/card_rendering_pb";
import { SearchNode, SearchNode_Group_Joiner as Joiner } from "@generated/anki/search_pb";
import {
    buildSearchString,
    getNotetype,
    getNotetypeNamesAndCounts,
    searchNotes,
    stripHtml,
} from "@generated/backend";
import * as tr from "@generated/ftl";

import { getEngine } from "$web/app/backend";
import { openWindow } from "$web/app/windows";

import { group } from "./sidebar";

export type Dupe = [value: string, noteIds: bigint[]];

/** Every field name in the collection, as anki.find.fieldNames(). */
export async function allFieldNames(): Promise<string[]> {
    const { entries } = await getNotetypeNamesAndCounts({});
    const seen = new Map<string, string>();
    for (const entry of entries) {
        const nt = await getNotetype({ ntid: entry.id });
        for (const field of nt.fields) {
            if (!seen.has(field.name.toLowerCase())) {
                seen.set(field.name.toLowerCase(), field.name);
            }
        }
    }
    return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

export async function findDupes(fieldName: string, search: string): Promise<Dupe[]> {
    const nodes = [new SearchNode({ filter: { case: "fieldName", value: fieldName } })];
    if (search.trim()) {
        nodes.unshift(new SearchNode({ filter: { case: "parsableText", value: search } }));
    }
    const text = (await buildSearchString(group(Joiner.AND, nodes))).val;
    const { ids: noteIds } = await searchNotes({ search: text });
    const ords = new Map<string, number | null>();
    const ordFor = async (mid: bigint): Promise<number | null> => {
        const key = String(mid);
        if (!ords.has(key)) {
            const nt = await getNotetype({ ntid: mid });
            const index = nt.fields.findIndex((f) => f.name.toLowerCase() === fieldName.toLowerCase());
            ords.set(key, index < 0 ? null : index);
        }
        return ords.get(key)!;
    };
    const values = new Map<string, bigint[]>();
    const dupes: Dupe[] = [];
    const CHUNK = 500;
    for (let i = 0; i < noteIds.length; i += CHUNK) {
        const ids = noteIds.slice(i, i + CHUNK);
        const rows = (await getEngine().db({
            kind: "query",
            sql: `select id, mid, flds from notes where id in (${ids.join(",")})`,
            args: [],
            first_row_only: false,
        })) as [number | bigint, number | bigint, string][] | null;
        for (const [id, mid, flds] of rows ?? []) {
            const ord = await ordFor(BigInt(mid));
            if (ord === null) {
                continue;
            }
            const raw = flds.split("\x1f")[ord] ?? "";
            const value = (await stripHtml({ text: raw, mode: StripHtmlRequest_Mode.PRESERVE_MEDIA_FILENAMES })).val;
            // empty does not count as duplicate
            if (!value) {
                continue;
            }
            let list = values.get(value);
            if (!list) {
                list = [];
                values.set(value, list);
            }
            list.push(BigInt(id));
            if (list.length === 2) {
                dupes.push([value, list]);
            }
        }
    }
    return dupes;
}

export async function openFindDuplicates(searchFor: (text: string) => void): Promise<void> {
    const { default: FindDuplicates } = await import("./FindDuplicates.svelte");
    openWindow({
        key: "findDupes",
        title: tr.browsingFindDuplicates(),
        component: FindDuplicates,
        props: { searchFor },
        size: "md",
    });
}
