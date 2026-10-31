<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's reviewer.py: the card frame and the bottom bar (reviewer-bottom)
    import * as tr from "@generated/ftl";
    import { onDestroy, onMount } from "svelte";
    import { get } from "svelte/store";

    import {
        confirmDeckThenDisplayOptions,
        onCreateCopy,
        onEditCurrent,
        openCardInfo,
        openPreviousCardInfo,
    } from "$web/app/actions";
    import { CardFrame, cardFrameUrl } from "$web/app/cardframe";
    import { undoAction } from "$web/app/main";
    import { popupMenu } from "$web/app/menus";
    import { matches } from "$web/app/keys";
    import { bar, DELETE_NOTE_KEY, reviewer, selectedEase } from "$web/app/reviewer";
    import { bottomBarHideMode, fullScreen, hideBottomBar } from "$web/app/settings";
    import { handleKey, mainWindowBlocked, setStateShortcuts, shortcutKeys, shortcutLabel } from "$web/app/shortcuts";
    import { windows } from "$web/app/windows";

    let frame: HTMLIFrameElement;
    let moreButton: HTMLButtonElement;
    let cardFrame: CardFrame | null = null;
    let now = $state(Date.now());

    async function showContextMenu(): Promise<void> {
        popupMenu(await reviewer.contextMenu(), moreButton);
    }

    onMount(() => {
        cardFrame = new CardFrame(frame, {
            onBridge: (cmd) => {
                if (cmd === "more") {
                    void showContextMenu();
                    return undefined;
                }
                return reviewer.onBridge(cmd);
            },
            onKey: (event) => {
                // as installShortcuts: only answer keys repeat
                if (event.repeat && !/^[1-4 ]$/.test(event.key)) {
                    return;
                }
                // card scripts can fake keys from the frame, so deleting asks first
                if (matches(DELETE_NOTE_KEY, event)) {
                    if (!mainWindowBlocked()) {
                        void reviewer.confirmDeleteCurrentNote();
                    }
                    return;
                }
                handleKey(event);
            },
            keys: shortcutKeys,
            // a window opened with a shortcut from the card leaves focus here
            onEscape: () => void get(windows).at(-1)?.handle.requestClose(),
            onReload: () => reviewer.onFrameReload(),
        });
        reviewer.attachFrame(cardFrame);
        setStateShortcuts(
            reviewer.shortcuts({
                onEditCurrent,
                showContextMenu: () => void showContextMenu(),
                onOptions: () => reviewer.card && void confirmDeckThenDisplayOptions(reviewer.card),
                onCardInfo: () => openCardInfo(),
                onPreviousCardInfo: openPreviousCardInfo,
                onCreateCopy: () => reviewer.card && onCreateCopy(reviewer.card),
                undo: () => void undoAction(),
            }),
        );
        cardFrame.sendKeys();
        void reviewer.show();
        const timer = setInterval(() => (now = Date.now()), 1000);
        return () => clearInterval(timer);
    });

    onDestroy(() => {
        reviewer.cleanup();
        cardFrame?.destroy();
    });

    const timeText = $derived.by(() => {
        const { startedAt, maxSecs, stoppedAt } = $bar.timer;
        if (!maxSecs || $bar.mode === "none") {
            return null;
        }
        const secs = Math.min(maxSecs, Math.max(0, Math.floor(((stoppedAt ?? now) - startedAt) / 1000)));
        return { text: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`, capped: secs >= maxSecs };
    });
</script>

<div class="reviewer">
    <iframe bind:this={frame} class="card-frame" src={cardFrameUrl()} title={tr.studyingStudyNow()}></iframe>

    <footer class="reviewer-bar" hidden={$hideBottomBar && ($bottomBarHideMode === 1 || $fullScreen)}>
        <div class="side start">
            <button
                type="button"
                title={tr.actionsShortcutKey({ val: "E" })}
                disabled={$bar.mode === "none"}
                onclick={onEditCurrent}
            >
                {tr.studyingEdit()}
            </button>
        </div>

        <div class="middle">
            {#if $bar.mode === "question"}
                <button
                    type="button"
                    class="show-answer"
                    title={tr.actionsShortcutKey({ val: tr.studyingSpace() })}
                    onclick={() => void reviewer.getTypedAnswer()}
                >
                    {#if $bar.remaining}
                        {@const [n, l, r] = $bar.remaining.counts}
                        {@const idx = $bar.remaining.idx}
                        <span class="stattxt">
                            <span class="new-count" class:current={idx === 0}>{n}</span>
                            +
                            <span class="learn-count" class:current={idx === 1}>{l}</span>
                            +
                            <span class="review-count" class:current={idx === 2}>{r}</span>
                        </span>
                    {/if}
                    {tr.studyingShowAnswer()}
                </button>
            {:else if $bar.mode === "answer"}
                {#each $bar.buttons as button (button.ease)}
                    <button
                        type="button"
                        class="ease ease{button.ease}"
                        class:default={button.isDefault}
                        data-ease={button.ease}
                        title={button.key ? tr.actionsShortcutKey({ val: button.key }) : undefined}
                        onfocus={() => selectedEase.set(button.ease)}
                        onblur={() => selectedEase.set(null)}
                        onclick={() => void reviewer.answerCard(button.ease)}
                    >
                        {#if button.due}
                            <span class="stattxt">{button.due}</span>
                        {/if}
                        {button.label}
                    </button>
                {/each}
            {/if}
        </div>

        <div class="side end">
            <button
                type="button"
                bind:this={moreButton}
                title={tr.actionsShortcutKey({ val: shortcutLabel("M") })}
                onclick={() => void showContextMenu()}
            >
                {#if timeText}
                    <span class="stattxt" class:capped={timeText.capped}>{timeText.text}</span>
                {/if}
                {tr.studyingMore()} ▾
            </button>
        </div>
    </footer>
</div>

<style lang="scss">
    @use "$ts/lib/sass/card-counts";
    @use "./webview";

    .reviewer {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
    }

    .card-frame {
        flex: 1;
        min-height: 0;
        width: 100%;
        border: 0;
        background: var(--canvas);
    }

    /* desktop's reviewer bottom bar (reviewer-bottom.scss): buttons 9px apart
       below a 10px gap, Show Answer 2px lower in its inner table, and the
       height it sizes to with Show Answer showing */
    .reviewer-bar {
        &[hidden] {
            display: none;
        }
        @include webview.page;
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: start;
        min-height: 56.5px;
        padding: 10px 0 env(safe-area-inset-bottom);
        border-top: 1px solid var(--border);
        :global(.night-mode) & {
            border-top-color: var(--border-subtle);
        }
        background: var(--canvas);
        user-select: none;
        -webkit-user-select: none;
    }

    .middle {
        display: flex;
        justify-content: center;
        flex-wrap: wrap;
    }

    // outranks base.scss's button:not(.btn, .btn-close)
    .reviewer-bar button {
        @include webview.button;
        position: relative;
        min-width: 60px;
        white-space: nowrap;
        margin: 9px;
    }

    .reviewer-bar .show-answer {
        margin: 11px 9px;
    }

    @media (hover: none) {
        .reviewer-bar .show-answer {
            min-width: 10rem;
        }
        .reviewer-bar .ease {
            min-width: 4.5rem;
        }
    }

    .stattxt {
        position: absolute;
        top: -3px;
        left: 50%;
        transform: translate(-50%, -100%);
        white-space: nowrap;
        font-size: small;
        font-weight: normal;
        color: var(--fg);
    }

    .current {
        text-decoration: underline;
    }

    .capped {
        color: red;
    }

    @media (max-width: 583px) {
        .side.start,
        .side.end .stattxt {
            display: none;
        }
        .reviewer-bar {
            grid-template-columns: 1fr auto;
        }
        .reviewer-bar .ease {
            min-width: 0;
            flex: 1;
        }
    }
</style>
