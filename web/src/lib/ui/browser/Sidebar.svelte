<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's browser/sidebar
    import { SetDeckCollapsedRequest_Scope } from "@generated/anki/decks_pb";
    import { setDeckCollapsed, setTagCollapsed } from "@generated/backend";
    import * as tr from "@generated/ftl";

    import { filterTree, setRootExpanded, type SidebarItem } from "./sidebar";

    let {
        items,
        onSearch,
        onContextMenu,
    }: {
        items: SidebarItem[];
        /** Searches for an item; modifiers combine it with the current search. */
        onSearch: (item: SidebarItem, modifiers: { and: boolean; or: boolean; not: boolean }) => void;
        onContextMenu: (item: SidebarItem, event: MouseEvent) => void;
    } = $props();

    let filter = $state("");
    let expanded = $state<Record<string, boolean>>({});
    let focused = $state<string | null>(null);

    const shown = $derived(filterTree(items, filter));

    function isExpanded(item: SidebarItem): boolean {
        return filter.trim() ? true : expanded[item.key] ?? item.expanded;
    }

    function toggle(item: SidebarItem): void {
        const next = !isExpanded(item);
        expanded = { ...expanded, [item.key]: next };
        if (item.kind.endsWith("Root")) {
            setRootExpanded(item.kind, next);
        } else if (item.kind === "deck" && typeof item.id === "bigint") {
            void setDeckCollapsed(
                { deckId: item.id, collapsed: !next, scope: SetDeckCollapsedRequest_Scope.BROWSER },
                { alertOnError: false },
            );
        } else if (item.kind === "tag" && typeof item.id === "string") {
            void setTagCollapsed({ name: item.id, collapsed: !next }, { alertOnError: false });
        }
    }

    function activate(item: SidebarItem, event: MouseEvent | KeyboardEvent): void {
        focused = item.key;
        if (!item.search) {
            toggle(item);
            return;
        }
        const ctrl = /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
        onSearch(item, { and: ctrl, or: event.shiftKey, not: event.altKey });
    }

    /** Expands or collapses an item, as the user clicking its arrow would. */
    export function setExpanded(item: SidebarItem, value: boolean): void {
        if (item.children.length && isExpanded(item) !== value) {
            toggle(item);
        }
    }

    export function focusFilter(): void {
        filterInput?.focus();
        filterInput?.select();
    }

    let filterInput: HTMLInputElement | undefined = $state();
</script>

{#snippet tree(nodes: SidebarItem[], depth: number)}
    {#each nodes as item (item.key)}
        <li role="treeitem" aria-selected={focused === item.key} aria-expanded={item.children.length ? isExpanded(item) : undefined}>
            <div
                class="item"
                class:root={depth === 0}
                class:focused={focused === item.key}
                style:padding-inline-start="{depth * 0.9 + 0.25}rem"
                role="button"
                tabindex="0"
                onclick={(e) => activate(item, e)}
                onkeydown={(e) => {
                    if (e.key === "Enter") {
                        activate(item, e);
                    } else if (e.key === "ArrowRight" && item.children.length && !isExpanded(item)) {
                        toggle(item);
                    } else if (e.key === "ArrowLeft" && item.children.length && isExpanded(item)) {
                        toggle(item);
                    }
                }}
                oncontextmenu={(e) => {
                    e.preventDefault();
                    focused = item.key;
                    onContextMenu(item, e);
                }}
            >
                {#if item.children.length}
                    <button
                        type="button"
                        class="twisty"
                        aria-label={isExpanded(item) ? "Collapse" : "Expand"}
                        onclick={(e) => (e.stopPropagation(), toggle(item))}
                    >
                        {isExpanded(item) ? "▾" : "▸"}
                    </button>
                {:else}
                    <span class="twisty"></span>
                {/if}
                <span class="icon" style:color={item.color}>{item.icon}</span>
                <span class="name">{item.name}</span>
            </div>
            {#if item.children.length && isExpanded(item)}
                <ul role="group">
                    {@render tree(item.children, depth + 1)}
                </ul>
            {/if}
        </li>
    {/each}
{/snippet}

<nav class="sidebar" aria-label={tr.browsingSidebar()}>
    <input
        class="filter"
        type="search"
        placeholder={tr.browsingSidebarFilter()}
        bind:value={filter}
        bind:this={filterInput}
    />
    <ul class="tree" role="tree">
        {@render tree(shown, 0)}
    </ul>
</nav>

<style lang="scss">
    .sidebar {
        display: flex;
        flex-direction: column;
        min-height: 0;
        height: 100%;
        background: var(--canvas-elevated);
    }

    .filter {
        margin: 0.4rem;
        padding: 0.25rem 0.5rem;
        border: 1px solid var(--border);
        border-radius: var(--border-radius);
        background: var(--canvas-inset);
        color: var(--fg);
    }

    ul {
        list-style: none;
        margin: 0;
        padding: 0;
    }

    .tree {
        flex: 1;
        overflow: auto;
        padding-bottom: 1rem;
    }

    .item {
        display: flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.15rem 0.4rem;
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
        &:hover {
            background: var(--canvas-inset);
        }
        &.focused {
            background: color-mix(in srgb, var(--border-focus) 25%, transparent);
        }
        &.root {
            font-weight: 600;
            margin-top: 0.2rem;
        }
    }

    .twisty {
        width: 1rem;
        flex: none;
        padding: 0;
        border: 0;
        background: none;
        color: var(--fg-subtle);
        font-size: 0.8em;
    }

    .icon {
        width: 1rem;
        flex: none;
        text-align: center;
        color: var(--fg-subtle);
    }

    .name {
        overflow: hidden;
        text-overflow: ellipsis;
    }
</style>
