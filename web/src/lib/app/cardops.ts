// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** Card and note operations shared by the reviewer and browser (aqt.operations). */

import { ConfigKey_String } from "@generated/anki/config_pb";
import {
    BuryOrSuspendCardsRequest_Mode,
    CardAnswer_Rating,
    ScheduleCardsAsNewRequest_Context,
} from "@generated/anki/scheduler_pb";
import {
    addNoteTags,
    buryOrSuspendCards,
    getConfigJson,
    getConfigString,
    gradeNow,
    removeNotes,
    removeNoteTags,
    repositionDefaults,
    restoreBuriedAndSuspendedCards,
    scheduleCardsAsNew,
    scheduleCardsAsNewDefaults,
    setDueDate,
    setFlag,
    sortCards,
} from "@generated/backend";
import * as tr from "@generated/ftl";

import { getText, openForm, tooltip } from "./dialogs";
import { runOp } from "./run";

export const MARKED_TAG = "marked";

export interface Flag {
    index: number;
    label: string;
    color: string;
}

const defaultFlagLabels = () => [
    tr.actionsFlagRed(),
    tr.actionsFlagOrange(),
    tr.actionsFlagGreen(),
    tr.actionsFlagBlue(),
    tr.actionsFlagPink(),
    tr.actionsFlagTurquoise(),
    tr.actionsFlagPurple(),
];

/** The seven flags, with any names the user gave them (desktop's FlagManager). */
export async function allFlags(): Promise<Flag[]> {
    let custom: Record<string, string> = {};
    try {
        const json = await getConfigJson({ val: "flagLabels" }, { alertOnError: false });
        custom = JSON.parse(new TextDecoder().decode(json.json)) ?? {};
    } catch {
        // not set
    }
    return defaultFlagLabels().map((label, i) => ({
        index: i + 1,
        label: custom[String(i + 1)] || label,
        color: `var(--flag-${i + 1})`,
    }));
}

export function setCardFlag(cardIds: bigint[], flag: number): Promise<unknown> {
    return runOp(() => setFlag({ cardIds, flag }));
}

export async function suspendCards(cardIds: bigint[]): Promise<void> {
    if (await runOp(() => buryOrSuspendCards({ cardIds, noteIds: [], mode: BuryOrSuspendCardsRequest_Mode.SUSPEND }))) {
        tooltip(tr.studyingCardSuspended());
    }
}

export async function suspendNotes(noteIds: bigint[]): Promise<void> {
    if (await runOp(() => buryOrSuspendCards({ cardIds: [], noteIds, mode: BuryOrSuspendCardsRequest_Mode.SUSPEND }))) {
        tooltip(tr.studyingNoteSuspended());
    }
}

export function unsuspendCards(cardIds: bigint[]): Promise<unknown> {
    return runOp(() => restoreBuriedAndSuspendedCards({ cids: cardIds }));
}

export async function buryCards(cardIds: bigint[]): Promise<void> {
    const out = await runOp(() =>
        buryOrSuspendCards({ cardIds, noteIds: [], mode: BuryOrSuspendCardsRequest_Mode.BURY_USER })
    );
    if (out) {
        tooltip(tr.studyingCardsBuried({ count: out.count }));
    }
}

export async function buryNotes(noteIds: bigint[]): Promise<void> {
    const out = await runOp(() =>
        buryOrSuspendCards({ cardIds: [], noteIds, mode: BuryOrSuspendCardsRequest_Mode.BURY_USER })
    );
    if (out) {
        tooltip(tr.studyingCardsBuried({ count: out.count }));
    }
}

export async function forgetCardsDialog(
    cardIds: bigint[],
    context?: ScheduleCardsAsNewRequest_Context,
): Promise<void> {
    let restorePosition = true;
    let resetCounts = false;
    if (context !== undefined) {
        const defaults = await runOp(() => scheduleCardsAsNewDefaults({ context }));
        if (defaults) {
            ({ restorePosition, resetCounts } = defaults);
        }
    }
    const values = await openForm([
        { key: "restore", label: tr.schedulingRestorePosition(), type: "checkbox", value: restorePosition },
        { key: "reset", label: tr.schedulingResetCounts(), type: "checkbox", value: resetCounts },
    ], { title: tr.actionsForgetCard() });
    if (!values) {
        return;
    }
    if (
        await runOp(() =>
            scheduleCardsAsNew({
                cardIds,
                log: true,
                restorePosition: !!values.restore,
                resetCounts: !!values.reset,
                context,
            })
        )
    ) {
        tooltip(tr.schedulingForgotCards({ cards: cardIds.length }));
    }
}

export async function setDueDateDialog(cardIds: bigint[], configKey?: ConfigKey_String): Promise<void> {
    if (!cardIds.length) {
        return;
    }
    const defaultText = configKey !== undefined
        ? (await runOp(() => getConfigString({ key: configKey })))?.val ?? ""
        : "";
    const prompt = [tr.schedulingSetDueDatePrompt({ cards: cardIds.length }), tr.schedulingSetDueDatePromptHint()].join(
        "\n",
    );
    const days = await getText(prompt, { value: defaultText, title: tr.actionsSetDueDate() });
    if (!days?.trim()) {
        return;
    }
    if (await runOp(() => setDueDate({ cardIds, days, configKey: configKey !== undefined ? { key: configKey } : undefined }))) {
        tooltip(tr.schedulingSetDueDateDone({ cards: cardIds.length }));
    }
}

export const SET_DUE_REVIEWER = ConfigKey_String.SET_DUE_REVIEWER;
export const SET_DUE_BROWSER = ConfigKey_String.SET_DUE_BROWSER;

export async function repositionDialog(cardIds: bigint[], range: { min: number; max: number }): Promise<void> {
    const defaults = await runOp(() => repositionDefaults({}));
    const values = await openForm([
        { key: "start", label: tr.browsingStartPosition(), type: "number", value: 0, min: -20_000_000, max: 200_000_000 },
        { key: "step", label: tr.browsingStep(), type: "number", value: 1, min: 1, max: 10_000 },
        { key: "random", label: tr.browsingRandomizeOrder(), type: "checkbox", value: defaults?.random ?? false },
        { key: "shift", label: tr.browsingShiftPositionOfExistingCards(), type: "checkbox", value: defaults?.shift ?? false },
    ], {
        title: tr.actionsReposition(),
        text: `${tr.browsingQueueTop({ val: range.min })}\n${tr.browsingQueueBottom({ val: range.max })}`,
    });
    if (!values) {
        return;
    }
    const out = await runOp(() =>
        sortCards({
            cardIds,
            startingFrom: Number(values.start),
            stepSize: Number(values.step),
            randomize: !!values.random,
            shiftExisting: !!values.shift,
        })
    );
    if (out) {
        tooltip(tr.browsingChangedNewPosition({ count: out.count }));
    }
}

export async function removeNotesWithTooltip(noteIds: bigint[]): Promise<void> {
    const out = await runOp(() => removeNotes({ noteIds, cardIds: [] }));
    if (out) {
        tooltip(tr.browsingCardsDeleted({ count: out.count }));
    }
}

export function addTagsToNotes(noteIds: bigint[], tags: string): Promise<unknown> {
    return runOp(() => addNoteTags({ noteIds, tags }));
}

export function removeTagsFromNotes(noteIds: bigint[], tags: string): Promise<unknown> {
    return runOp(() => removeNoteTags({ noteIds, tags }));
}

export async function gradeNowWithTooltip(cardIds: bigint[], ease: number): Promise<void> {
    const rating = [CardAnswer_Rating.AGAIN, CardAnswer_Rating.HARD, CardAnswer_Rating.GOOD, CardAnswer_Rating.EASY][
        ease - 1
    ];
    if (await runOp(() => gradeNow({ cardIds, rating }))) {
        tooltip(tr.schedulingGradedCardsDone({ cards: cardIds.length }));
    }
}
