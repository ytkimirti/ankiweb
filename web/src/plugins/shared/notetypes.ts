// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** Adding the note types some bundled plugins bring, as desktop add-ons do with mw.col.models. */

import { StockNotetype_Kind } from "@generated/anki/notetypes_pb";

import { decodeJson64, encodeJson64 } from "../../lib/app/json64";
import type { NotetypeDict } from "$web/app/notetypes";
import type { PluginApi } from "$web/plugins/loader";

export type { NotetypeDict };

export async function notetypeIdByName(api: PluginApi, name: string): Promise<bigint | null> {
    return (await api.backend.getNotetypeNames({})).entries.find((entry) => entry.name === name)?.id ?? null;
}

/**
 * Adds a note type built from a stock one, as models.new() and models.add()
 * do; undoable like adding one in Manage Note Types.
 */
export async function addNotetype(
    api: PluginApi,
    cloze: boolean,
    build: (notetype: NotetypeDict) => void,
): Promise<bigint> {
    const stock = await api.backend.getStockNotetypeLegacy({
        kind: cloze ? StockNotetype_Kind.CLOZE : StockNotetype_Kind.BASIC,
    });
    const notetype = decodeJson64<NotetypeDict>(stock.json);
    notetype.id = 0;
    build(notetype);
    return (await api.backend.addNotetypeLegacy({ json: encodeJson64(notetype) })).id;
}

/** A field or template for a stock note type's lists, copying the first one's settings. */
export function withEntries<T extends { name: string; ord: number | null }>(
    template: T,
    names: string[],
    extra: (name: string, ord: number) => Partial<T> = () => ({}),
): T[] {
    return names.map((name, ord) => {
        const entry: T = { ...template, name, ord, ...extra(name, ord) };
        // new entries get ids of their own
        delete (entry as Record<string, unknown>).id;
        return entry;
    });
}

/** Loads a note type's legacy dict, lets `change` edit it, and saves it when it changed; undoable. */
export async function updateNotetype(
    api: PluginApi,
    ntid: bigint,
    change: (notetype: NotetypeDict) => void,
): Promise<boolean> {
    const { json: stored } = await api.backend.getNotetypeLegacy({ ntid });
    const notetype = decodeJson64<NotetypeDict>(stored);
    const before = new TextDecoder().decode(encodeJson64(notetype));
    change(notetype);
    const json = encodeJson64(notetype);
    if (new TextDecoder().decode(json) === before) {
        return false;
    }
    await api.backend.updateNotetypeLegacy({ json, skipChecks: false });
    return true;
}
