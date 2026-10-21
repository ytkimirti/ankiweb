<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's emptycards.py
    import type { EmptyCardsReport } from "@generated/anki/card_rendering_pb";
    import { SearchNode } from "@generated/anki/search_pb";
    import { removeCards } from "@generated/backend";
    import * as tr from "@generated/ftl";

    import { openBrowser } from "$web/app/actions";
    import { tooltip } from "$web/app/dialogs";
    import { escapeHtml, sanitizeHtml } from "$web/app/html";
    import { reset } from "$web/app/main";
    import { runOp } from "$web/app/run";
    import type { WindowHandle } from "$web/app/windows";

    let { win, report }: { win: WindowHandle; report: EmptyCardsReport } = $props();

    let keepNotes = $state(true);
    let busy = $state(false);

    const html = $derived(
        sanitizeHtml(report.report).replace(
            /\[anki:nid:(\d+)\]/g,
            (_, nid) => `<a href="#" data-nid="${escapeHtml(nid)}">${escapeHtml(nid)}</a>: `,
        ),
    );

    function onClick(event: MouseEvent): void {
        const link = (event.target as Element).closest("a[data-nid]") as HTMLElement | null;
        if (link) {
            event.preventDefault();
            openBrowser({ search: new SearchNode({ filter: { case: "nid", value: BigInt(link.dataset.nid!) } }) });
        }
    }

    async function remove(): Promise<void> {
        busy = true;
        const cardIds: bigint[] = [];
        for (const note of report.notes) {
            // keeping a note means leaving its first card
            cardIds.push(...(keepNotes && note.willDeleteNote ? note.cardIds.slice(1) : note.cardIds));
        }
        const out = await runOp(() => removeCards({ cardIds }), { progress: true });
        busy = false;
        win.close();
        if (out) {
            tooltip(tr.emptyCardsDeletedCount({ cards: out.count }));
            reset();
        }
    }
</script>

<div class="empty-cards">
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="report" onclick={onClick}>{@html html}</div>
    <footer>
        <label>
            <input type="checkbox" bind:checked={keepNotes} />
            {tr.emptyCardsPreserveNotesCheckbox()}
        </label>
        <span class="spacer"></span>
        <button type="button" class="btn btn-secondary" onclick={() => win.close()}>{tr.actionsClose()}</button>
        <button type="button" class="btn btn-danger" disabled={busy} onclick={() => void remove()}>
            {tr.emptyCardsDeleteButton()}
        </button>
    </footer>
</div>

<style>
    .empty-cards {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
    }
    .report {
        flex: 1;
        overflow: auto;
        padding: 1rem;
        white-space: pre-wrap;
        :global(.allempty) {
            color: red;
        }
    }
    footer {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 1rem;
        border-top: 1px solid var(--border-subtle);
    }
    .spacer {
        flex: 1;
    }
</style>
