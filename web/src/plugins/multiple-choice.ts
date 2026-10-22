// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Multiple Choice for Anki, AnkiWeb 1566095810: brings the original's
 * "AllInOne (kprim, mc, sc)" note type, whose card templates (from the
 * add-on, by 3ter and zjosua, AGPL) ask kprim, multiple choice and single
 * choice questions: the answers are ticked on the front, and the back shows
 * them against the right ones, coloured. The note type is added when a
 * profile opens if it is missing, and Config rewrites the templates' options
 * (resetting them to the add-on's, as the original does), keeping a question
 * row for every Q_n field.
 */

import { get } from "svelte/store";

import type { Plugin, PluginApi } from "$web/plugins/loader";

import { addNotetype, notetypeIdByName, updateNotetype, withEntries } from "./shared/notetypes";

export const NOTETYPE_NAME = "AllInOne (kprim, mc, sc)";
export const FIELDS = [
    "Question",
    "Title",
    "QType (0=kprim,1=mc,2=sc)",
    "Q_1",
    "Q_2",
    "Q_3",
    "Q_4",
    "Q_5",
    "Answers",
    "Sources",
    "Extra 1",
];
const QUESTION_ID = /^Q_(\d+)$/;
const DEFAULT_QUESTIONS = 5;

export interface Config {
    answerColoring: "DEFAULT_COLORING" | "ALTERNATE_COLORING";
    colorQuestionTable: boolean;
    colorAnswerTable: boolean;
    hideAnswerTable: boolean;
    maxQuestionsToShow: number;
}

export const DEFAULTS: Config = {
    answerColoring: "DEFAULT_COLORING",
    colorQuestionTable: false,
    colorAnswerTable: true,
    hideAnswerTable: false,
    maxQuestionsToShow: 0,
};

/** The original's getOptionsJavaScriptFromConfig. */
export function optionsScript(config: Config, side: "front" | "back"): string {
    const colors = config.answerColoring === "ALTERNATE_COLORING" ? "ALTERNATE_COLORING" : "DEFAULT_COLORING";
    if (side === "front") {
        return `const OPTIONS = {\n    maxQuestionsToShow: ${Math.max(0, Math.floor(config.maxQuestionsToShow) || 0)}\n};\n`;
    }
    return "const OPTIONS = {\n"
        + "    qtable: {\n"
        + "        visible: true,\n"
        + `        colorize: ${config.colorQuestionTable},\n`
        + `        colors: ${colors}\n`
        + "    },\n"
        + "    atable: {\n"
        + `        visible: ${!config.hideAnswerTable},\n`
        + `        colorize: ${config.colorAnswerTable},\n`
        + `        colors: ${colors}\n`
        + "    }\n"
        + "};\n";
}

/** Replaces a template's first OPTIONS block, as the original's re.sub. */
export function withOptions(template: string, options: string): string {
    return template.replace(/const OPTIONS[\s\S]*?;/, () => options);
}

function questionDiv(name: string): string {
    return `<div class="hidden" id="${name}">{{${name}}}</div>`;
}

/** The original's get_front_template_with_removed_field. */
export function withoutQuestion(template: string, name: string): string {
    return template.replace(`${questionDiv(name)}\n`, "");
}

/** The original's get_front_template_with_added_field. */
export function withQuestion(template: string, name: string): string {
    const number = Number(QUESTION_ID.exec(name)?.[1]);
    const previous = questionDiv(`Q_${number - 1}`);
    const at = template.indexOf(previous);
    if (at > 0) {
        const end = at + previous.length;
        return `${template.slice(0, end)}\n${questionDiv(name)}${template.slice(end)}`;
    }
    return `${questionDiv(name)}\n${template}`;
}

/** The original's adjust_number_of_question_fields: a question row for each Q_n field. */
export function adjustQuestions(front: string, fieldNames: string[]): string {
    const count = fieldNames.filter((name) => QUESTION_ID.test(name)).length;
    let out = front;
    for (let i = DEFAULT_QUESTIONS + 1; i <= count; i++) {
        out = withQuestion(out, `Q_${i}`);
    }
    for (let i = count + 1; i <= DEFAULT_QUESTIONS; i++) {
        out = withoutQuestion(out, `Q_${i}`);
    }
    return out;
}

async function templates(): Promise<{ front: string; back: string; css: string }> {
    const [front, back, css] = await Promise.all([
        import("./assets/multiple-choice/front.html?raw"),
        import("./assets/multiple-choice/back.html?raw"),
        import("./assets/multiple-choice/css.css?raw"),
    ]);
    return { front: front.default, back: back.default, css: css.default };
}

async function addModel(api: PluginApi): Promise<void> {
    if (await notetypeIdByName(api, NOTETYPE_NAME)) {
        return;
    }
    const sources = await templates();
    await addNotetype(api, false, (nt) => {
        nt.name = NOTETYPE_NAME;
        nt.sortf = 0;
        nt.flds = withEntries(nt.flds[0], FIELDS);
        nt.tmpls = withEntries(nt.tmpls[0], [NOTETYPE_NAME], () => ({ qfmt: sources.front, afmt: sources.back }));
        nt.css = sources.css;
    });
    api.main.reset();
}

/** The original's updateTemplate, minus re-adding deleted non-question fields (a schema change). */
async function updateTemplate(api: PluginApi, config: Config): Promise<boolean> {
    const ntid = await notetypeIdByName(api, NOTETYPE_NAME);
    if (!ntid) {
        return false;
    }
    const { front, back, css } = await templates();
    const changed = await updateNotetype(api, ntid, (nt) => {
        const template = nt.tmpls[0];
        if (!template) {
            return;
        }
        template.qfmt = adjustQuestions(
            withOptions(front, optionsScript(config, "front")),
            nt.flds.map((f) => f.name),
        );
        template.afmt = withOptions(back, optionsScript(config, "back"));
        nt.css = css;
    });
    if (changed) {
        api.main.reset();
    }
    return true;
}

export default {
    name: "Multiple Choice",
    setup(api) {
        const config = (): Config => ({ ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) });
        let adding: Promise<void> | null = null;
        const maybeAdd = () => {
            adding ??= addModel(api)
                .catch((err) => console.error("multiple choice", err))
                .finally(() => (adding = null));
        };
        api.hooks.profileDidOpen.append(maybeAdd);
        if (["deckBrowser", "overview", "review"].includes(get(api.main.mainState))) {
            maybeAdd();
        }

        api.setConfigAction(async () => {
            const c = config();
            const values = await api.dialogs.openForm(
                [
                    {
                        key: "answerColoring",
                        label: "Answer colouring",
                        type: "select",
                        value: c.answerColoring,
                        options: [
                            { value: "DEFAULT_COLORING", label: "Rows ticked or left unticked correctly green, others red" },
                            { value: "ALTERNATE_COLORING", label: "Only falsely ticked rows red, rows that should have been ticked green" },
                        ],
                    },
                    { key: "colorQuestionTable", label: "Colour the table with your chosen answers", type: "checkbox", value: c.colorQuestionTable },
                    { key: "colorAnswerTable", label: "Colour the table with the correct answers", type: "checkbox", value: c.colorAnswerTable },
                    { key: "hideAnswerTable", label: "Only show the table with your chosen answers", type: "checkbox", value: c.hideAnswerTable },
                    {
                        key: "maxQuestionsToShow",
                        label: "Questions to show (0: all of the card's)",
                        type: "number",
                        value: c.maxQuestionsToShow,
                        min: 0,
                        max: 100,
                    },
                ],
                {
                    title: "Multiple Choice",
                    text: `Saving resets the templates of the "${NOTETYPE_NAME}" note type to the add-on's, with these options.`,
                },
            );
            if (!values) {
                return;
            }
            const next: Config = {
                ...c,
                ...values,
                maxQuestionsToShow: Math.max(0, Math.floor(Number(values.maxQuestionsToShow)) || 0),
            } as Config;
            api.setConfig(next);
            await adding;
            if (!(await updateTemplate(api, next))) {
                await addModel(api);
                await updateTemplate(api, next);
            }
        });
    },
} satisfies Plugin;

