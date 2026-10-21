<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's browser/previewer.py
    import { getCard } from "@generated/backend";
    import * as tr from "@generated/ftl";
    import * as trq from "@generated/ftl-qt";
    import { onDestroy, onMount } from "svelte";
    import { get } from "svelte/store";

    import { CardFrame, cardFrameUrl } from "$web/app/cardframe";
    import { onOpChanges } from "$web/app/ops";
    import type { PreviewSource } from "$web/app/previewer";
    import { cardBodyClass, loadReviewerSettings, prepareCardText, renderCard, type Rendered } from "$web/app/reviewer";
    import { avPlayer } from "$web/app/sound";
    import { isEditable } from "$web/app/shortcuts";
    import { windows, type WindowHandle } from "$web/app/windows";
    import { hooks } from "$web/plugins/hooks";

    let { win, source }: { win: WindowHandle; source: PreviewSource } = $props();

    const TYPE_ANSWER_RE = /\[\[type:[^\]]+\]\]/g;

    let iframe: HTMLIFrameElement;
    let frame: CardFrame | null = null;
    let side = $state<"question" | "answer">("question");
    let backOnly = $state(false);
    let cardId: bigint | null = null;
    let rendered: Rendered | null = null;
    let templateIdx = 0;
    let empty = $state(false);
    let canPrev = $state(false);
    let canNext = $state(false);
    let generation = 0;
    const cleanups: (() => void)[] = [];

    async function load(): Promise<void> {
        const gen = ++generation;
        cardId = source.current();
        canPrev = source.canPrev?.() ?? false;
        canNext = source.canNext?.() ?? false;
        if (cardId === null) {
            rendered = null;
            empty = true;
            await frame?.call(
                "_showQuestion",
                `<div style="text-align:center">${trq.qtMiscPleaseSelect1Card()}</div>`,
                "",
                "card",
            );
            return;
        }
        empty = false;
        const card = await getCard({ cid: cardId });
        const result = await renderCard(card, true);
        if (gen !== generation) {
            return;
        }
        rendered = result;
        templateIdx = card.templateIdx;
        await show();
    }

    async function show(): Promise<void> {
        if (!rendered) {
            return;
        }
        const showAnswer = side === "answer" || backOnly;
        let text = showAnswer ? rendered.answer : rendered.question;
        text = (await prepareCardText(text)).replace(TYPE_ANSWER_RE, "");
        text = hooks.cardWillShow.run(text, rendered.context, showAnswer ? "previewAnswer" : "previewQuestion");
        const tags = showAnswer ? rendered.answerTags : rendered.questionTags;
        if (showAnswer && side === "answer" && !backOnly) {
            await frame?.call("_showAnswer", text);
        } else {
            await frame?.call("_showQuestion", text, "", cardBodyClass(templateIdx));
        }
        avPlayer.playTags(tags);
    }

    function onPrev(): void {
        if (side === "answer" && !backOnly) {
            side = "question";
            void show();
        } else if (source.prev?.()) {
            side = backOnly ? "answer" : "question";
            void load();
        }
    }

    function onNext(): void {
        if (side === "question" && !backOnly) {
            side = "answer";
            void show();
        } else if (source.next?.()) {
            side = backOnly ? "answer" : "question";
            void load();
        }
    }

    function replay(): void {
        if (rendered) {
            avPlayer.playTags(side === "answer" || backOnly ? rendered.answerTags : rendered.questionTags);
        }
    }

    function toggleBackOnly(): void {
        backOnly = !backOnly;
        void show();
    }

    const KEYS = ["Left", "Right", "Enter", "r", "Shift+R", "F5", "b", "Shift+B"];

    function onKey(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
        if (event.ctrlKey || event.metaKey || event.altKey) {
            return false;
        }
        switch (event.key) {
            case "ArrowLeft":
                onPrev();
                return true;
            case "ArrowRight":
            case "Enter":
                onNext();
                return true;
            case "r":
            case "R":
            case "F5":
                replay();
                return true;
            case "b":
            case "B":
                toggleBackOnly();
                return true;
        }
        return false;
    }

    function onWindowKey(event: KeyboardEvent): void {
        const target = event.target as HTMLElement | null;
        const isTop = get(windows).at(-1)?.handle === win;
        if (event.defaultPrevented || !isTop || isEditable(target) || target?.closest?.("button")) {
            return;
        }
        if (onKey(event)) {
            event.preventDefault();
        }
    }

    function playClicked(cmd: string): void {
        const [, qa, idx] = cmd.split(":");
        const tags = qa === "q" ? rendered?.questionTags : rendered?.answerTags;
        const tag = tags?.[Number(idx)];
        if (tag) {
            avPlayer.playTags([tag]);
        }
    }

    onMount(() => {
        const cardFrame = new CardFrame(iframe, {
            onBridge: (cmd) => {
                if (cmd.startsWith("play:")) {
                    playClicked(cmd);
                }
                return undefined;
            },
            onKey: (event) => void onKey(event),
            keys: () => KEYS,
            onEscape: () => void win.requestClose(),
            onReload: () => void show(),
        });
        frame = cardFrame;
        cleanups.push(() => cardFrame.destroy());
        if (source.subscribe) {
            cleanups.push(
                source.subscribe(() => {
                    side = backOnly ? "answer" : "question";
                    void load();
                }),
            );
        }
        cleanups.push(
            onOpChanges((changes) => {
                if (changes.noteText || changes.card || changes.notetype) {
                    void load();
                }
            }),
        );
        void loadReviewerSettings().then(load);
    });

    onDestroy(() => {
        generation++;
        avPlayer.stopAndClearQueue();
        cleanups.forEach((fn) => fn());
    });
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="previewer">
    <iframe bind:this={iframe} src={cardFrameUrl()} title={tr.actionsPreview()}></iframe>
    <footer>
        <button type="button" class="btn btn-secondary" title={tr.actionsShortcutKey({ val: "R" })} onclick={replay}>
            {tr.actionsReplayAudio()}
        </button>
        <label title={tr.actionsShortcutKey({ val: "B" })}>
            <input type="checkbox" checked={backOnly} onchange={toggleBackOnly} />
            {trq.qtMiscBackSideOnly()}
        </label>
        <span class="spacer"></span>
        <button
            type="button"
            class="btn btn-secondary"
            title={trq.qtMiscShortcutKeyLeftArrow()}
            disabled={empty || (!canPrev && (side === "question" || backOnly))}
            onclick={onPrev}
        >
            ‹
        </button>
        <button
            type="button"
            class="btn btn-secondary"
            title={trq.qtMiscShortcutKeyRightArrowOrEnter()}
            disabled={empty || (!canNext && (side === "answer" || backOnly))}
            onclick={onNext}
        >
            ›
        </button>
    </footer>
</div>

<style>
    .previewer {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
    }
    iframe {
        flex: 1;
        min-height: 0;
        border: 0;
        width: 100%;
        background: var(--canvas);
    }
    footer {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem;
        border-top: 1px solid var(--border-subtle);
    }
    label {
        display: flex;
        gap: 0.4rem;
        align-items: center;
    }
    .spacer {
        flex: 1;
    }
</style>
