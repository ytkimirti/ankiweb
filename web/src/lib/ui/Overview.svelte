<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's overview.py
    import type { Deck } from "@generated/anki/decks_pb";
    import { UnburyDeckRequest_Mode } from "@generated/anki/scheduler_pb";
    import {
        congratsInfo,
        emptyFilteredDeck,
        getCurrentDeck,
        getQueuedCards,
        rebuildFilteredDeck,
        renderMarkdown,
        unburyDeck,
        updateDeck,
    } from "@generated/backend";
    import * as tr from "@generated/ftl";
    import { onDestroy, onMount, untrack } from "svelte";

    import { onCustomStudy, onFilteredDeck, openDeckOptions } from "$web/app/actions";
    import { dueTree, findDeckInTree } from "$web/app/decks";
    import { chooseFrom, openDialog } from "$web/app/dialogs";
    import { attachFrame } from "$web/app/host";
    import { sanitizeHtml } from "$web/app/html";
    import { mainState, moveToState, resetCounter } from "$web/app/main";
    import { onOpChanges } from "$web/app/ops";
    import { startTimebox } from "$web/app/reviewer";
    import { runOp } from "$web/app/run";
    import { setStateShortcuts } from "$web/app/shortcuts";
    import { avPlayer } from "$web/app/sound";
    import { hooks, type BarLink } from "$web/plugins/hooks";

    import BottomBar from "./BottomBar.svelte";

    interface OverviewData {
        deck: Deck;
        finished: boolean;
        counts: [number, number, number];
        buried: [number, number, number];
        description: string;
        haveBuried: boolean;
    }

    let data = $state.raw<OverviewData | null>(null);
    let congratsFrame: HTMLIFrameElement | null = $state(null);
    let pluginContent = $state<HTMLElement>();

    const isFiltered = $derived(data?.deck.kind.case === "filtered");

    async function load(): Promise<OverviewData | undefined> {
        return runOp(async () => {
            const deck = await getCurrentDeck({});
            const queued = await getQueuedCards({ fetchLimit: 1, intradayLearningOnly: false });
            const counts: [number, number, number] = [queued.newCount, queued.learningCount, queued.reviewCount];
            const node = findDeckInTree(await dueTree(), deck.id);
            const buried: [number, number, number] = node
                ? [node.newCount - counts[0], node.learnCount - counts[1], node.reviewCount - counts[2]]
                : [0, 0, 0];
            const info = await congratsInfo({});
            let description = "";
            if (deck.kind.case === "filtered") {
                description = [
                    tr.studyingThisIsASpecialDeckFor(),
                    tr.studyingCardsWillBeAutomaticallyReturnedTo(),
                    tr.studyingDeletingThisDeckFromTheDeck(),
                ].join(" ");
            } else if (deck.kind.case === "normal") {
                description = deck.kind.value.description;
                if (deck.kind.value.markdownDescription) {
                    description = (await renderMarkdown({ markdown: description, sanitize: true })).val;
                }
            }
            return {
                deck,
                finished: queued.cards.length === 0,
                counts,
                buried,
                description,
                haveBuried: info.haveSchedBuried || info.haveUserBuried,
            };
        });
    }

    async function refresh(): Promise<void> {
        const loaded = await load();
        if (loaded) {
            data = loaded;
            renderPluginContent();
            hooks.overviewDidRefresh.run();
        }
    }

    /** Desktop's overview_will_render_content: plugins add to the area below the study table. */
    function renderPluginContent(): void {
        if (pluginContent && data) {
            pluginContent.replaceChildren();
            hooks.overviewWillRenderContent.run(pluginContent, data.deck.id);
        }
    }

    $effect(() => {
        // the element is created once data has loaded, after refresh() ran;
        // later refreshes render it themselves
        if (pluginContent) {
            untrack(renderPluginContent);
        }
    });

    function study(): void {
        startTimebox();
        moveToState("review");
    }

    async function rebuild(): Promise<void> {
        if (data && isFiltered) {
            await runOp(() => rebuildFilteredDeck({ did: data!.deck.id }), { progress: true });
        }
    }

    async function empty(): Promise<void> {
        if (data && isFiltered) {
            await runOp(() => emptyFilteredDeck({ did: data!.deck.id }));
        }
    }

    async function unbury(): Promise<void> {
        if (!data) {
            return;
        }
        let mode = UnburyDeckRequest_Mode.ALL;
        const info = await runOp(() => congratsInfo({}));
        if (info?.haveSchedBuried && info.haveUserBuried) {
            const choice = await chooseFrom(tr.studyingWhatWouldYouLikeToUnbury(), [
                tr.studyingManuallyBuriedCards(),
                tr.studyingBuriedSiblings(),
                tr.studyingAllBuriedCards(),
            ]);
            if (choice === null) {
                return;
            }
            mode = [UnburyDeckRequest_Mode.USER_ONLY, UnburyDeckRequest_Mode.SCHED_ONLY, UnburyDeckRequest_Mode.ALL][choice];
        }
        await runOp(() => unburyDeck({ deckId: data!.deck.id, mode }));
    }

    async function editDescription(): Promise<void> {
        const deck = data?.deck.clone();
        if (!deck || deck.kind.case !== "normal") {
            return;
        }
        const normal = deck.kind.value;
        const result = await openDialog({
            title: tr.schedulingDescription(),
            text: "",
            input: { value: normal.description, multiline: true },
            checks: [{ label: tr.deckConfigDescriptionNewHandling2(), checked: normal.markdownDescription }],
            buttons: [
                { label: tr.actionsCancel(), value: "cancel" },
                { label: tr.actionsSave(), value: "ok", primary: true },
            ],
        });
        if (result.button !== "ok") {
            return;
        }
        normal.description = result.input ?? "";
        normal.markdownDescription = !!result.checks?.[0];
        await runOp(() => updateDeck(deck));
    }

    function customStudy(): void {
        if (data && !isFiltered) {
            void onCustomStudy(data.deck.id);
        }
    }

    function onCommand(cmd: string): void {
        switch (cmd) {
            case "study":
                study();
                break;
            case "opts":
                if (data) {
                    void openDeckOptions(data.deck.id);
                }
                break;
            case "cram":
                void onFilteredDeck();
                break;
            case "refresh":
                void rebuild();
                break;
            case "empty":
                void empty();
                break;
            case "decks":
                moveToState("deckBrowser");
                break;
            case "studymore":
            case "customStudy":
                void onCustomStudy(data?.deck.id);
                break;
            case "unbury":
                void unbury();
                break;
            case "description":
                void editDescription();
                break;
        }
    }

    const links = $derived.by((): BarLink[] => {
        if (!data) {
            return [];
        }
        const out: BarLink[] = [["O", "opts", tr.actionsOptions()]];
        if (isFiltered) {
            out.push(["R", "refresh", tr.actionsRebuild()]);
            out.push(["E", "empty", tr.studyingEmpty()]);
        } else {
            out.push(["C", "studymore", tr.actionsCustomStudy()]);
        }
        if (data.haveBuried) {
            out.push(["U", "unbury", tr.studyingUnbury()]);
        }
        if (!isFiltered) {
            out.push(["", "description", tr.schedulingDescription()]);
        }
        return hooks.overviewWillRenderBottom.run(out);
    });

    // the congrats page is a desktop webview page
    function congrats(node: HTMLIFrameElement): { destroy(): void } {
        congratsFrame = node;
        const detach = attachFrame(node.contentWindow!, {
            onBridge: (cmd) => onCommand(cmd),
            onKey: () => false,
        });
        return { destroy: detach };
    }

    // learning cards may become due while the congrats screen shows
    const recheck = setInterval(() => {
        if (data?.finished) {
            void refresh();
        }
    }, 60_000);

    const unsubscribeOps = onOpChanges((changes) => {
        if (changes.studyQueues) {
            void refresh();
        }
    });
    const unsubscribeReset = resetCounter.subscribe(() => void refresh());

    onMount(() => {
        avPlayer.stopAndClearQueue();
        setStateShortcuts([
            ["o", () => onCommand("opts")],
            ["r", () => void rebuild()],
            ["e", () => void empty()],
            ["c", customStudy],
            ["u", () => void unbury()],
            ["s", study],
            ["Enter", () => data && !data.finished && study()],
        ]);
    });

    onDestroy(() => {
        clearInterval(recheck);
        unsubscribeOps();
        unsubscribeReset();
    });

    // study() from elsewhere returns here if there was nothing to study
    $effect(() => {
        if ($mainState === "overview" && data && !data.finished) {
            document.getElementById("study")?.focus();
        }
    });
</script>

<div class="overview">
    {#if data?.finished}
        <iframe class="congrats" title={tr.schedulingCongratulationsFinished()} src="/congrats" use:congrats></iframe>
    {:else if data}
        <div class="content">
            <h3>{data.deck.name}</h3>
            {#if data.description}
                <div class="descfont descmid description" class:dyn={isFiltered}>
                    <!-- descriptions can come from shared decks, so they are sanitized -->
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                    {@html sanitizeHtml(data.description)}
                </div>
            {:else}
                <p></p>
            {/if}
            <!-- desktop's overview.py table -->
            <table class="study-table" width="400" cellpadding="5">
                <tbody>
                    <tr>
                        <td align="center" valign="top">
                            <table cellspacing="5">
                                <tbody>
                                    {#each [[tr.actionsNew(), "new-count", 0], [tr.schedulingLearning(), "learn-count", 1], [tr.studyingToReview(), "review-count", 2]] as [title, klass, i] (klass)}
                                        <tr>
                                            <td>{title}:</td>
                                            <td>
                                                <b>
                                                    <span class={klass as string}>{data.counts[i as number]}</span>
                                                    <span class="bury-count" title={tr.studyingCountsDiffer()}>
                                                        {data.buried[i as number] ? `${data.buried[i as number] > 0 ? "+" : ""}${data.buried[i as number]}` : ""}
                                                    </span>
                                                </b>
                                            </td>
                                        </tr>
                                    {/each}
                                </tbody>
                            </table>
                        </td>
                        <td align="center">
                            <button type="button" id="study" onclick={study}>{tr.studyingStudyNow()}</button>
                        </td>
                    </tr>
                </tbody>
            </table>
            <div class="plugin-content" bind:this={pluginContent}></div>
        </div>
    {/if}
    {#if data}
        <BottomBar {links} {onCommand} />
    {/if}
</div>

<style lang="scss">
    @use "./webview";

    .overview {
        display: flex;
        flex-direction: column;
        height: 100%;
    }

    .content {
        @include webview.page;
        flex: 1;
        overflow: auto;
        // webview.scss's body margin
        padding: 2em;
        text-align: center;
        @media (hover: none) {
            padding: 2em 1em;
        }
    }

    .plugin-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        margin-top: 2em;
    }

    .congrats {
        flex: 1;
        border: none;
        width: 100%;
    }

    /* the browser's own h3 under desktop's overview.scss */
    h3 {
        margin: 0;
        font-size: 1.17em;
        font-weight: bold;
        line-height: normal;
        overflow-wrap: anywhere;
    }

    .descfont {
        padding: 1em;
        color: var(--fg-subtle);
    }

    .description {
        white-space: pre-wrap;
    }

    .descmid {
        width: min(70%, 40rem);
        margin: 0 auto;
        text-align: start;
        @media (max-width: 600px) {
            width: 100%;
        }
    }

    .dyn {
        text-align: center;
    }

    .study-table {
        max-width: 100%;
        margin: 0 auto;
        &,
        table {
            // Bootstrap's reboot collapses them, losing cellspacing
            border-collapse: separate;
        }
    }

    #study {
        @include webview.button($primary: true);
    }
</style>
