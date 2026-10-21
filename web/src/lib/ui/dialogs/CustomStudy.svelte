<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's customstudy.py and taglimit.py
    import {
        CustomStudyRequest,
        CustomStudyRequest_Cram,
        CustomStudyRequest_Cram_CramKind,
        type CustomStudyDefaultsResponse,
    } from "@generated/anki/scheduler_pb";
    import { buildSearchString, customStudy, customStudyDefaults, getDeck, searchCards } from "@generated/backend";
    import * as tr from "@generated/ftl";
    import { onMount } from "svelte";

    import { moveToState } from "$web/app/main";
    import { runOp } from "$web/app/run";
    import type { WindowHandle } from "$web/app/windows";

    let { win, deckId }: { win: WindowHandle; deckId: bigint } = $props();

    const DYN_MAX_SIZE = 99999;

    type Mode = "new" | "review" | "forgot" | "ahead" | "preview" | "cram";

    let defaults = $state.raw<CustomStudyDefaultsResponse | null>(null);
    let cardCount = $state(0);
    let mode = $state<Mode>("new");
    let value = $state(1);
    let cramKind = $state(CustomStudyRequest_Cram_CramKind.NEW);
    let step = $state<"main" | "tags">("main");
    let includeTags = $state<Set<string>>(new Set());
    let excludeTags = $state<Set<string>>(new Set());
    let requireTags = $state(false);
    let busy = $state(false);

    onMount(async () => {
        const out = await runOp(async () => {
            const d = await customStudyDefaults({ deckId });
            const deck = await getDeck({ did: deckId });
            const search = await buildSearchString({ filter: { case: "deck", value: deck.name } });
            const cards = await searchCards({ search: search.val, order: { value: { case: "none", value: {} } } });
            return { d, count: cards.ids.length };
        });
        if (!out) {
            win.close();
            return;
        }
        defaults = out.d;
        cardCount = out.count;
        includeTags = new Set(out.d.tags.filter((t) => t.include).map((t) => t.name));
        excludeTags = new Set(out.d.tags.filter((t) => t.exclude).map((t) => t.name));
        requireTags = includeTags.size > 0;
        selectMode("new");
    });

    function selectMode(next: Mode): void {
        mode = next;
        value = next === "new"
            ? defaults?.extendNew ?? 0
            : next === "review"
            ? defaults?.extendReview ?? 0
            : next === "cram"
            ? 100
            : 1;
    }

    const limits = $derived.by(() => {
        if (mode === "new" || mode === "review") {
            return { min: -DYN_MAX_SIZE, max: DYN_MAX_SIZE };
        }
        return { min: 1, max: mode === "forgot" ? 30 : DYN_MAX_SIZE };
    });

    function withChildren(parent: number, children: number): string {
        return children ? `${parent} ${tr.customStudyAvailableChildCount({ count: children })}` : String(parent);
    }

    const title = $derived.by(() => {
        if (!defaults) {
            return "";
        }
        if (mode === "new") {
            return tr.customStudyAvailableNewCards2({
                countString: withChildren(defaults.availableNew, defaults.availableNewInChildren),
            });
        }
        if (mode === "review") {
            return tr.customStudyAvailableReviewCards2({
                countString: withChildren(defaults.availableReview, defaults.availableReviewInChildren),
            });
        }
        return "";
    });

    const before = $derived(
        {
            new: tr.customStudyIncreaseTodaysNewCardLimitBy(),
            review: tr.customStudyIncreaseTodaysReviewLimitBy(),
            forgot: tr.customStudyReviewCardsForgottenInLast(),
            ahead: tr.customStudyReviewAheadBy(),
            preview: tr.customStudyPreviewNewCardsAddedInThe(),
            cram: tr.customStudySelect(),
        }[mode],
    );

    const after = $derived.by(() => {
        const count = value;
        if (mode === "new" || mode === "review") {
            return tr.customStudyCards({ count });
        }
        if (mode === "cram") {
            return tr.customStudyCardsFromTheDeck({ count });
        }
        return tr.customStudyDays({ count });
    });

    const okEnabled = $derived(mode === "new" || mode === "review" || cardCount > 0);

    const modes: [Mode, string][] = [
        ["new", tr.customStudyIncreaseTodaysNewCardLimit()],
        ["review", tr.customStudyIncreaseTodaysReviewCardLimit()],
        ["forgot", tr.customStudyReviewForgottenCards()],
        ["ahead", tr.customStudyReviewAhead()],
        ["preview", tr.customStudyPreviewNewCards()],
        ["cram", tr.customStudyStudyByCardStateOrTag()],
    ];

    const cramKinds: [CustomStudyRequest_Cram_CramKind, string][] = [
        [CustomStudyRequest_Cram_CramKind.NEW, tr.customStudyNewCardsOnly()],
        [CustomStudyRequest_Cram_CramKind.DUE, tr.customStudyDueCardsOnly()],
        [CustomStudyRequest_Cram_CramKind.REVIEW, tr.customStudyAllReviewCardsInRandomOrder()],
        [CustomStudyRequest_Cram_CramKind.ALL, tr.customStudyAllCardsInRandomOrderDont()],
    ];

    function clamp(n: number): number {
        return Math.min(limits.max, Math.max(limits.min, Math.trunc(n) || 0));
    }

    function request(): CustomStudyRequest {
        const n = clamp(value);
        const req = new CustomStudyRequest({ deckId });
        switch (mode) {
            case "new":
                req.value = { case: "newLimitDelta", value: n };
                break;
            case "review":
                req.value = { case: "reviewLimitDelta", value: n };
                break;
            case "forgot":
                req.value = { case: "forgotDays", value: n };
                break;
            case "ahead":
                req.value = { case: "reviewAheadDays", value: n };
                break;
            case "preview":
                req.value = { case: "previewDays", value: n };
                break;
            case "cram":
                req.value = {
                    case: "cram",
                    value: new CustomStudyRequest_Cram({
                        kind: cramKind,
                        cardLimit: n,
                        tagsToInclude: requireTags ? [...includeTags] : [],
                        tagsToExclude: [...excludeTags],
                    }),
                };
                break;
        }
        return req;
    }

    async function create(): Promise<void> {
        busy = true;
        // stays open on failure, which is usually an empty search the user can fix
        const ok = await runOp(() => customStudy(request()));
        busy = false;
        if (ok) {
            win.close();
            moveToState("overview");
        }
    }

    function accept(): void {
        if (mode === "cram" && step === "main") {
            step = "tags";
            return;
        }
        void create();
    }

    function toggle(set: Set<string>, tag: string): Set<string> {
        const next = new Set(set);
        if (next.has(tag)) {
            next.delete(tag);
        } else {
            next.add(tag);
        }
        return next;
    }
</script>

<form class="custom-study" onsubmit={(e) => (e.preventDefault(), accept())}>
    {#if !defaults}
        <p class="loading">…</p>
    {:else if step === "main"}
        <fieldset>
            {#each modes as [id, label] (id)}
                <label class="radio">
                    <input type="radio" name="mode" checked={mode === id} onchange={() => selectMode(id)} />
                    {label}
                </label>
            {/each}
        </fieldset>
        <div class="options">
            {#if title}
                <p class="title">{title}</p>
            {/if}
            <label class="spin">
                <span>{before}</span>
                <input type="number" min={limits.min} max={limits.max} bind:value onblur={() => (value = clamp(value))} />
                <span>{after}</span>
            </label>
            {#if mode === "cram"}
                <div class="cram-kinds" role="radiogroup" aria-label={tr.customStudySelect()}>
                    {#each cramKinds as [kind, label] (kind)}
                        <label class="radio">
                            <input type="radio" name="cram" checked={cramKind === kind} onchange={() => (cramKind = kind)} />
                            {label}
                        </label>
                    {/each}
                </div>
            {/if}
        </div>
    {:else}
        <div class="tags">
            <section>
                <label class="radio">
                    <input type="checkbox" bind:checked={requireTags} />
                    {tr.customStudyRequireOneOrMoreOfThese()}
                </label>
                <ul class:disabled={!requireTags}>
                    {#each defaults.tags as tag (tag.name)}
                        <li>
                            <label>
                                <input
                                    type="checkbox"
                                    disabled={!requireTags}
                                    checked={includeTags.has(tag.name)}
                                    onchange={() => (includeTags = toggle(includeTags, tag.name))}
                                />
                                {tag.name}
                            </label>
                        </li>
                    {/each}
                </ul>
            </section>
            <section>
                <p>{tr.customStudySelectTagsToExclude()}</p>
                <ul>
                    {#each defaults.tags as tag (tag.name)}
                        <li>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={excludeTags.has(tag.name)}
                                    onchange={() => (excludeTags = toggle(excludeTags, tag.name))}
                                />
                                {tag.name}
                            </label>
                        </li>
                    {/each}
                </ul>
            </section>
        </div>
    {/if}
    <footer>
        {#if step === "tags"}
            <button type="button" class="btn btn-secondary" onclick={() => (step = "main")}>‹</button>
        {/if}
        <span class="spacer"></span>
        <button type="button" class="btn btn-secondary" onclick={() => win.close()}>{tr.actionsCancel()}</button>
        <button type="submit" class="btn btn-primary" disabled={!defaults || !okEnabled || busy}>
            {mode === "cram" && step === "main" ? tr.customStudyChooseTags() : tr.customStudyOk()}
        </button>
    </footer>
</form>

<style>
    .custom-study {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 1rem;
        max-height: 100%;
        overflow: auto;
    }
    fieldset {
        border: 0;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
    }
    .radio {
        display: flex;
        gap: 0.5rem;
        align-items: center;
    }
    .options {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.75rem;
        border: 1px solid var(--border-subtle);
        border-radius: var(--border-radius);
    }
    .title {
        margin: 0;
        font-weight: 600;
    }
    .spin {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        input {
            width: 6rem;
        }
    }
    .cram-kinds {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }
    .tags {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1rem;
        p {
            margin: 0;
        }
    }
    ul {
        list-style: none;
        margin: 0.4rem 0 0;
        padding: 0.25rem;
        max-height: 16rem;
        overflow: auto;
        border: 1px solid var(--border-subtle);
        border-radius: var(--border-radius);
        &.disabled {
            opacity: 0.5;
        }
    }
    footer {
        display: flex;
        gap: 0.5rem;
    }
    .spacer {
        flex: 1;
    }
    @media (max-width: 480px) {
        .tags {
            grid-template-columns: 1fr;
        }
    }
</style>
