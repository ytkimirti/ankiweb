<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's filtered_deck.py
    import {
        Deck_Filtered_SearchTerm,
        Deck_Filtered_SearchTerm_Order as Order,
        type FilteredDeckForUpdate,
    } from "@generated/anki/decks_pb";
    import { SearchNode, SearchNode_CardState, SearchNode_Group_Joiner } from "@generated/anki/search_pb";
    import {
        addOrUpdateFilteredDeck,
        buildSearchString,
        filteredDeckOrderLabels,
        getConfigJson,
        getOrCreateFilteredDeck,
    } from "@generated/backend";
    import * as tr from "@generated/ftl";
    import { onMount } from "svelte";

    import { openBrowser } from "$web/app/actions";
    import { errorMessage, showWarning } from "$web/app/dialogs";
    import { moveToState } from "$web/app/main";
    import { runOp } from "$web/app/run";
    import type { WindowHandle } from "$web/app/windows";

    let {
        win,
        deckId = 0n,
        search = undefined,
        search2 = undefined,
    }: { win: WindowHandle; deckId?: bigint; search?: string; search2?: string } = $props();

    const FSRS_ONLY = new Set([Order.RETRIEVABILITY_ASCENDING, Order.RETRIEVABILITY_DESCENDING]);

    let deck = $state.raw<FilteredDeckForUpdate | null>(null);
    let orderLabels = $state<string[]>([]);
    let fsrs = $state(false);

    let name = $state("");
    let search1 = $state("");
    let limit1 = $state(100);
    let order1 = $state(Order.RANDOM);
    let secondFilter = $state(false);
    let searchTwo = $state("");
    let limit2 = $state(20);
    let order2 = $state(Order.RANDOM);
    let reschedule = $state(true);
    let allowEmpty = $state(false);
    let againSecs = $state(60);
    let hardSecs = $state(600);
    let goodSecs = $state(0);
    let busy = $state(false);
    let searchInput: HTMLInputElement | undefined = $state();

    const orders = $derived(
        orderLabels.map((label, value) => ({ label, value: value as Order })).filter((o) => fsrs || !FSRS_ONLY.has(o.value)),
    );

    function available(order: Order): Order {
        return fsrs || !FSRS_ONLY.has(order) ? order : Order.RANDOM;
    }

    onMount(async () => {
        const out = await runOp(async () => {
            const loaded = await getOrCreateFilteredDeck({ did: deckId });
            const labels = await filteredDeckOrderLabels({});
            const fsrsJson = await getConfigJson({ val: "fsrs" }, { alertOnError: false }).catch(() => null);
            return { loaded, labels: labels.vals, fsrs: fsrsJson ? !!JSON.parse(new TextDecoder().decode(fsrsJson.json)) : false };
        });
        if (!out) {
            win.close();
            return;
        }
        fsrs = out.fsrs;
        orderLabels = out.labels;
        const d = out.loaded;
        deck = d;
        const config = d.config!;
        name = d.name;
        reschedule = config.reschedule;
        allowEmpty = d.allowEmpty;
        againSecs = config.previewAgainSecs;
        hardSecs = config.previewHardSecs;
        goodSecs = config.previewGoodSecs;
        const [term1, term2] = config.searchTerms;
        search1 = term1?.search ?? "";
        limit1 = term1?.limit ?? 100;
        order1 = available(term1?.order ?? Order.RANDOM);
        if (term2) {
            searchTwo = term2.search;
            limit2 = term2.limit;
            order2 = available(term2.order);
            secondFilter = d.id !== 0n;
        }
        if (search !== undefined) {
            search1 = search;
        }
        if (search2 !== undefined) {
            secondFilter = true;
            searchTwo = search2;
        }
        win.setTitle(tr.actionsOptionsFor({ val: d.name }));
        queueMicrotask(() => searchInput?.select());
    });

    function parsable(text: string): SearchNode {
        return new SearchNode({ filter: { case: "parsableText", value: text } });
    }

    function group(joiner: SearchNode_Group_Joiner, nodes: SearchNode[]): SearchNode {
        return new SearchNode({ filter: { case: "group", value: { joiner, nodes } } });
    }

    async function showSearch(text: string): Promise<void> {
        try {
            await buildSearchString(parsable(text), { alertOnError: false });
        } catch (err) {
            await showWarning(errorMessage(err));
            return;
        }
        openBrowser({ search: parsable(text) });
    }

    /** Cards that match the searches but can't be moved (desktop's hint button). */
    function showUnmovable(): void {
        const manual = group(
            SearchNode_Group_Joiner.OR,
            [search1, ...(secondFilter ? [searchTwo] : [])].map(parsable),
        );
        const inFiltered = new SearchNode({ filter: { case: "deck", value: "filtered" } });
        const filteredNode = deck?.id
            ? group(SearchNode_Group_Joiner.AND, [
                inFiltered,
                new SearchNode({
                    filter: { case: "negated", value: new SearchNode({ filter: { case: "deck", value: deck.name } }) },
                }),
            ])
            : inFiltered;
        const implicit = group(SearchNode_Group_Joiner.OR, [
            new SearchNode({ filter: { case: "cardState", value: SearchNode_CardState.SUSPENDED } }),
            new SearchNode({ filter: { case: "cardState", value: SearchNode_CardState.BURIED } }),
            filteredNode,
        ]);
        openBrowser({ search: group(SearchNode_Group_Joiner.AND, [manual, implicit]) });
    }

    async function build(): Promise<void> {
        if (!deck) {
            return;
        }
        const updated = deck.clone();
        updated.name = name;
        updated.allowEmpty = allowEmpty;
        const config = updated.config!;
        config.reschedule = reschedule;
        config.delays = [];
        config.searchTerms = [
            new Deck_Filtered_SearchTerm({ search: search1, limit: limit1, order: order1 }),
            ...(secondFilter ? [new Deck_Filtered_SearchTerm({ search: searchTwo, limit: limit2, order: order2 })] : []),
        ];
        config.previewAgainSecs = againSecs;
        config.previewHardSecs = hardSecs;
        config.previewGoodSecs = goodSecs;
        busy = true;
        const out = await runOp(() => addOrUpdateFilteredDeck(updated));
        busy = false;
        if (out) {
            win.close();
            moveToState("overview");
        }
    }
</script>

<form class="filtered" onsubmit={(e) => (e.preventDefault(), void build())}>
    {#if deck}
        <label class="row">
            <span>{tr.actionsName()}</span>
            <input type="text" bind:value={name} placeholder={deck.name} />
        </label>

        <fieldset>
            <legend>{tr.actionsFilter()}</legend>
            <label class="row">
                <span>{tr.actionsSearch()}</span>
                <input type="text" bind:this={searchInput} bind:value={search1} />
            </label>
            <div class="row">
                <span>{tr.decksLimitTo()}</span>
                <span class="inline">
                    <input type="number" min="1" max="99999" bind:value={limit1} />
                    {tr.decksCardsSelectedBy()}
                    <select bind:value={order1}>
                        {#each orders as o (o.value)}
                            <option value={o.value}>{o.label}</option>
                        {/each}
                    </select>
                </span>
            </div>
            <div class="links">
                <button type="button" class="link" onclick={() => void showSearch(search1)}>{tr.searchViewInBrowser()}</button>
                <button type="button" class="link hint" onclick={showUnmovable}>{tr.decksUnmovableCards()}</button>
            </div>
        </fieldset>

        <label class="check">
            <input type="checkbox" bind:checked={secondFilter} />
            {tr.decksEnableSecondFilter()}
        </label>
        {#if secondFilter}
            <fieldset>
                <legend>{tr.decksFilter2()}</legend>
                <label class="row">
                    <span>{tr.actionsSearch()}</span>
                    <input type="text" bind:value={searchTwo} />
                </label>
                <div class="row">
                    <span>{tr.decksLimitTo()}</span>
                    <span class="inline">
                        <input type="number" min="1" max="99999" bind:value={limit2} />
                        {tr.decksCardsSelectedBy()}
                        <select bind:value={order2}>
                            {#each orders as o (o.value)}
                                <option value={o.value}>{o.label}</option>
                            {/each}
                        </select>
                    </span>
                </div>
                <div class="links">
                    <button type="button" class="link" onclick={() => void showSearch(searchTwo)}>{tr.searchViewInBrowser()}</button>
                </div>
            </fieldset>
        {/if}

        <fieldset>
            <legend>{tr.actionsOptions()}</legend>
            <label class="check">
                <input type="checkbox" bind:checked={reschedule} />
                {tr.decksRescheduleCardsBasedOnMyAnswers()}
            </label>
            {#if !reschedule}
                {#each [[tr.studyingAgain(), "again"], [tr.studyingHard(), "hard"], [tr.studyingGood(), "good"]] as [button, key] (key)}
                    <label class="row">
                        <span>{tr.decksDelayForButton({ button })}</span>
                        <span class="inline">
                            {#if key === "again"}
                                <input type="number" min="0" max="86400" bind:value={againSecs} />
                            {:else if key === "hard"}
                                <input type="number" min="0" max="86400" bind:value={hardSecs} />
                            {:else}
                                <input type="number" min="0" max="86400" bind:value={goodSecs} />
                            {/if}
                            {tr.schedulingSeconds()}
                        </span>
                    </label>
                {/each}
                <p class="note">{tr.decksZeroMinutesHint()}</p>
            {/if}
            <label class="check">
                <input type="checkbox" bind:checked={allowEmpty} />
                {tr.decksCreateEvenIfEmpty()}
            </label>
        </fieldset>
    {:else}
        <p>…</p>
    {/if}
    <footer>
        <span class="spacer"></span>
        <button type="button" class="btn btn-secondary" onclick={() => win.close()}>{tr.actionsCancel()}</button>
        <button type="submit" class="btn btn-primary" disabled={!deck || busy}>
            {deck?.id ? tr.actionsRebuild() : tr.decksBuild()}
        </button>
    </footer>
</form>

<style>
    .filtered {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 1rem;
        height: 100%;
        overflow: auto;
    }
    fieldset {
        border: 1px solid var(--border-subtle);
        border-radius: var(--border-radius);
        padding: 0.5rem 0.75rem 0.75rem;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }
    legend {
        font-size: 0.95rem;
        font-weight: 600;
        padding: 0 0.25rem;
        width: auto;
        float: none;
        margin: 0;
    }
    .row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        > span:first-child {
            min-width: 6rem;
        }
        > input[type="text"] {
            flex: 1;
        }
    }
    .inline {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.4rem;
    }
    input[type="number"] {
        width: 5.5rem;
    }
    .check {
        display: flex;
        gap: 0.5rem;
        align-items: center;
    }
    .links {
        display: flex;
        gap: 1rem;
    }
    .link {
        border: 0;
        padding: 0;
        background: none;
        color: var(--fg-link);
        &:hover {
            text-decoration: underline;
        }
        &.hint {
            color: var(--fg-disabled);
        }
    }
    .note {
        margin: 0;
        font-size: 0.9em;
        color: var(--fg-subtle);
    }
    footer {
        display: flex;
        gap: 0.5rem;
    }
    .spacer {
        flex: 1;
    }
</style>
