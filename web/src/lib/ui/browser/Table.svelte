<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's browser/table: a virtualized list of cards or notes
    import { BrowserColumns_Alignment, BrowserRow_Color, type BrowserRow } from "@generated/anki/search_pb";

    import type { BrowserModel } from "./model.svelte";

    let {
        model,
        onActivate,
        onContextMenu,
        onHeaderMenu,
    }: {
        model: BrowserModel;
        /** Double click or Enter on a row. */
        onActivate: (id: bigint) => void;
        onContextMenu: (event: MouseEvent) => void;
        onHeaderMenu: (event: MouseEvent) => void;
    } = $props();

    const ROW_HEIGHT = 26;
    const OVERSCAN = 10;

    let viewport: HTMLDivElement;
    let scrollTop = $state(0);
    let height = $state(400);
    let rows = $state.raw<Map<bigint, BrowserRow>>(new Map());

    const first = $derived(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN));
    const last = $derived(Math.min(model.ids.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN));
    const visible = $derived(model.ids.slice(first, last));

    // fetch rows as they come into view
    $effect(() => {
        void model.rowsVersion;
        const ids = visible;
        let cancelled = false;
        const missing = ids.filter((id) => !model.cachedRow(id));
        const known = new Map<bigint, BrowserRow>();
        for (const id of ids) {
            const row = model.cachedRow(id);
            if (row) {
                known.set(id, row);
            }
        }
        rows = known;
        if (missing.length) {
            void Promise.all(missing.map((id) => model.fetchRow(id).then((row) => [id, row] as const))).then(
                (fetched) => {
                    if (cancelled) {
                        return;
                    }
                    const next = new Map(rows);
                    for (const [id, row] of fetched) {
                        if (row) {
                            next.set(id, row);
                        }
                    }
                    rows = next;
                },
            );
        }
        return () => {
            cancelled = true;
        };
    });

    // keep the focused row in view
    $effect(() => {
        const index = model.indexOf(model.current);
        if (index < 0 || !viewport) {
            return;
        }
        const top = index * ROW_HEIGHT;
        if (top < viewport.scrollTop) {
            viewport.scrollTop = top;
        } else if (top + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight - ROW_HEIGHT) {
            viewport.scrollTop = top + 2 * ROW_HEIGHT - viewport.clientHeight;
        }
    });

    const columns = $derived(model.activeColumns.map((key) => model.column(key)).filter((c) => !!c));

    const COLORS: Partial<Record<BrowserRow_Color, string>> = {
        [BrowserRow_Color.MARKED]: "--state-marked",
        [BrowserRow_Color.SUSPENDED]: "--state-suspended",
        [BrowserRow_Color.BURIED]: "--state-buried",
        [BrowserRow_Color.FLAG_RED]: "--flag-1",
        [BrowserRow_Color.FLAG_ORANGE]: "--flag-2",
        [BrowserRow_Color.FLAG_GREEN]: "--flag-3",
        [BrowserRow_Color.FLAG_BLUE]: "--flag-4",
        [BrowserRow_Color.FLAG_PINK]: "--flag-5",
        [BrowserRow_Color.FLAG_TURQUOISE]: "--flag-6",
        [BrowserRow_Color.FLAG_PURPLE]: "--flag-7",
    };

    function rowBackground(row: BrowserRow | undefined): string | undefined {
        const variable = row ? COLORS[row.color] : undefined;
        return variable ? `color-mix(in srgb, var(${variable}) 30%, transparent)` : undefined;
    }

    function onRowClick(event: MouseEvent, id: bigint): void {
        const toggle = /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
        model.select(id, event.shiftKey ? "range" : toggle ? "toggle" : "replace");
        viewport.focus();
    }

    function onRowContextMenu(event: MouseEvent, id: bigint): void {
        event.preventDefault();
        if (!model.selected.has(id)) {
            model.select(id);
        }
        onContextMenu(event);
    }

    function onKeydown(event: KeyboardEvent): void {
        const page = Math.max(1, Math.floor(viewport.clientHeight / ROW_HEIGHT) - 1);
        const map: Record<string, number | "first" | "last"> = {
            ArrowDown: 1,
            ArrowUp: -1,
            PageDown: page,
            PageUp: -page,
            Home: "first",
            End: "last",
        };
        const delta = map[event.key];
        if (delta !== undefined && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            model.move(delta, event.shiftKey);
        } else if (event.key === "Enter" && model.current !== null) {
            event.preventDefault();
            onActivate(model.current);
        } else if (event.key === "a" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
            event.preventDefault();
            model.selectAll();
        }
    }

    function sortIndicator(key: string): string {
        if (model.sortColumn !== key) {
            return "";
        }
        return model.sortBackwards ? "▼" : "▲";
    }

    let dragKey: string | null = null;

    function onHeaderDrop(event: DragEvent, index: number): void {
        event.preventDefault();
        if (dragKey) {
            void model.moveColumn(dragKey, index);
        }
        dragKey = null;
    }
</script>

<div class="table">
    <div class="header" role="row" tabindex="-1" oncontextmenu={(e) => (e.preventDefault(), onHeaderMenu(e))}>
        {#each columns as column, i (column.key)}
            <button
                type="button"
                class="cell"
                class:center={column.alignment === BrowserColumns_Alignment.CENTER}
                class:sortable={model.sortable(column)}
                title={model.tooltip(column)}
                draggable="true"
                ondragstart={() => (dragKey = column.key)}
                ondragover={(e) => e.preventDefault()}
                ondrop={(e) => onHeaderDrop(e, i)}
                onclick={() => void model.setSort(column.key)}
            >
                <span class="label">{model.label(column)}</span>
                <span class="sort">{sortIndicator(column.key)}</span>
            </button>
        {/each}
    </div>
    <div
        class="viewport"
        role="grid"
        tabindex="0"
        aria-rowcount={model.ids.length}
        aria-multiselectable="true"
        bind:this={viewport}
        bind:clientHeight={height}
        onscroll={() => (scrollTop = viewport.scrollTop)}
        onkeydown={onKeydown}
    >
        <div class="spacer" style:height="{model.ids.length * ROW_HEIGHT}px">
            {#each visible as id, i (id)}
                {@const row = rows.get(id)}
                <div
                    class="row"
                    role="row"
                    tabindex="-1"
                    aria-selected={model.selected.has(id)}
                    class:selected={model.selected.has(id)}
                    class:current={model.current === id}
                    style:top="{(first + i) * ROW_HEIGHT}px"
                    style:background={model.selected.has(id) ? undefined : rowBackground(row)}
                    onclick={(e) => onRowClick(e, id)}
                    ondblclick={() => onActivate(id)}
                    oncontextmenu={(e) => onRowContextMenu(e, id)}
                >
                    {#each columns as column, c (column.key)}
                        {@const cell = row?.cells[c]}
                        <div
                            class="cell"
                            role="gridcell"
                            class:center={column.alignment === BrowserColumns_Alignment.CENTER}
                            dir={cell?.isRtl ? "rtl" : undefined}
                            style:font-family={column.usesCellFont && row?.fontName ? row.fontName : undefined}
                            style:font-size={column.usesCellFont && row?.fontSize ? `${row.fontSize}px` : undefined}
                            title={cell?.text}
                        >
                            {cell?.text ?? ""}
                        </div>
                    {/each}
                </div>
            {/each}
        </div>
    </div>
</div>

<style lang="scss">
    .table {
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
        height: 100%;
        --row-height: 26px;
    }

    .header,
    .row {
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: minmax(4rem, 1fr);
    }

    .header {
        border-bottom: 1px solid var(--border);
        background: var(--canvas-elevated);
        user-select: none;
        .cell {
            display: flex;
            align-items: center;
            gap: 0.25rem;
            border: 0;
            border-inline-end: 1px solid var(--border-subtle);
            background: transparent;
            color: var(--fg);
            font-weight: 600;
            cursor: default;
            &.sortable {
                cursor: pointer;
            }
            &.center {
                justify-content: center;
            }
        }
        .label {
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .sort {
            font-size: 0.7em;
            color: var(--fg-subtle);
        }
    }

    .viewport {
        flex: 1;
        min-height: 0;
        overflow: auto;
        outline: none;
        &:focus-visible .current {
            outline: 1px solid var(--border-focus);
            outline-offset: -1px;
        }
    }

    .spacer {
        position: relative;
        min-width: 100%;
    }

    .row {
        position: absolute;
        left: 0;
        right: 0;
        height: var(--row-height);
        border-bottom: 1px solid var(--border-subtle);
        cursor: default;
        user-select: none;
        &.selected {
            background: var(--selected-bg, color-mix(in srgb, var(--border-focus) 35%, transparent));
        }
    }

    .cell {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        padding: 0 0.4rem;
        line-height: var(--row-height);
        min-width: 0;
        &.center {
            text-align: center;
        }
    }
</style>
