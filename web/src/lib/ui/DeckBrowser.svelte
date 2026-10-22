<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's deckbrowser.py
    import { ConfigKey_Bool } from "@generated/anki/config_pb";
    import type { DeckTreeNode } from "@generated/anki/decks_pb";
    import { getConfigBool, getCurrentDeck, setConfigBool, studiedToday } from "@generated/backend";
    import * as tr from "@generated/ftl";
    import { onDestroy, onMount } from "svelte";

    import { openDeckOptions, onExport, onImport } from "$web/app/actions";
    import {
        addDeckDialog,
        dueTree,
        removeDecksWithTooltip,
        renameDeckDialog,
        reparent,
        selectDeck,
        setCollapsed,
    } from "$web/app/decks";
    import { showInfo } from "$web/app/dialogs";
    import { moveToState, resetCounter } from "$web/app/main";
    import { popupMenu, type MenuEntry } from "$web/app/menus";
    import { onOpChanges } from "$web/app/ops";
    import { runOp } from "$web/app/run";
    import { setStateShortcuts } from "$web/app/shortcuts";
    import { avPlayer } from "$web/app/sound";
    import { hooks, type BarLink } from "$web/plugins/hooks";

    import BottomBar from "./BottomBar.svelte";
    import gearsUrl from "./gears.svg?url";

    let tree = $state.raw<DeckTreeNode | null>(null);
    let currentDeckId = $state<bigint>(0n);
    let studied = $state("");
    let upgradeRequired = $state(false);
    let dragSource: bigint | null = null;
    let dragTarget = $state<bigint | null>(null);
    let pluginContent = $state<HTMLElement>();

    interface Row {
        node: DeckTreeNode;
    }

    function flatten(node: DeckTreeNode, out: Row[] = []): Row[] {
        for (const child of node.children) {
            out.push({ node: child });
            if (!child.collapsed) {
                flatten(child, out);
            }
        }
        return out;
    }

    const rows = $derived(tree ? flatten(tree) : []);

    async function refresh(): Promise<void> {
        const data = await runOp(async () => ({
            tree: await dueTree(),
            current: (await getCurrentDeck({})).id,
            studied: (await studiedToday({})).val,
            v3: (await getConfigBool({ key: ConfigKey_Bool.SCHED_2021 })).val,
        }));
        if (data) {
            tree = data.tree;
            currentDeckId = data.current;
            studied = data.studied;
            upgradeRequired = !data.v3;
            renderPluginContent();
            hooks.deckBrowserDidRender.run();
        }
    }

    /** Desktop's deck_browser_will_render_content: plugins add to the area below the decks. */
    function renderPluginContent(): void {
        if (pluginContent) {
            pluginContent.replaceChildren();
            hooks.deckBrowserWillRenderContent.run(pluginContent);
        }
    }

    $effect(() => {
        // the element exists from the first render with a tree
        if (pluginContent) {
            renderPluginContent();
        }
    });

    async function open(deckId: bigint): Promise<void> {
        if (await selectDeck(deckId)) {
            moveToState("overview");
        }
    }

    async function collapse(node: DeckTreeNode): Promise<void> {
        node.collapsed = !node.collapsed;
        // protobuf messages are not deeply reactive
        tree = tree!.clone();
        await setCollapsed(node.deckId, node.collapsed);
    }

    function showOptions(node: DeckTreeNode, event: MouseEvent): void {
        const menu: MenuEntry[] = [
            { label: tr.actionsRename(), action: () => renameDeckDialog(node.deckId) },
            { label: tr.actionsOptions(), action: () => openDeckOptions(node.deckId) },
            { label: tr.actionsExport(), action: () => onExport({ deckId: node.deckId }) },
            { label: tr.actionsDelete(), action: () => removeDecksWithTooltip([node.deckId], node.name) },
        ];
        hooks.deckBrowserWillShowOptionsMenu.run(menu, node.deckId);
        popupMenu(menu, { x: event.clientX, y: event.clientY });
    }

    async function confirmUpgrade(): Promise<void> {
        await runOp(() => setConfigBool({ key: ConfigKey_Bool.SCHED_2021, value: true, undoable: false }));
        await showInfo(tr.schedulingUpdateDone());
        await refresh();
    }

    function onCommand(cmd: string): void {
        if (cmd === "shared") {
            window.open("https://ankiweb.net/shared/decks", "_blank", "noopener");
        } else if (cmd === "create") {
            void createDeck();
        } else if (cmd === "import") {
            void onImport();
        }
    }

    async function createDeck(): Promise<void> {
        const current = await runOp(() => getCurrentDeck({}));
        await addDeckDialog(current?.name ?? "");
    }

    const links: BarLink[] = [
        ["", "shared", tr.decksGetShared()],
        ["", "create", tr.decksCreateDeck()],
        ["Ctrl+Shift+I", "import", tr.decksImportFile()],
    ];

    // drag and drop reparenting
    function onDragStart(event: DragEvent, deckId: bigint): void {
        dragSource = deckId;
        event.dataTransfer?.setData("text/plain", String(deckId));
    }

    function onDragOver(event: DragEvent, deckId: bigint): void {
        if (dragSource !== null) {
            event.preventDefault();
            dragTarget = deckId;
        }
    }

    function onDrop(event: DragEvent, deckId: bigint): void {
        event.preventDefault();
        const source = dragSource;
        dragSource = null;
        dragTarget = null;
        if (source !== null && source !== deckId) {
            void reparent([source], deckId);
        }
    }

    function counts(node: DeckTreeNode): { klass: string; count: number }[] {
        return [
            { klass: "new-count", count: node.newCount },
            { klass: "learn-count", count: node.learnCount },
            { klass: "review-count", count: node.reviewCount },
        ];
    }

    const unsubscribeOps = onOpChanges((changes) => {
        if (changes.studyQueues || changes.deck) {
            void refresh();
        }
    });
    const unsubscribeReset = resetCounter.subscribe(() => void refresh());
    onDestroy(() => {
        unsubscribeOps();
        unsubscribeReset();
    });

    onMount(() => {
        avPlayer.stopAndClearQueue();
        setStateShortcuts([["Ctrl+Shift+I", () => void onImport()]]);
    });
</script>

<div class="deck-browser">
    <div class="content">
        {#if upgradeRequired}
            <div class="callout">
                <div>{tr.schedulingUpdateRequired().replace("V2", "v3")}</div>
                <div>
                    <button type="button" onclick={confirmUpgrade}>{tr.schedulingUpdateButton()}</button>
                    <button
                        type="button"
                        onclick={() => window.open("https://docs.ankiweb.net/faqs/the-2021-scheduler", "_blank", "noopener")}
                    >
                        {tr.schedulingUpdateMoreInfoButton()}
                    </button>
                </div>
            </div>
        {/if}
        {#if tree}
            <table class="decks" cellspacing="0" cellpadding="3">
                <thead>
                    <tr>
                        <th colspan="5" class="deck-header">{tr.decksDeck()}</th>
                        <th class="count">{tr.actionsNew()}</th>
                        <th class="count">{tr.decksLearnHeader()}</th>
                        <th class="count">{tr.decksReviewHeader()}</th>
                        <th class="optscol"></th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        class="top-level-drag-row"
                        class:drag-hover={dragTarget === 0n}
                        ondragover={(e) => onDragOver(e, 0n)}
                        ondrop={(e) => onDrop(e, 0n)}
                    >
                        <td colspan="9">&nbsp;</td>
                    </tr>
                    {#each rows as { node } (node.deckId)}
                        <tr
                            class="deck"
                            class:current={node.deckId === currentDeckId}
                            class:drag-hover={dragTarget === node.deckId}
                            draggable="true"
                            ondragstart={(e) => onDragStart(e, node.deckId)}
                            ondragover={(e) => onDragOver(e, node.deckId)}
                            ondragleave={() => (dragTarget = null)}
                            ondrop={(e) => onDrop(e, node.deckId)}
                            onclick={(e) => {
                                if (e.shiftKey) {
                                    void selectDeck(node.deckId).then(refresh);
                                }
                            }}
                        >
                            <td class="decktd" colspan="5">
                                <span class="indent" style:width="{(node.level - 1) * 1.5}em"></span>
                                {#if node.children.length}
                                    <button
                                        type="button"
                                        class="collapse"
                                        aria-expanded={!node.collapsed}
                                        onclick={() => collapse(node)}
                                    >
                                        {node.collapsed ? "+" : "−"}
                                    </button>
                                {:else}
                                    <span class="collapse"></span>
                                {/if}
                                <a
                                    class="deck"
                                    class:filtered={node.filtered}
                                    href="#deck-{node.deckId}"
                                    draggable="false"
                                    onclick={(e) => {
                                        e.preventDefault();
                                        if (!e.shiftKey) {
                                            void open(node.deckId);
                                        }
                                    }}
                                >
                                    {node.name}
                                </a>
                            </td>
                            {#each counts(node) as { klass, count }}
                                <td class="count-cell">
                                    <span class={count ? klass : "zero-count"}>{count}</span>
                                </td>
                            {/each}
                            <td class="opts">
                                <button
                                    type="button"
                                    class="gears-button"
                                    aria-label={tr.actionsOptions()}
                                    onclick={(e) => showOptions(node, e)}
                                >
                                    <img src={gearsUrl} class="gears" alt="" />
                                </button>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
            <div id="studiedToday"><span>{studied}</span></div>
        {/if}
        <div class="plugin-content" bind:this={pluginContent}></div>
    </div>
    <BottomBar {links} {onCommand} />
</div>

<style lang="scss">
    .deck-browser {
        display: flex;
        flex-direction: column;
        height: 100%;
    }

    .content {
        flex: 1;
        overflow: auto;
        padding: 2em 1em 1em;
        display: flex;
        flex-direction: column;
        align-items: center;
        user-select: none;
    }

    table.decks {
        padding: 1rem;
        border: 1px solid var(--border-subtle);
        border-radius: var(--border-radius-medium, 8px);
        background: var(--canvas-glass, var(--canvas-elevated));
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
        border-collapse: separate;
        max-width: 100%;
    }

    th {
        border-bottom: 1px solid var(--border-subtle);
        padding-bottom: 5px;
        font-weight: bold;
    }

    .deck-header {
        text-align: start;
    }

    tr.deck td {
        padding: 4px 12px;
    }

    td {
        white-space: nowrap;
    }

    tr.drag-hover td {
        border-bottom: 1px solid var(--border);
    }

    tr.top-level-drag-row td {
        border-bottom: 1px solid transparent;
    }

    .current td,
    tr.deck:hover td {
        background: var(--border-subtle);
        &:first-child {
            border-start-start-radius: var(--border-radius-medium, 8px);
            border-end-start-radius: var(--border-radius-medium, 8px);
        }
        &:last-child {
            border-start-end-radius: var(--border-radius-medium, 8px);
            border-end-end-radius: var(--border-radius-medium, 8px);
        }
        .gears {
            visibility: visible;
        }
    }

    .decktd {
        min-width: 15em;
        max-width: calc(100vw - 300px);
        overflow: hidden;
    }

    .indent {
        display: inline-block;
    }

    a.deck {
        color: var(--fg);
        text-decoration: none;
        min-width: 5em;
        display: inline-block;
        &:hover {
            text-decoration: underline;
        }
    }

    .filtered {
        color: var(--fg-link) !important;
    }

    .collapse {
        all: unset;
        color: var(--fg);
        display: inline-block;
        width: 1em;
        cursor: pointer;
    }

    .count,
    .count-cell {
        min-width: 4em;
        text-align: end;
    }

    .optscol {
        width: 2em;
    }

    .opts {
        text-align: center;
    }

    .gears-button {
        all: unset;
        cursor: pointer;
    }

    .gears {
        width: 1em;
        height: 1em;
        opacity: 0.5;
        padding-top: 0.2em;
        visibility: hidden;
    }

    @media (hover: none) {
        .gears {
            visibility: visible;
        }
        .decktd {
            min-width: 8em;
            max-width: 55vw;
        }
        tr.deck td {
            padding: 8px 6px;
        }
        .count,
        .count-cell {
            min-width: 2.5em;
        }
    }

    :global(.night-mode) .gears {
        filter: invert(180);
    }

    .callout {
        background: var(--border);
        padding: 1em;
        margin: 1em;
        div {
            margin: 1em;
        }
    }

    #studiedToday {
        margin: 2em 0;
        text-align: center;
    }

    .plugin-content {
        max-width: 100%;
    }
</style>
