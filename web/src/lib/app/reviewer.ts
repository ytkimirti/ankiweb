// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * The study screen's logic (desktop's reviewer.py). Cards are shown by the
 * desktop reviewer script (ts/reviewer) in a card frame (cardframe.ts); the
 * answer bar is Reviewer.svelte.
 */

import type { AVTag, RenderedTemplateNode } from "@generated/anki/card_rendering_pb";
import type { Card } from "@generated/anki/cards_pb";
import { DeckConfig_Config_AnswerAction, DeckConfig_Config_QuestionAction, type DeckConfig_Config } from "@generated/anki/deck_config_pb";
import { SchedulingStatesWithContext, SetSchedulingStatesRequest } from "@generated/anki/frontend_pb";
import { Empty } from "@generated/anki/generic_pb";
import type { Note } from "@generated/anki/notes_pb";
import type { Notetype } from "@generated/anki/notetypes_pb";
import {
    CardAnswer,
    CardAnswer_Rating,
    QueuedCards_Queue,
    ScheduleCardsAsNewRequest_Context,
    type QueuedCards,
    type SchedulingContext,
    type SchedulingStates,
} from "@generated/anki/scheduler_pb";
import {
    answerCard,
    compareAnswer,
    describeNextStates,
    encodeIriPaths,
    extractAvTags,
    extractClozeForTyping,
    getCard,
    getConfigJson,
    getDeck,
    getDeckConfig,
    getNote,
    getNotetype,
    getPreferences,
    getQueuedCards,
    renderExistingCard,
    stateIsLeech,
} from "@generated/backend";
import * as tr from "@generated/ftl";
import { withCollapsedWhitespace } from "@tslib/i18n";
import { get, writable } from "svelte/store";

import { hooks, type CardContext } from "../plugins/hooks";
import { registerFrontendMethod } from "./backend";
import type { CardFrame } from "./cardframe";
import {
    addTagsToNotes,
    allFlags,
    buryCards,
    buryNotes,
    forgetCardsDialog,
    MARKED_TAG,
    removeNotesWithTooltip,
    removeTagsFromNotes,
    SET_DUE_REVIEWER,
    setCardFlag,
    setDueDateDialog,
    suspendCards,
    suspendNotes,
} from "./cardops";
import { dialogs, openDialog, tooltip } from "./dialogs";
import { mainState, moveToState } from "./main";
import { type MenuEntry, openMenus } from "./menus";
import { onOpChanges } from "./ops";
import { getProfileConfig } from "./profiles";
import { runOp } from "./run";
import { mainWindowBlocked, type Shortcut } from "./shortcuts";
import { avPlayer } from "./sound";
import { windows } from "./windows";

const AV_REF_RE = /\[anki:(play:(.):(\d+))\]/g;
const TYPE_ANS_RE = /\[\[type:(.+?)\]\]/;

const PLAY_BUTTON = (cmd: string) => `
<a class="replay-button soundLink" href=# onclick="pycmd('${cmd}'); return false;" draggable="false">
    <svg class="playImage" viewBox="0 0 64 64" version="1.1">
        <circle cx="32" cy="32" r="29" />
        <path d="M56.502,32.301l-37.502,20.101l0.329,-40.804l37.173,20.703Z" />
    </svg>
</a>`;

export interface AnswerButton {
    ease: number;
    label: string;
    due: string;
    key: string;
    isDefault: boolean;
}

export interface BarState {
    mode: "none" | "question" | "answer";
    /** New, learning and review counts, and which one the current card is from. */
    remaining: { counts: [number, number, number]; idx: number } | null;
    buttons: AnswerButton[];
    /** Answer timer: when the card was shown, and the deck's limit (0 hides the timer). */
    timer: { startedAt: number; maxSecs: number; stoppedAt: number | null };
}

export const bar = writable<BarState>({
    mode: "none",
    remaining: null,
    buttons: [],
    timer: { startedAt: 0, maxSecs: 0, stoppedAt: null },
});

/** The answer button the user last focused, for Enter/Space (selectedAnswerButton()). */
export const selectedEase = writable<number | null>(null);

// Timeboxing (desktop's col.startTimebox/timeboxReached)
//////////////////////////////////////////////////////////////////////////////

let sessionReps = 0;
let timeboxStart = Date.now();
let timeboxStartReps = 0;

export function startTimebox(): void {
    timeboxStart = Date.now();
    timeboxStartReps = sessionReps;
}

async function timeboxReached(): Promise<[number, number] | null> {
    const json = await getConfigJson({ val: "timeLim" }, { alertOnError: false }).catch(() => null);
    const limit = json ? Number(JSON.parse(new TextDecoder().decode(json.json))) : 0;
    if (!limit) {
        return null;
    }
    const elapsed = (Date.now() - timeboxStart) / 1000;
    return elapsed > limit ? [limit, sessionReps - timeboxStartReps] : null;
}

// Rendering (pylib's TemplateRenderContext)
//////////////////////////////////////////////////////////////////////////////

export interface Rendered {
    question: string;
    answer: string;
    questionTags: AVTag[];
    answerTags: AVTag[];
    note: Note;
    notetype: Notetype;
    context: CardContext;
}

export function applyCustomFilters(nodes: RenderedTemplateNode[], ctx: CardContext, frontSide: string | null): string {
    if (nodes.length === 1 && nodes[0].value.case === "text") {
        return nodes[0].value.value;
    }
    let out = "";
    for (const node of nodes) {
        if (node.value.case === "text") {
            out += node.value.value;
        } else if (node.value.case === "replacement") {
            const replacement = node.value.value;
            let text = replacement.fieldName === "FrontSide" && frontSide !== null
                ? frontSide
                : replacement.currentText;
            for (const filter of replacement.filters) {
                text = hooks.fieldFilter.run(text, replacement.fieldName, filter, ctx);
            }
            out += text;
        }
    }
    return out;
}

export async function renderCard(card: Card, browser = false): Promise<Rendered> {
    const output = await renderExistingCard({ cardId: card.id, browser, partialRender: true });
    const note = await getNote({ nid: card.noteId });
    const notetype = await getNotetype({ ntid: note.notetypeId });
    const context: CardContext = {
        cardId: card.id,
        noteId: card.noteId,
        ord: card.templateIdx,
        fields: Object.fromEntries(notetype.fields.map((f, i) => [f.name, note.fields[i] ?? ""])),
        questionSide: true,
    };
    const qtext = applyCustomFilters(output.questionNodes, context, null);
    const q = await extractAvTags({ text: qtext, questionSide: true });
    const atext = applyCustomFilters(output.answerNodes, { ...context, questionSide: false }, q.text);
    const a = await extractAvTags({ text: atext, questionSide: false });
    return {
        question: `<style>${output.css}</style>${q.text}`,
        answer: `<style>${output.css}</style>${a.text}`,
        questionTags: q.avTags,
        answerTags: a.avTags,
        note,
        notetype,
        context,
    };
}

let hidePlayButtons = false;

/** Desktop's mw.prepare_card_text_for_display. */
export async function prepareCardText(text: string): Promise<string> {
    text = (await encodeIriPaths({ val: text })).val;
    return hidePlayButtons ? text.replace(AV_REF_RE, "") : text.replace(AV_REF_RE, (_m, cmd) => PLAY_BUTTON(cmd));
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The classes desktop puts on a card's <body>. */
export function cardBodyClass(templateIdx: number): string {
    const platform = /Mac|iPhone|iPad/.test(navigator.platform)
        ? "isMac"
        : /Win/.test(navigator.platform)
        ? "isWin"
        : "isLin";
    const night = document.documentElement.classList.contains("night-mode");
    return [`card card${templateIdx + 1}`, platform, night ? "nightMode night_mode" : "", "fancy"]
        .filter(Boolean)
        .join(" ");
}

// The reviewer
//////////////////////////////////////////////////////////////////////////////

type RefreshNeeded = "queues" | "noteText" | "flag" | null;

const REFRESH_RANK = { flag: 1, noteText: 2, queues: 3 } as const;

/** The more thorough of two refreshes. */
function moreThorough(a: RefreshNeeded, b: RefreshNeeded): RefreshNeeded {
    if (!a || !b) {
        return a ?? b;
    }
    return REFRESH_RANK[a] >= REFRESH_RANK[b] ? a : b;
}

/** Cards shown in the reviewer, for the card info window. */
export const reviewerCards = writable<{ current: bigint | null; previous: bigint | null }>({
    current: null,
    previous: null,
});

class Reviewer {
    private frame: CardFrame | null = null;

    card: Card | null = null;
    rendered: Rendered | null = null;
    private queued: QueuedCards | null = null;
    private states: SchedulingStates | null = null;
    private context: SchedulingContext | null = null;
    private conf: DeckConfig_Config | null = null;
    private timerStarted = 0;
    state: "question" | "answer" | "transition" | null = null;
    private refreshNeeded: RefreshNeeded = null;
    private answeredIds: bigint[] = [];
    private previousCard: Card | null = null;

    private typeCorrect: string | null = null;
    private typeFont = "";
    private typeSize = 20;
    private combining = true;
    private ignoreCase = false;
    private typedAnswer: string | null = null;

    private stateMutationKey = String(Math.floor(Math.random() * 2 ** 52));
    private stateMutationJs: string | null = null;
    private statesMutated: Promise<void> = Promise.resolve();
    private resolveStatesMutated: (() => void) | null = null;

    autoAdvanceEnabled = false;
    private showAnswerTimer: ReturnType<typeof setTimeout> | null = null;
    private showQuestionTimer: ReturnType<typeof setTimeout> | null = null;
    private recordedAudio: string | null = null;
    private active = false;
    private generation = 0;
    /** Bumped for each question or answer shown, so a slower earlier one gives way. */
    private renderToken = 0;

    constructor() {
        onOpChanges((changes, initiator) => {
            if (!this.active || initiator === this) {
                return;
            }
            if (changes.studyQueues) {
                this.refreshNeeded = "queues";
            } else if (changes.noteText) {
                this.refreshNeeded = moreThorough(this.refreshNeeded, "noteText");
            } else if (changes.card) {
                this.refreshNeeded = moreThorough(this.refreshNeeded, "flag");
            }
            this.refreshWhenIdle();
        });
        avPlayer.onDidEndPlaying(() => this.onAvPlayerDidEnd());
        // as desktop refreshes when the main window regains focus
        const onUnblocked = () => this.refreshWhenIdle();
        windows.subscribe(onUnblocked);
        dialogs.subscribe(onUnblocked);
        openMenus.subscribe(onUnblocked);
    }

    /** Refreshes now, unless a card is being shown or answered or the main window is covered. */
    private refreshWhenIdle(): void {
        if (this.active && this.refreshNeeded && this.state !== "transition" && !mainWindowBlocked()) {
            void this.refreshIfNeeded();
        }
    }

    // Lifecycle
    ////////////////////////////////////////////////////////////////////////

    /** Called by Reviewer.svelte when its frame is created. */
    attachFrame(frame: CardFrame): void {
        this.frame = frame;
    }

    async show(): Promise<void> {
        this.active = true;
        const generation = ++this.generation;
        const js = await getConfigJson({ val: "cardStateCustomizer" }, { alertOnError: false })
            .then((json) => JSON.parse(new TextDecoder().decode(json.json)) as string | null)
            .catch(() => null);
        await loadReviewerSettings();
        if (generation !== this.generation) {
            return;
        }
        this.stateMutationJs = js;
        this.refreshNeeded = "queues";
        await this.refreshIfNeeded();
    }

    /** The frame reloaded, losing the card it showed. */
    onFrameReload(): void {
        if (this.card) {
            // deferred while a card is being shown; showing it ends with a refresh
            this.refreshNeeded = moreThorough(this.refreshNeeded, "noteText");
            this.refreshWhenIdle();
        }
    }

    cleanup(): void {
        hooks.reviewerWillEnd.run();
        this.active = false;
        this.generation++;
        this.renderToken++;
        this.card = null;
        this.state = null;
        this.autoAdvanceEnabled = false;
        this.clearAutoAdvanceTimers();
        avPlayer.stopAndClearQueue();
        bar.set({ mode: "none", remaining: null, buttons: [], timer: { startedAt: 0, maxSecs: 0, stoppedAt: null } });
        this.frame = null;
    }

    private async refreshIfNeeded(): Promise<void> {
        const needed = this.refreshNeeded;
        this.refreshNeeded = null;
        if (needed === "queues") {
            await this.nextCard();
        } else if (needed === "noteText") {
            await this.redrawCurrentCard();
        } else if (needed === "flag" && this.card) {
            this.card = await getCard({ cid: this.card.id });
            this.drawFlag();
        }
    }

    private async redrawCurrentCard(): Promise<void> {
        if (!this.card) {
            return;
        }
        const generation = this.generation;
        const side = this.state;
        this.state = "transition";
        const card = await getCard({ cid: this.card.id }).catch(() => null);
        const rendered = card ? await renderCard(card).catch(() => null) : null;
        if (generation !== this.generation) {
            return;
        }
        if (!card || !rendered) {
            // the card is gone
            this.refreshNeeded = "queues";
            this.state = side;
            await this.refreshIfNeeded();
            return;
        }
        this.card = card;
        this.rendered = rendered;
        if (side === "answer") {
            await this.showAnswer();
        } else {
            await this.showQuestion();
        }
    }

    async nextCard(): Promise<void> {
        const generation = this.generation;
        this.previousCard = this.card;
        this.card = null;
        const queued = await runOp(() => getQueuedCards({ fetchLimit: 1, intradayLearningOnly: false }));
        if (generation !== this.generation) {
            return;
        }
        if (!queued || !queued.cards.length) {
            reviewerCards.set({ current: null, previous: this.previousCard?.id ?? null });
            if (!this.previousCard && sessionReps === timeboxStartReps) {
                tooltip(tr.studyingNoCardsAreDueYet());
            }
            moveToState("overview");
            return;
        }
        const top = queued.cards[0];
        this.queued = queued;
        this.states = top.states!;
        this.states.current!.customData = top.card!.customData;
        this.context = top.context!;
        this.card = top.card!;
        this.timerStarted = Date.now();
        reviewerCards.set({ current: this.card.id, previous: this.previousCard?.id ?? null });
        this.conf = await this.loadConfig(this.card);
        this.rendered = await renderCard(this.card);
        if (generation !== this.generation) {
            return;
        }
        await this.showQuestion();
    }

    private async loadConfig(card: Card): Promise<DeckConfig_Config | null> {
        const deckId = card.originalDeckId || card.deckId;
        const deck = await getDeck({ did: deckId });
        const configId = deck.kind.case === "normal" ? deck.kind.value.configId : 1n;
        return (await getDeckConfig({ dcid: configId })).config ?? null;
    }

    // Showing the question and answer
    ////////////////////////////////////////////////////////////////////////

    private bodyClass(): string {
        return cardBodyClass(this.card!.templateIdx);
    }

    private async callFrame(fn: string, ...args: unknown[]): Promise<void> {
        await this.frame?.call(fn, ...args);
    }

    /**
     * Shows the question. The reviewer stays in "transition" until the frame
     * shows it, so keys and refreshes in between do not act on a half-shown card.
     */
    async showQuestion(): Promise<void> {
        const card = this.card;
        const rendered = this.rendered;
        if (!card || !rendered) {
            return;
        }
        const token = ++this.renderToken;
        this.state = "transition";
        this.typedAnswer = null;
        this.clearAutoAdvanceTimers();
        try {
            const sounds = this.conf?.disableAutoplay ? [] : rendered.questionTags;
            avPlayer.playTags(sounds);
            let q = await this.mungeQA("question", rendered.question, card, rendered);
            q = hooks.cardWillShow.run(q, rendered.context, "reviewQuestion");
            const answerForPreload = (await encodeIriPaths({ val: rendered.answer })).val;
            if (token !== this.renderToken) {
                return;
            }
            this.runStateMutationHook();
            await this.callFrame("_showQuestion", q, answerForPreload, this.bodyClass());
        } catch (err) {
            console.error("showing the question failed", err);
        } finally {
            // even if rendering failed, so the user can carry on
            if (token === this.renderToken) {
                this.state = "question";
            }
        }
        if (token !== this.renderToken) {
            return;
        }
        this.drawFlag();
        this.drawMark();
        this.showAnswerButton();
        hooks.reviewerDidShowQuestion.run(rendered.context);
        this.autoAdvanceToAnswerIfEnabled();
        this.refreshWhenIdle();
    }

    async showAnswer(): Promise<void> {
        const card = this.card;
        const rendered = this.rendered;
        if (get(mainState) !== "review" || !card || !rendered) {
            return;
        }
        const token = ++this.renderToken;
        this.state = "transition";
        this.clearAutoAdvanceTimers();
        try {
            const sounds = this.conf?.disableAutoplay ? [] : rendered.answerTags;
            avPlayer.playTags(sounds);
            let a = await this.mungeQA("answer", rendered.answer, card, rendered);
            a = hooks.cardWillShow.run(a, rendered.context, "reviewAnswer");
            if (token !== this.renderToken) {
                return;
            }
            await this.callFrame("_showAnswer", a);
        } catch (err) {
            console.error("showing the answer failed", err);
        } finally {
            if (token === this.renderToken) {
                this.state = "answer";
            }
        }
        if (token !== this.renderToken) {
            return;
        }
        await this.showEaseButtons();
        if (token !== this.renderToken) {
            return;
        }
        hooks.reviewerDidShowAnswer.run(rendered.context);
        this.autoAdvanceToQuestionIfEnabled();
        this.refreshWhenIdle();
    }

    private async mungeQA(side: "question" | "answer", text: string, card: Card, rendered: Rendered): Promise<string> {
        text = await prepareCardText(text);
        return side === "question"
            ? await this.typeAnsQuestionFilter(text, card, rendered)
            : await this.typeAnsAnswerFilter(text);
    }

    private drawFlag(): void {
        void this.callFrame("_drawFlag", (this.card?.flags ?? 0) & 0b111);
    }

    private drawMark(): void {
        const marked = this.rendered?.note.tags.some((t) => t.toLowerCase() === MARKED_TAG) ?? false;
        void this.callFrame("_drawMark", marked);
    }

    private showAnswerButton(): void {
        const conf = this.conf;
        selectedEase.set(null);
        bar.set({
            mode: "question",
            remaining: this.remaining(),
            buttons: [],
            timer: {
                startedAt: this.timerStarted,
                maxSecs: conf?.showTimer ? conf.capAnswerTimeToSecs : 0,
                stoppedAt: null,
            },
        });
    }

    private remaining(): BarState["remaining"] {
        if (!this.queued || !showDueCounts) {
            return null;
        }
        const queue = this.queued.cards[0]?.queue;
        const idx = queue === QueuedCards_Queue.NEW ? 0 : queue === QueuedCards_Queue.LEARNING ? 1 : 2;
        return {
            counts: [this.queued.newCount, this.queued.learningCount, this.queued.reviewCount],
            idx,
        };
    }

    private async showEaseButtons(): Promise<void> {
        await this.statesMutated;
        if (!this.states || this.state !== "answer") {
            return;
        }
        const labels = estimateTimes ? (await describeNextStates(this.states)).vals : [];
        const names = [tr.studyingAgain(), tr.studyingHard(), tr.studyingGood(), tr.studyingEasy()];
        const buttons: AnswerButton[] = names.map((label, i) => ({
            ease: i + 1,
            label,
            due: labels[i] ?? "",
            key: answerKey(i + 1),
            isDefault: i + 1 === 3,
        }));
        const conf = this.conf;
        selectedEase.set(null);
        bar.update((state) => ({
            ...state,
            mode: "answer",
            buttons,
            timer: conf?.stopTimerOnAnswer ? { ...state.timer, stoppedAt: Date.now() } : state.timer,
        }));
    }

    // Custom scheduling (deck options > advanced > custom scheduling)
    ////////////////////////////////////////////////////////////////////////

    private runStateMutationHook(): void {
        const js = this.stateMutationJs;
        if (!js) {
            this.statesMutated = Promise.resolve();
            return;
        }
        this.statesMutated = new Promise((resolve) => (this.resolveStatesMutated = resolve));
        const code = `anki.mutateNextCardStates('${this.stateMutationKey}', async (states, customData, ctx) => {
    ${js}
    }).finally(() => bridgeCommand('statesMutated'));`;
        const frame = this.frame;
        if (!frame) {
            this.onStatesMutated();
            return;
        }
        frame.eval(code).catch((err) => {
            console.error("custom scheduling failed", err);
            this.onStatesMutated();
        });
    }

    private onStatesMutated(): void {
        this.resolveStatesMutated?.();
        this.resolveStatesMutated = null;
    }

    schedulingStatesWithContext(): SchedulingStatesWithContext {
        return new SchedulingStatesWithContext({ states: this.states ?? undefined, context: this.context ?? undefined });
    }

    setSchedulingStates(request: SetSchedulingStatesRequest): void {
        if (request.key === this.stateMutationKey && request.states) {
            this.states = request.states;
        }
    }

    // Answering
    ////////////////////////////////////////////////////////////////////////

    async answerCard(ease: number): Promise<void> {
        if (get(mainState) !== "review" || this.state !== "answer" || !this.card || !this.states || !this.rendered) {
            return;
        }
        const [proceed, finalEase] = hooks.reviewerWillAnswerCard.run([true, ease], this.rendered.context);
        if (!proceed) {
            return;
        }
        const states = this.states;
        const rating = [CardAnswer_Rating.AGAIN, CardAnswer_Rating.HARD, CardAnswer_Rating.GOOD, CardAnswer_Rating.EASY][
            finalEase - 1
        ];
        const newState = [states.again, states.hard, states.good, states.easy][finalEase - 1]!;
        const answer = new CardAnswer({
            cardId: this.card.id,
            currentState: states.current,
            newState,
            rating,
            answeredAtMillis: BigInt(Date.now()),
            millisecondsTaken: Date.now() - this.timerStarted,
        });
        this.state = "transition";
        this.clearAutoAdvanceTimers();
        const done = await runOp(() => answerCard(answer, { initiator: this }));
        if (!done) {
            this.state = "answer";
            return;
        }
        sessionReps++;
        const card = this.card;
        const context = this.rendered.context;
        if ((await stateIsLeech(newState)).val) {
            const reloaded = await getCard({ cid: card.id }).catch(() => null);
            this.onLeech(!!reloaded && reloaded.queue < 0);
        }
        hooks.reviewerDidAnswerCard.run(context, finalEase);
        this.answeredIds.push(card.id);
        if (!(await this.checkTimebox())) {
            await this.nextCard();
        }
    }

    private onLeech(suspended: boolean): void {
        let text = tr.studyingCardWasALeech();
        if (suspended) {
            text += ` ${tr.studyingItHasBeenSuspended()}`;
        }
        tooltip(text);
    }

    private async checkTimebox(): Promise<boolean> {
        const reached = await timeboxReached();
        if (!reached) {
            return false;
        }
        const [limit, cards] = reached;
        const message = withCollapsedWhitespace(
            tr.studyingCardStudiedInMinute({ cards, minutes: String(Math.round(limit / 60)) }),
        );
        const result = await openDialog({
            text: message,
            kind: "info",
            buttons: [
                { label: tr.studyingContinue(), value: "continue" },
                { label: tr.studyingFinish(), value: "finish", primary: true },
            ],
        });
        if (result.button === "finish") {
            moveToState("deckBrowser");
            return true;
        }
        startTimebox();
        return false;
    }

    onEnterKey(): void {
        if (this.state === "question") {
            void this.getTypedAnswer();
        } else if (this.state === "answer" && spacebarRatesCard()) {
            void this.answerCard(get(selectedEase) ?? 3);
        }
    }

    async getTypedAnswer(): Promise<void> {
        if (this.state !== "question") {
            return;
        }
        const typed = await this.frame?.call<string | null>("getTypedAnswer");
        if (this.state !== "question") {
            return;
        }
        this.typedAnswer = typed ?? "";
        await this.showAnswer();
    }

    // Type in the answer
    ////////////////////////////////////////////////////////////////////////

    private async typeAnsQuestionFilter(buf: string, card: Card, rendered: Rendered): Promise<string> {
        this.combining = true;
        this.ignoreCase = false;
        this.typeCorrect = null;
        let clozeIdx: number | null = null;
        const m = buf.match(TYPE_ANS_RE);
        if (!m) {
            return buf;
        }
        let fld = m[1];
        const sep = fld.lastIndexOf(":");
        const modifiers = sep >= 0 ? fld.slice(0, sep) : "";
        fld = sep >= 0 ? fld.slice(sep + 1) : fld;
        for (const modifier of modifiers.split(":")) {
            if (modifier === "cloze") {
                clozeIdx = card.templateIdx + 1;
            } else if (modifier === "nc") {
                this.combining = false;
            } else if (modifier === "ci") {
                this.ignoreCase = true;
            }
        }
        const fieldIdx = rendered.notetype.fields.findIndex((f) => f.name === fld);
        if (fieldIdx >= 0) {
            const field = rendered.notetype.fields[fieldIdx];
            this.typeCorrect = rendered.note.fields[fieldIdx] ?? "";
            if (clozeIdx) {
                this.typeCorrect = (await extractClozeForTyping({ text: this.typeCorrect, ordinal: clozeIdx })).val
                    || null;
            }
            this.typeFont = field.config?.fontName ?? "";
            this.typeSize = field.config?.fontSize ?? 20;
        }
        if (!this.typeCorrect) {
            if (this.typeCorrect === null) {
                const warn = clozeIdx
                    ? tr.studyingPleaseRunToolsemptyCards()
                    : tr.studyingTypeAnswerUnknownField({ val: fld });
                return buf.replace(TYPE_ANS_RE, warn);
            }
            return buf.replace(TYPE_ANS_RE, "");
        }
        return buf.replace(
            TYPE_ANS_RE,
            `
<center>
<input type=text id=typeans onkeypress="_typeAnsPress();"
   style="font-family: '${escapeHtml(this.typeFont)}'; font-size: ${this.typeSize}px;">
</center>
`,
        );
    }

    private async typeAnsAnswerFilter(buf: string): Promise<string> {
        if (!this.typeCorrect) {
            return buf.replace(TYPE_ANS_RE, "");
        }
        const orig = buf;
        const origSize = buf.length;
        buf = buf.replace("<hr id=answer>", "");
        const hadHR = buf.length !== origSize;
        const output = (await compareAnswer({
            expected: this.typeCorrect,
            provided: this.typedAnswer ?? "",
            combining: this.combining,
            ignoreCase: this.ignoreCase,
        })).val;
        if (hadHR && !TYPE_ANS_RE.test(buf)) {
            return orig;
        }
        let s = `
<div style="font-family: '${escapeHtml(this.typeFont)}'; font-size: ${this.typeSize}px">${output}</div>`;
        if (hadHR) {
            s = `<hr id=answer>${s}`;
        }
        return buf.replace(TYPE_ANS_RE, () => s);
    }

    // Auto advance
    ////////////////////////////////////////////////////////////////////////

    private clearAutoAdvanceTimers(): void {
        if (this.showAnswerTimer) {
            clearTimeout(this.showAnswerTimer);
            this.showAnswerTimer = null;
        }
        if (this.showQuestionTimer) {
            clearTimeout(this.showQuestionTimer);
            this.showQuestionTimer = null;
        }
    }

    private pendingTimeout: "answer" | "question" | null = null;

    private autoAdvanceToAnswerIfEnabled(): void {
        this.clearAutoAdvanceTimers();
        const secs = this.conf?.secondsToShowQuestion ?? 0;
        if (this.autoAdvanceEnabled && secs) {
            this.showAnswerTimer = setTimeout(() => this.onShowAnswerTimeout(), secs * 1000);
        }
    }

    private autoAdvanceToQuestionIfEnabled(): void {
        this.clearAutoAdvanceTimers();
        const secs = this.conf?.secondsToShowAnswer ?? 0;
        if (this.autoAdvanceEnabled && secs) {
            this.showQuestionTimer = setTimeout(() => this.onShowQuestionTimeout(), secs * 1000);
        }
    }

    private onAvPlayerDidEnd(): void {
        if (this.pendingTimeout === "answer") {
            this.pendingTimeout = null;
            this.onShowAnswerTimeout();
        } else if (this.pendingTimeout === "question") {
            this.pendingTimeout = null;
            this.onShowQuestionTimeout();
        }
    }

    /** Desktop stops auto advance once the main window is not the focused one. */
    private autoAdvanceAllowed(): boolean {
        if (mainWindowBlocked() || !document.hasFocus()) {
            this.autoAdvanceEnabled = false;
            return false;
        }
        return this.autoAdvanceEnabled;
    }

    private onShowAnswerTimeout(): void {
        this.showAnswerTimer = null;
        if (!this.card || !this.autoAdvanceEnabled || this.state !== "question") {
            return;
        }
        if (this.conf?.waitForAudio && avPlayer.isPlaying) {
            this.pendingTimeout = "answer";
            return;
        }
        if (!this.autoAdvanceAllowed()) {
            return;
        }
        if (this.conf?.questionAction === DeckConfig_Config_QuestionAction.SHOW_REMINDER) {
            tooltip(tr.studyingQuestionTimeElapsed());
        } else {
            void this.showAnswer();
        }
    }

    private onShowQuestionTimeout(): void {
        this.showQuestionTimer = null;
        if (!this.card || !this.autoAdvanceEnabled || this.state !== "answer") {
            return;
        }
        if (this.conf?.waitForAudio && avPlayer.isPlaying) {
            this.pendingTimeout = "question";
            return;
        }
        if (!this.autoAdvanceAllowed()) {
            return;
        }
        switch (this.conf?.answerAction ?? DeckConfig_Config_AnswerAction.BURY_CARD) {
            case DeckConfig_Config_AnswerAction.ANSWER_AGAIN:
                void this.answerCard(1);
                break;
            case DeckConfig_Config_AnswerAction.ANSWER_HARD:
                void this.answerCard(2);
                break;
            case DeckConfig_Config_AnswerAction.ANSWER_GOOD:
                void this.answerCard(3);
                break;
            case DeckConfig_Config_AnswerAction.SHOW_REMINDER:
                tooltip(tr.studyingAnswerTimeElapsed());
                break;
            default:
                void this.buryCurrentCard();
        }
    }

    toggleAutoAdvance(): void {
        this.autoAdvanceEnabled = !this.autoAdvanceEnabled;
        tooltip(this.autoAdvanceEnabled ? tr.actionsAutoAdvanceActivated() : tr.actionsAutoAdvanceDeactivated());
        if (this.state === "question") {
            this.autoAdvanceToAnswerIfEnabled();
        } else if (this.state === "answer") {
            this.autoAdvanceToQuestionIfEnabled();
        }
    }

    // Audio
    ////////////////////////////////////////////////////////////////////////

    replayAudio(): void {
        if (!this.rendered) {
            return;
        }
        if (this.state === "question") {
            avPlayer.playTags(this.rendered.questionTags);
        } else if (this.state === "answer") {
            const tags = this.conf?.skipQuestionWhenReplayingAnswer
                ? this.rendered.answerTags
                : [...this.rendered.questionTags, ...this.rendered.answerTags];
            avPlayer.playTags(tags);
        }
    }

    playClicked(cmd: string): void {
        const [, side, idx] = cmd.split(":");
        const tags = side === "q" ? this.rendered?.questionTags : this.rendered?.answerTags;
        const tag = tags?.[Number(idx)];
        if (tag) {
            avPlayer.playTags([tag]);
        }
    }

    async recordVoice(): Promise<void> {
        const { recordAudioBlob } = await import("./actions");
        const blob = await recordAudioBlob();
        if (blob) {
            if (this.recordedAudio) {
                URL.revokeObjectURL(this.recordedAudio);
            }
            this.recordedAudio = URL.createObjectURL(blob);
            this.replayRecorded();
        }
    }

    replayRecorded(): void {
        if (!this.recordedAudio) {
            tooltip(tr.studyingYouHaventRecordedYourVoiceYet());
            return;
        }
        avPlayer.playUrl(this.recordedAudio);
    }

    // Card and note actions
    ////////////////////////////////////////////////////////////////////////

    async setFlag(flag: number): Promise<void> {
        if (!this.card) {
            return;
        }
        const newFlag = (this.card.flags & 0b111) === flag ? 0 : flag;
        await setCardFlag([this.card.id], newFlag);
    }

    async toggleMark(): Promise<void> {
        if (!this.card || !this.rendered) {
            return;
        }
        const note = this.rendered.note;
        const marked = note.tags.some((t) => t.toLowerCase() === MARKED_TAG);
        if (marked) {
            await removeTagsFromNotes([note.id], MARKED_TAG, this);
        } else {
            await addTagsToNotes([note.id], MARKED_TAG, this);
        }
        this.rendered.note = await getNote({ nid: note.id });
        this.drawMark();
    }

    buryCurrentCard(): Promise<void> {
        return this.card ? buryCards([this.card.id]) : Promise.resolve();
    }

    buryCurrentNote(): Promise<void> {
        return this.card ? buryNotes([this.card.noteId]) : Promise.resolve();
    }

    suspendCurrentCard(): Promise<void> {
        return this.card ? suspendCards([this.card.id]) : Promise.resolve();
    }

    suspendCurrentNote(): Promise<void> {
        return this.card ? suspendNotes([this.card.noteId]) : Promise.resolve();
    }

    forgetCurrentCard(): Promise<void> {
        return this.card
            ? forgetCardsDialog([this.card.id], ScheduleCardsAsNewRequest_Context.REVIEWER)
            : Promise.resolve();
    }

    setDue(): Promise<void> {
        return this.card ? setDueDateDialog([this.card.id], SET_DUE_REVIEWER) : Promise.resolve();
    }

    deleteCurrentNote(): Promise<void> {
        return this.card ? removeNotesWithTooltip([this.card.noteId]) : Promise.resolve();
    }

    async contextMenu(): Promise<MenuEntry[]> {
        const { openCardInfo, openPreviousCardInfo, confirmDeckThenDisplayOptions, onCreateCopy } = await import(
            "./actions"
        );
        const currentFlag = (this.card?.flags ?? 0) & 0b111;
        const flags = await allFlags();
        const menu: MenuEntry[] = [
            {
                label: tr.studyingFlagCard(),
                submenu: flags.map((flag) => ({
                    label: flag.label,
                    shortcut: `Ctrl+${flag.index}`,
                    checked: currentFlag === flag.index,
                    action: () => void this.setFlag(flag.index),
                })),
            },
            { label: tr.studyingBuryCard(), shortcut: "-", action: () => void this.buryCurrentCard() },
            {
                label: tr.actionsWithEllipsis({ action: tr.actionsForgetCard() }),
                shortcut: "Ctrl+Alt+N",
                action: () => void this.forgetCurrentCard(),
            },
            {
                label: tr.actionsWithEllipsis({ action: tr.actionsSetDueDate() }),
                shortcut: "Ctrl+Shift+D",
                action: () => void this.setDue(),
            },
            { label: tr.actionsSuspendCard(), shortcut: "@", action: () => void this.suspendCurrentCard() },
            { label: tr.actionsOptions(), shortcut: "O", action: () => this.card && void confirmDeckThenDisplayOptions(this.card) },
            { label: tr.actionsCardInfo(), shortcut: "I", action: () => openCardInfo() },
            { label: tr.actionsPreviousCardInfo(), shortcut: "Ctrl+Alt+I", action: () => openPreviousCardInfo() },
            null,
            { label: tr.studyingMarkNote(), shortcut: "*", action: () => void this.toggleMark() },
            { label: tr.studyingBuryNote(), shortcut: "=", action: () => void this.buryCurrentNote() },
            { label: tr.studyingSuspendNote(), shortcut: "!", action: () => void this.suspendCurrentNote() },
            {
                label: tr.actionsWithEllipsis({ action: tr.actionsCreateCopy() }),
                shortcut: "Ctrl+Alt+E",
                action: () => this.card && void onCreateCopy(this.card),
            },
            {
                label: tr.studyingDeleteNote(),
                shortcut: isMac ? "Ctrl+Backspace" : "Ctrl+Delete",
                action: () => void this.deleteCurrentNote(),
            },
            null,
            { label: tr.actionsReplayAudio(), shortcut: "R", action: () => this.replayAudio() },
            { label: tr.studyingPauseAudio(), shortcut: "5", action: () => avPlayer.togglePause() },
            { label: tr.studyingAudio5s(), shortcut: "6", action: () => avPlayer.seekRelative(-5) },
            { label: tr.studyingAudioAnd5s(), shortcut: "7", action: () => avPlayer.seekRelative(5) },
            { label: tr.studyingRecordOwnVoice(), shortcut: "Shift+V", action: () => void this.recordVoice() },
            { label: tr.studyingReplayOwnVoice(), shortcut: "V", action: () => this.replayRecorded() },
            {
                label: tr.actionsAutoAdvance(),
                shortcut: "Shift+A",
                checked: this.autoAdvanceEnabled,
                action: () => this.toggleAutoAdvance(),
            },
        ];
        hooks.reviewerWillShowContextMenu.run(menu);
        return menu;
    }

    /** Handles bridge commands from the reviewer frame (desktop's _linkHandler). */
    onBridge(cmd: string): unknown {
        if (cmd === "ans") {
            void this.getTypedAnswer();
        } else if (cmd.startsWith("ease")) {
            void this.answerCard(Number(cmd.slice(4)));
        } else if (cmd === "edit") {
            void import("./actions").then((a) => a.onEditCurrent());
        } else if (cmd.startsWith("play:")) {
            this.playClicked(cmd);
        } else if (cmd === "statesMutated") {
            this.onStatesMutated();
        } else if (cmd === "updateToolbar" || cmd === "repaintNeeded") {
            // desktop-only
        } else {
            const [handled, result] = hooks.webviewDidReceiveBridgeCommand.run([false, undefined], cmd, "reviewer");
            if (!handled) {
                console.log("unrecognized anki link:", cmd);
            }
            return result;
        }
        return undefined;
    }

    shortcuts(actions: { onEditCurrent: () => void; showContextMenu: () => void; onOptions: () => void; onCardInfo: () => void; onPreviousCardInfo: () => void; onCreateCopy: () => void; undo: () => void }): Shortcut[] {
        const answerKeys: Shortcut[] = [1, 2, 3, 4]
            .map((ease) => [answerKey(ease), () => void this.answerCard(ease)] as Shortcut)
            .filter(([key]) => !!key);
        return [
            ["e", actions.onEditCurrent],
            [" ", () => this.onEnterKey()],
            ["Enter", () => this.onEnterKey()],
            ["m", actions.showContextMenu],
            ["r", () => this.replayAudio()],
            ["F5", () => this.replayAudio()],
            ...[1, 2, 3, 4, 5, 6, 7].map((flag) => [`Ctrl+${flag}`, () => void this.setFlag(flag)] as Shortcut),
            ["*", () => void this.toggleMark()],
            ["=", () => void this.buryCurrentNote()],
            ["-", () => void this.buryCurrentCard()],
            ["!", () => void this.suspendCurrentNote()],
            ["@", () => void this.suspendCurrentCard()],
            ["Ctrl+Alt+N", () => void this.forgetCurrentCard()],
            ["Ctrl+Alt+E", actions.onCreateCopy],
            [isMac ? "Ctrl+Backspace" : "Ctrl+Delete", () => void this.deleteCurrentNote()],
            ["Ctrl+Shift+D", () => void this.setDue()],
            ["v", () => this.replayRecorded()],
            ["Shift+v", () => void this.recordVoice()],
            ["o", actions.onOptions],
            ["i", actions.onCardInfo],
            ["Ctrl+Alt+i", actions.onPreviousCardInfo],
            ...answerKeys,
            ["u", actions.undo],
            ["5", () => avPlayer.togglePause()],
            ["6", () => avPlayer.seekRelative(-5)],
            ["7", () => avPlayer.seekRelative(5)],
            ["Shift+A", () => this.toggleAutoAdvance()],
        ];
    }

    /** The card shown before the current one, for "previous card info". */
    lastCardId(): bigint | null {
        const last = this.answeredIds[this.answeredIds.length - 1];
        return last !== undefined && last !== this.card?.id ? last : null;
    }

    /** Elapsed answer time, for the timer. */
    timeTaken(): number {
        return Date.now() - this.timerStarted;
    }
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

let showDueCounts = true;
let estimateTimes = true;

/** Reads the collection settings the reviewer uses (and desktop's apply_collection_options). */
export async function loadReviewerSettings(): Promise<void> {
    const reviewing = (await getPreferences({}).catch(() => null))?.reviewing;
    hidePlayButtons = reviewing?.hideAudioPlayButtons ?? false;
    showDueCounts = reviewing?.showRemainingDueCounts ?? true;
    estimateTimes = reviewing?.showIntervalsOnButtons ?? true;
    avPlayer.interruptCurrentAudio = reviewing?.interruptAudioWhenAnswering ?? true;
}

export function answerKey(ease: number): string {
    const keys = getProfileConfig<Record<string, string>>("answerKeys", {});
    return keys[String(ease)] ?? String(ease);
}

export function spacebarRatesCard(): boolean {
    return getProfileConfig<boolean>("spacebarRatesCard", true);
}

export const reviewer = new Reviewer();

export function registerReviewerFrontendMethods(): void {
    registerFrontendMethod("getSchedulingStatesWithContext", () => reviewer.schedulingStatesWithContext().toBinary());
    registerFrontendMethod("setSchedulingStates", (input) => {
        reviewer.setSchedulingStates(SetSchedulingStatesRequest.fromBinary(input));
        return new Empty().toBinary();
    });
}
