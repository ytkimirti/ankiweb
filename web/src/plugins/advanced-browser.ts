// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Advanced Browser, AnkiWeb 874215009: more columns for the browser, all
 * sortable, with the original's keys, so the column choices it saved on
 * desktop carry over. Review columns come from the review log; each note
 * field can be a column ("_field_<name>"); "Show internal fields" adds the
 * raw ids and scheduling values. In notes mode, review columns sum up the
 * note's cards.
 */

import {
    BrowserColumns_Alignment,
    BrowserColumns_Column,
    BrowserColumns_Sorting,
    SortOrder,
} from "@generated/anki/search_pb";

import type { Plugin, PluginApi } from "$web/plugins/loader";

type Format = "date" | "datetime" | "duration" | "ivl" | "days" | "pct" | "int" | "deck" | "flag" | "text" | "raw";

interface Column {
    key: string;
    label: string;
    /** SQL over cards c joined to notes n, and over notes n (null: cards mode only). */
    cards: string;
    notes: string | null;
    format: Format;
    /** Sorted descending first. */
    descending?: boolean;
}

/** today is replaced with the collection's day number. */
const TODAY = "{today}";

function revlog(agg: string, where = ""): { cards: string; notes: string } {
    // the review log's columns, where cards has some of the same names
    const qualify = (sql: string) => sql.replace(/\b(id|ease|time|ivl)\b/g, "r.$1");
    return {
        cards: `(select ${agg} from revlog where cid = c.id${where})`,
        notes: `(select ${qualify(agg)} from revlog r, cards c2 where r.cid = c2.id and c2.nid = n.id${
            qualify(where)
        })`,
    };
}

const due = "(case when c.odid then c.odue else c.due end)";

const COLUMNS: Column[] = [
    { key: "cfirst", label: "First Review", ...revlog("min(id)"), format: "date" },
    { key: "clast", label: "Last Review", ...revlog("max(id)"), format: "date" },
    { key: "cavgtime", label: "Time (Average)", ...revlog("avg(time)"), format: "duration" },
    { key: "ctottime", label: "Time (Total)", ...revlog("sum(time)"), format: "duration" },
    { key: "cfasttime", label: "Fastest Review", ...revlog("min(time)"), format: "duration" },
    { key: "cslowtime", label: "Slowest Review", ...revlog("max(time)"), format: "duration" },
    { key: "cAgainCount", label: "Again Count", ...revlog("count()", " and ease = 1"), format: "int" },
    {
        key: "coverdueivl",
        label: "Overdue Interval",
        cards: `(case when c.queue in (2, 3) and ${due} < ${TODAY} then ${TODAY} - ${due} end)`,
        notes: null,
        format: "days",
        descending: true,
    },
    {
        key: "cpercentageschedivl",
        label: "% of Ivl",
        cards: `(case when c.queue = 2 and c.ivl > 0 then 100.0 * (${TODAY} - (${due} - c.ivl)) / c.ivl end)`,
        notes: null,
        format: "pct",
        descending: true,
    },
    {
        key: "cprevivl",
        label: "Previous Interval",
        cards: "(select ivl from revlog where cid = c.id order by id desc limit 1 offset 1)",
        notes: null,
        format: "ivl",
    },
    {
        key: "cprevdur",
        label: "Previous Duration",
        cards: "(select time from revlog where cid = c.id order by id desc limit 1)",
        notes: null,
        format: "duration",
    },
    {
        key: "cpct",
        label: "Percent Correct",
        cards: "(case when c.reps > 0 then 100 - 100.0 * c.lapses / c.reps end)",
        notes:
            "(select case when sum(reps) > 0 then 100 - 100.0 * sum(lapses) / sum(reps) end from cards where nid = n.id)",
        format: "pct",
    },
    { key: "ctimecrtn", label: "Created Time (Note)", cards: "n.id", notes: "n.id", format: "datetime" },
    { key: "cdatecrtc", label: "Created Date (Card)", cards: "c.id", notes: null, format: "date" },
    { key: "ctimecrtc", label: "Created Time (Card)", cards: "c.id", notes: null, format: "datetime" },
    { key: "cdeck", label: "Current Deck (Filtered)", cards: "c.did", notes: null, format: "deck" },
    { key: "odeck", label: "Original Deck", cards: "(case when c.odid then c.odid end)", notes: null, format: "deck" },
    {
        key: "cflags",
        label: "Flag",
        cards: "(case when c.flags & 7 then c.flags & 7 end)",
        notes: null,
        format: "flag",
    },
];

const INTERNAL: Column[] = [
    { key: "nid", label: "Note ID", cards: "n.id", notes: "n.id", format: "raw" },
    { key: "nguid", label: "Note Guid", cards: "n.guid", notes: "n.guid", format: "raw" },
    { key: "nmid", label: "Model ID", cards: "n.mid", notes: "n.mid", format: "raw" },
    { key: "nusn", label: "Note USN", cards: "n.usn", notes: "n.usn", format: "raw" },
    { key: "cid", label: "Card ID", cards: "c.id", notes: null, format: "raw" },
    { key: "cdid", label: "Deck ID", cards: "c.did", notes: null, format: "raw" },
    { key: "codid", label: "Original Deck ID", cards: "c.odid", notes: null, format: "raw" },
    { key: "cord", label: "Card Ordinal", cards: "c.ord", notes: null, format: "raw" },
    { key: "cusn", label: "Card USN", cards: "c.usn", notes: null, format: "raw" },
    { key: "ctype", label: "Card Type", cards: "c.type", notes: null, format: "raw" },
    { key: "cqueue", label: "Card Queue", cards: "c.queue", notes: null, format: "raw" },
    { key: "cleft", label: "Card Left", cards: "c.left", notes: null, format: "raw" },
    { key: "codue", label: "Card Original Due", cards: "c.odue", notes: null, format: "raw" },
];

const FLAGS = ["", "Red", "Orange", "Green", "Blue", "Pink", "Turquoise", "Purple"];

function pad(n: number): string {
    return String(n).padStart(2, "0");
}

function date(ms: number, withTime: boolean): string {
    const d = new Date(ms);
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return withTime ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

function days(n: number): string {
    if (n < 30) {
        return `${Math.round(n)}d`;
    }
    if (n < 365) {
        return `${(n / 30).toFixed(1)}mo`;
    }
    return `${(n / 365).toFixed(1)}y`;
}

function duration(ms: number): string {
    const secs = ms / 1000;
    if (secs < 60) {
        return `${secs.toFixed(1)}s`;
    }
    return secs < 3600 ? `${(secs / 60).toFixed(1)}m` : `${(secs / 3600).toFixed(1)}h`;
}

function stripHtml(html: string): string {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

function format(value: unknown, kind: Format, deckNames: Map<string, string>): string {
    if (value === null || value === undefined || value === "") {
        return "";
    }
    const n = Number(value);
    switch (kind) {
        case "date":
            return date(n, false);
        case "datetime":
            return date(n, true);
        case "duration":
            return duration(n);
        case "ivl":
            // negative intervals are seconds, from learning steps
            return n < 0 ? duration(-n * 1000) : days(n);
        case "days":
            return days(n);
        case "pct":
            return `${Math.round(n)}%`;
        case "int":
            return String(Math.round(n));
        case "deck":
            return deckNames.get(String(value)) ?? String(value);
        case "flag":
            return FLAGS[n] ?? String(n);
        case "text":
            return stripHtml(String(value));
        default:
            return String(value);
    }
}

interface Config {
    showInternal: boolean;
    showFields: boolean;
}

const DEFAULTS: Config = { showInternal: false, showFields: true };

/** One column per field name, reading the field at its index in each note type that has it. */
async function fieldColumns(api: PluginApi): Promise<Column[]> {
    const byName = new Map<string, [mid: bigint, index: number][]>();
    for (const entry of (await api.backend.getNotetypeNames({})).entries) {
        const notetype = await api.backend.getNotetype({ ntid: entry.id });
        notetype.fields.forEach((field, index) => {
            byName.set(field.name, [...(byName.get(field.name) ?? []), [notetype.id, index]]);
        });
    }
    return [...byName.entries()].map(([name, places]) => {
        const sql = `(case n.mid ${
            places.map(([mid, i]) => `when ${mid} then field_at_index(n.flds, ${i})`).join(" ")
        } end)`;
        return { key: `_field_${name}`, label: name, cards: sql, notes: sql, format: "text" };
    });
}

export default {
    name: "Advanced Browser",
    setup(api) {
        const config = () => ({ ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) });
        let columns = new Map<string, Column>();
        let today = 0;
        let deckNames = new Map<string, string>();

        async function refreshDayAndDecks(): Promise<void> {
            today = (await api.backend.schedTimingToday({})).daysElapsed;
            const names = await api.backend.getDeckNames({ skipEmptyDefault: false, includeFiltered: true });
            deckNames = new Map(names.entries.map((e) => [String(e.id), e.name]));
        }

        const sql = (column: Column, notes: boolean) =>
            (notes ? column.notes : column.cards)?.replaceAll(TODAY, String(today)) ?? null;

        api.hooks.browserDidFetchColumns.append(async (list) => {
            const current = config();
            const ours = [
                ...COLUMNS,
                ...(current.showInternal ? INTERNAL : []),
                ...(current.showFields ? await fieldColumns(api) : []),
            ];
            await refreshDayAndDecks();
            columns = new Map(ours.map((c) => [c.key, c]));
            const taken = new Set(list.map((c) => c.key));
            for (const column of ours) {
                if (taken.has(column.key)) {
                    continue;
                }
                const sorting = column.descending
                    ? BrowserColumns_Sorting.DESCENDING
                    : BrowserColumns_Sorting.ASCENDING;
                list.push(
                    new BrowserColumns_Column({
                        key: column.key,
                        cardsModeLabel: column.label,
                        notesModeLabel: column.label,
                        cardsModeTooltip: column.key.startsWith("_field_") ? `Field: ${column.label}` : column.label,
                        notesModeTooltip: column.notes ? column.label : `${column.label} (cards mode only)`,
                        sortingCards: sorting,
                        sortingNotes: column.notes ? sorting : BrowserColumns_Sorting.NONE,
                        alignment: column.format === "text"
                            ? BrowserColumns_Alignment.START
                            : BrowserColumns_Alignment.CENTER,
                        usesCellFont: column.format === "text",
                    }),
                );
            }
        });

        api.hooks.browserWillSearch.append(async (context) => {
            const column = columns.get(context.sortColumn);
            if (!column) {
                return;
            }
            await refreshDayAndDecks();
            const expr = sql(column, context.notesMode);
            if (expr) {
                const order = `${expr}${column.format === "text" ? " collate nocase" : ""} ${
                    context.reverse ? "desc" : "asc"
                }`;
                context.order = new SortOrder({ value: { case: "custom", value: order } });
            }
        });

        api.hooks.browserDidFetchRow.append(async (id, isNote, row, keys) => {
            const wanted = keys
                .map((key, index) => ({ column: columns.get(key), index }))
                .filter((w): w is { column: Column; index: number } => !!w.column && !!sql(w.column, isNote));
            if (!wanted.length) {
                return;
            }
            const exprs = wanted.map((w) => sql(w.column, isNote)).join(", ");
            const values = isNote
                ? await api.db.first(`select ${exprs} from notes n where n.id = ?`, id)
                : await api.db.first(`select ${exprs} from cards c, notes n where c.nid = n.id and c.id = ?`, id);
            wanted.forEach(({ column, index }, i) => {
                const cell = row.cells[index];
                if (cell) {
                    cell.text = format(values?.[i], column.format, deckNames);
                }
            });
        });

        api.setConfigAction(async () => {
            const current = config();
            const values = await api.dialogs.openForm(
                [
                    {
                        key: "showFields",
                        label: "Offer a column for each note field",
                        type: "checkbox",
                        value: current.showFields,
                    },
                    {
                        key: "showInternal",
                        label: "Show internal fields",
                        type: "checkbox",
                        value: current.showInternal,
                    },
                ],
                { title: "Advanced Browser", text: "Changes apply when the browser is next opened." },
            );
            if (values) {
                api.setConfig({ ...current, ...values });
            }
        });
    },
} satisfies Plugin;
