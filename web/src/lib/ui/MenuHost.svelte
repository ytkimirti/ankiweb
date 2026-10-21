<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    import { tick } from "svelte";

    import { closeMenus, openMenus, type MenuEntry, type MenuItem } from "$web/app/menus";
    import { shortcutLabel } from "$web/app/shortcuts";

    // open submenus, by nesting level
    let path = $state<{ items: MenuEntry[]; x: number; y: number }[]>([]);
    let rootEl = $state<HTMLElement | null>(null);
    let pos = $state({ x: 0, y: 0 });

    const menu = $derived($openMenus[0]);

    $effect(() => {
        if (menu) {
            path = [];
            pos = { x: menu.x, y: menu.y };
            void tick().then(() => {
                if (!rootEl) {
                    return;
                }
                const rect = rootEl.getBoundingClientRect();
                pos = {
                    x: Math.max(4, Math.min(menu.x, innerWidth - rect.width - 4)),
                    y: menu.y + rect.height > innerHeight - 4 ? Math.max(4, innerHeight - rect.height - 4) : menu.y,
                };
                rootEl.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
            });
        }
    });

    function activate(item: MenuItem, level: number, event: MouseEvent | KeyboardEvent): void {
        if (item.disabled) {
            return;
        }
        if (item.submenu) {
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
            path = [...path.slice(0, level), {
                items: item.submenu,
                x: rect.right + 200 > innerWidth ? Math.max(4, rect.left - 200) : rect.right,
                y: rect.top,
            }];
            return;
        }
        closeMenus();
        item.action?.();
    }

    function onKeydown(event: KeyboardEvent): void {
        if (!menu) {
            return;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (path.length) {
                path = path.slice(0, -1);
            } else {
                closeMenus();
            }
            return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const container = (document.activeElement as HTMLElement)?.closest(".menu") ?? rootEl;
            const buttons = [...(container?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length];
            next?.focus();
        }
    }
</script>

<svelte:window onkeydowncapture={onKeydown} />

{#snippet entries(items: MenuEntry[], level: number)}
    {#each items as item, i (i)}
        {#if item === null}
            <div class="separator" role="separator"></div>
        {:else}
            <button
                type="button"
                class="menu-item"
                role="menuitem"
                disabled={item.disabled}
                onclick={(e) => activate(item, level, e)}
                onmouseenter={(e) => {
                    if (item.submenu) {
                        activate(item, level, e);
                    } else if (path.length > level) {
                        path = path.slice(0, level);
                    }
                }}
            >
                <span class="check">{item.checked ? "✓" : ""}</span>
                <span class="label">{item.label}</span>
                {#if item.submenu}
                    <span class="shortcut">▸</span>
                {:else if item.shortcut}
                    <span class="shortcut">{shortcutLabel(item.shortcut)}</span>
                {/if}
            </button>
        {/if}
    {/each}
{/snippet}

{#if menu}
    <div
        class="menu-backdrop"
        role="presentation"
        onclick={closeMenus}
        oncontextmenu={(e) => {
            e.preventDefault();
            closeMenus();
        }}
    ></div>
    <div class="menu" role="menu" bind:this={rootEl} style:left="{pos.x}px" style:top="{pos.y}px">
        {@render entries(menu.items, 0)}
    </div>
    {#each path as sub, level (level)}
        <div class="menu" role="menu" style:left="{sub.x}px" style:top="{Math.min(sub.y, innerHeight - 40)}px">
            {@render entries(sub.items, level + 1)}
        </div>
    {/each}
{/if}

<style lang="scss">
    .menu-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1200;
    }

    .menu {
        position: fixed;
        z-index: 1201;
        min-width: 12rem;
        max-width: calc(100vw - 8px);
        max-height: calc(100vh - 8px);
        overflow-y: auto;
        background: var(--canvas-elevated);
        color: var(--fg);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
        padding: 4px;
        display: flex;
        flex-direction: column;
    }

    .menu-item {
        all: unset;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.35rem 0.6rem 0.35rem 0.25rem;
        border-radius: 4px;
        cursor: pointer;
        white-space: nowrap;
        &:hover,
        &:focus-visible {
            background: var(--button-primary-bg, #3b82f6);
            color: white;
        }
        &:disabled {
            opacity: 0.45;
            cursor: default;
            background: none;
            color: inherit;
        }
    }

    .check {
        width: 1rem;
        text-align: center;
    }

    .label {
        flex: 1;
    }

    .shortcut {
        opacity: 0.6;
        font-size: 0.85em;
        margin-inline-start: 1.5rem;
    }

    .separator {
        height: 1px;
        background: var(--border-subtle);
        margin: 4px 0;
    }
</style>
