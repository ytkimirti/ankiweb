// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * The browser's table state (desktop's browser/table/state.py, model.py and
 * table.py): cards or notes mode, columns, sorting, the search result and the
 * selection. Rows are fetched from the backend as they scroll into view.
 */

import { ConfigKey_Bool } from "@generated/anki/config_pb";
import {
    BrowserColumns_Column,
    BrowserColumns_Sorting,
    type BrowserRow,
    SearchNode,
    SortOrder,
} from "@generated/anki/search_pb";
import {
    allBrowserColumns,
    browserRowForId,
    buildSearchString,
    getConfigBool,
    getConfigJson,
    searchCards,
    searchNotes,
    setActiveBrowserColumns,
    setConfigBool,
    setConfigJson,
} from "@generated/backend";

const CARD_COLUMNS = ["noteFld", "template", "cardDue", "deck"];
const NOTE_COLUMNS = ["noteFld", "note", "template", "noteTags"];

const keys = (notes: boolean) => ({
    active: notes ? "activeNoteCols" : "activeCols",
    sort: notes ? "noteSortType" : "sortType",
    backwards: notes ? "browserNoteSortBackwards" : "sortBackwards",
});

async function readJson<T>(key: string, fallback: T): Promise<T> {
    try {
        const out = await getConfigJson({ val: key }, { alertOnError: false });
        const value = JSON.parse(new TextDecoder().decode(out.json));
        // unset keys come back as null; ignore values of the wrong type
        return value !== null && typeof value === typeof fallback && Array.isArray(value) === Array.isArray(fallback)
            ? (value as T)
            : fallback;
    } catch {
        return fallback;
    }
}

function writeJson(key: string, value: unknown): Promise<unknown> {
    return setConfigJson({ key, valueJson: new TextEncoder().encode(JSON.stringify(value)), undoable: false });
}

function idSearch(prefix: "cid" | "nid", ids: bigint[]): string {
    return `${prefix}:${ids.join(",")}`;
}

export class BrowserModel {
    notesMode = $state(false);
    allColumns = $state.raw<BrowserColumns_Column[]>([]);
    activeColumns = $state.raw<string[]>([]);
    sortColumn = $state("");
    sortBackwards = $state(false);
    /** The normalized search that produced `ids`. */
    search = $state("");
    ids = $state.raw<bigint[]>([]);
    /** Bumped when cached rows are dropped, so visible rows refetch. */
    rowsVersion = $state(0);
    selected = $state.raw<Set<bigint>>(new Set());
    /** The focused row; it is also what the editor shows when one row is selected. */
    current = $state<bigint | null>(null);
    private anchor: bigint | null = null;
    private rows = new Map<bigint, BrowserRow>();
    private pending = new Map<bigint, Promise<BrowserRow | null>>();

    async init(): Promise<void> {
        const [mode, columns] = await Promise.all([
            getConfigBool({ key: ConfigKey_Bool.BROWSER_TABLE_SHOW_NOTES_MODE }),
            allBrowserColumns({}),
        ]);
        this.allColumns = columns.columns;
        await this.loadMode(mode.val);
    }

    private async loadMode(notes: boolean): Promise<void> {
        const k = keys(notes);
        const active = await readJson<string[]>(k.active, notes ? NOTE_COLUMNS : CARD_COLUMNS);
        this.notesMode = notes;
        this.activeColumns = active.filter((key) => this.column(key));
        if (!this.activeColumns.length) {
            this.activeColumns = notes ? NOTE_COLUMNS : CARD_COLUMNS;
        }
        await setActiveBrowserColumns({ vals: this.activeColumns });
        this.sortColumn = await readJson<string>(k.sort, "noteCrt");
        this.sortBackwards = await readJson<boolean>(k.backwards, false);
        this.clearRows();
    }

    column(key: string): BrowserColumns_Column | undefined {
        return this.allColumns.find((c) => c.key === key);
    }

    label(column: BrowserColumns_Column): string {
        return this.notesMode ? column.notesModeLabel : column.cardsModeLabel;
    }

    tooltip(column: BrowserColumns_Column): string {
        return this.notesMode ? column.notesModeTooltip : column.cardsModeTooltip;
    }

    sortable(column: BrowserColumns_Column): boolean {
        return (this.notesMode ? column.sortingNotes : column.sortingCards) !== BrowserColumns_Sorting.NONE;
    }

    private sortOrder(): SortOrder {
        const column = this.column(this.sortColumn);
        if (column && this.sortable(column)) {
            return new SortOrder({
                value: { case: "builtin", value: { column: column.key, reverse: this.sortBackwards } },
            });
        }
        return new SortOrder({ value: { case: "none", value: {} } });
    }

    /** Normalizes a typed search; throws a user-facing error if it is invalid. */
    async normalize(text: string | SearchNode): Promise<string> {
        const node = typeof text === "string" ? new SearchNode({ filter: { case: "parsableText", value: text } }) : text;
        return (await buildSearchString(node, { alertOnError: false })).val;
    }

    /** Runs a search, keeping the selection where possible. */
    async runSearch(search: string, keepSelection = false): Promise<void> {
        const request = { search, order: this.sortOrder() };
        const out = await (this.notesMode ? searchNotes(request, { alertOnError: false }) : searchCards(request, { alertOnError: false }));
        this.search = search;
        this.ids = out.ids;
        this.clearRows();
        if (keepSelection) {
            const present = new Set(out.ids);
            this.selected = new Set([...this.selected].filter((id) => present.has(id)));
            if (this.current !== null && !present.has(this.current)) {
                this.current = null;
            }
        } else {
            this.selected = new Set();
            this.current = null;
        }
    }

    /** Re-runs the current search, e.g. after the collection changed. */
    redoSearch(): Promise<void> {
        return this.runSearch(this.search, true);
    }

    clearRows(): void {
        this.rows.clear();
        this.pending.clear();
        this.rowsVersion++;
    }

    cachedRow(id: bigint): BrowserRow | undefined {
        return this.rows.get(id);
    }

    /** Fetches a row, resolving null if the item no longer exists. */
    fetchRow(id: bigint): Promise<BrowserRow | null> {
        const cached = this.rows.get(id);
        if (cached) {
            return Promise.resolve(cached);
        }
        let pending = this.pending.get(id);
        if (!pending) {
            const version = this.rowsVersion;
            pending = browserRowForId({ val: id }, { alertOnError: false })
                .then((row) => {
                    if (version === this.rowsVersion) {
                        this.rows.set(id, row);
                    }
                    return row;
                })
                .catch(() => null)
                .finally(() => this.pending.delete(id));
            this.pending.set(id, pending);
        }
        return pending;
    }

    // Columns and sorting
    ////////////////////////////////////////////////////////////////////////

    async setSort(key: string): Promise<void> {
        const column = this.column(key);
        if (!column || !this.sortable(column)) {
            return;
        }
        if (this.sortColumn === key) {
            this.sortBackwards = !this.sortBackwards;
        } else {
            this.sortColumn = key;
            this.sortBackwards = (this.notesMode ? column.sortingNotes : column.sortingCards)
                === BrowserColumns_Sorting.DESCENDING;
        }
        const k = keys(this.notesMode);
        await writeJson(k.sort, this.sortColumn);
        await writeJson(k.backwards, this.sortBackwards);
        await this.redoSearch();
    }

    async toggleColumn(key: string): Promise<void> {
        const active = this.activeColumns.includes(key)
            ? this.activeColumns.filter((k) => k !== key)
            : [...this.activeColumns, key];
        if (!active.length) {
            return;
        }
        this.activeColumns = active;
        await writeJson(keys(this.notesMode).active, active);
        await setActiveBrowserColumns({ vals: active });
        this.clearRows();
    }

    async moveColumn(key: string, toIndex: number): Promise<void> {
        const active = this.activeColumns.filter((k) => k !== key);
        active.splice(toIndex, 0, key);
        this.activeColumns = active;
        await writeJson(keys(this.notesMode).active, active);
        await setActiveBrowserColumns({ vals: active });
        this.clearRows();
    }

    /** Switches between cards and notes, keeping the selection (desktop's toggle_state). */
    async toggleMode(): Promise<void> {
        const notes = !this.notesMode;
        const selected = [...this.selected];
        const current = this.current;
        await setConfigBool({ key: ConfigKey_Bool.BROWSER_TABLE_SHOW_NOTES_MODE, value: !this.notesMode, undoable: false });
        const converted = selected.length ? await this.convertIds(selected, notes) : [];
        const convertedCurrent = current !== null ? (await this.convertIds([current], notes))[0] ?? null : null;
        await this.loadMode(notes);
        await this.runSearch(this.search);
        const present = new Set(this.ids);
        this.selected = new Set(converted.filter((id) => present.has(id)));
        this.current = convertedCurrent !== null && present.has(convertedCurrent) ? convertedCurrent : null;
    }

    /** Converts card ids to note ids (toNotes) or note ids to card ids. */
    private async convertIds(ids: bigint[], toNotes: boolean): Promise<bigint[]> {
        const order = new SortOrder({ value: { case: "none", value: {} } });
        return toNotes
            ? (await searchNotes({ search: idSearch("cid", ids), order })).ids
            : (await searchCards({ search: idSearch("nid", ids), order })).ids;
    }

    async selectedCardIds(): Promise<bigint[]> {
        const ids = this.selectionInOrder();
        return this.notesMode && ids.length ? this.convertIds(ids, false) : ids;
    }

    async selectedNoteIds(): Promise<bigint[]> {
        const ids = this.selectionInOrder();
        return !this.notesMode && ids.length ? this.convertIds(ids, true) : ids;
    }

    async currentCardId(): Promise<bigint | null> {
        if (this.current === null) {
            return null;
        }
        return this.notesMode ? (await this.convertIds([this.current], false))[0] ?? null : this.current;
    }

    async currentNoteId(): Promise<bigint | null> {
        if (this.current === null) {
            return null;
        }
        return this.notesMode ? this.current : (await this.convertIds([this.current], true))[0] ?? null;
    }

    // Selection
    ////////////////////////////////////////////////////////////////////////

    selectionInOrder(): bigint[] {
        if (this.selected.size === this.ids.length) {
            return [...this.ids];
        }
        return this.ids.filter((id) => this.selected.has(id));
    }

    get singleSelection(): bigint | null {
        return this.selected.size === 1 ? [...this.selected][0] : null;
    }

    /** Click/keyboard selection with Ctrl/Shift semantics. */
    select(id: bigint, mode: "replace" | "toggle" | "range" = "replace"): void {
        if (mode === "range" && this.anchor !== null) {
            const a = this.ids.indexOf(this.anchor);
            const b = this.ids.indexOf(id);
            if (a >= 0 && b >= 0) {
                const [start, end] = a < b ? [a, b] : [b, a];
                this.selected = new Set(this.ids.slice(start, end + 1));
                this.current = id;
                return;
            }
        }
        if (mode === "toggle") {
            const next = new Set(this.selected);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            this.selected = next;
        } else {
            this.selected = new Set([id]);
        }
        this.current = id;
        this.anchor = id;
    }

    selectAll(): void {
        this.selected = new Set(this.ids);
    }

    invertSelection(): void {
        this.selected = new Set(this.ids.filter((id) => !this.selected.has(id)));
    }

    clearSelection(): void {
        this.selected = new Set();
        this.current = null;
    }

    /** Moves the focus by `delta` rows (or to an end), selecting that row. */
    move(delta: number | "first" | "last", extend = false): void {
        if (!this.ids.length) {
            return;
        }
        const index = this.current === null ? -1 : this.ids.indexOf(this.current);
        let next: number;
        if (delta === "first") {
            next = 0;
        } else if (delta === "last") {
            next = this.ids.length - 1;
        } else {
            next = Math.min(this.ids.length - 1, Math.max(0, index < 0 ? 0 : index + delta));
        }
        this.select(this.ids[next], extend ? "range" : "replace");
    }

    indexOf(id: bigint | null): number {
        return id === null ? -1 : this.ids.indexOf(id);
    }

    /** Selects the item for a card, switching to its note in notes mode. */
    async selectCard(cardId: bigint): Promise<void> {
        const id = this.notesMode ? (await this.convertIds([cardId], true))[0] : cardId;
        if (id !== undefined && this.ids.includes(id)) {
            this.select(id);
        }
    }
}
