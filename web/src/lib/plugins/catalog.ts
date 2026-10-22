// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Plugins bundled with the app: web-native rebuilds of popular desktop
 * add-ons (web/src/plugins). They are built into the app and cached with it,
 * so they work offline, and are installed from Tools > Add-ons as
 * "builtin:<id>".
 */

import type { Plugin } from "./loader";

export const BUILTIN_PREFIX = "builtin:";

export interface CatalogEntry {
    id: string;
    name: string;
    description: string;
    /** The desktop add-on it is rebuilt from, on AnkiWeb. */
    ankiwebId: number;
    load: () => Promise<{ default: Plugin }>;
}

export const catalog: CatalogEntry[] = [
    {
        id: "review-heatmap",
        name: "Review Heatmap",
        description: "A calendar of your reviews and upcoming cards, with streaks, on the deck list and overview.",
        ankiwebId: 1771074083,
        load: () => import("../../plugins/review-heatmap"),
    },
    {
        id: "custom-background",
        name: "Custom Background Image and Gear Icon",
        description: "Sets your own background picture for the main screens and reviewer, and your own deck gear icon.",
        ankiwebId: 1210908941,
        load: () => import("../../plugins/custom-background"),
    },
    {
        id: "advanced-browser",
        name: "Advanced Browser",
        description:
            "More browser columns: first and last review, review times, overdue interval, note fields and more.",
        ankiwebId: 874215009,
        load: () => import("../../plugins/advanced-browser"),
    },
    {
        id: "contanki",
        name: "Contanki: Controller Support",
        description: "Review and move around with a game controller.",
        ankiwebId: 1898790263,
        load: () => import("../../plugins/contanki"),
    },
    {
        id: "button-colours",
        name: "Button Colours (Good, Again)",
        description: "Colours the answer buttons: Again red, Hard orange, Good green, Easy blue.",
        ankiwebId: 2494384865,
        load: () => import("../../plugins/button-colours"),
    },
    {
        id: "mini-format-pack",
        name: "Mini Format Pack",
        description:
            "Editor buttons for code, preformatted text, strikethrough, abbreviations, lines, lists and alignment.",
        ankiwebId: 295889520,
        load: () => import("../../plugins/mini-format-pack"),
    },
    {
        id: "customize-shortcuts",
        name: "Customize Keyboard Shortcuts",
        description: "Change or turn off the keyboard shortcuts of the main window and the reviewer.",
        ankiwebId: 24411424,
        load: () => import("../../plugins/customize-shortcuts"),
    },
    {
        id: "syntax-highlighting",
        name: "Syntax Highlighting for Code",
        description: "An editor button that pastes code with syntax highlighting, in many languages.",
        ankiwebId: 1463041493,
        load: () => import("../../plugins/syntax-highlighting"),
    },
    {
        id: "batch-editing",
        name: "Batch Editing",
        description: "Adds text before or after a field, or replaces it, in all the notes selected in the browser.",
        ankiwebId: 291119185,
        load: () => import("../../plugins/batch-editing"),
    },
    {
        id: "edit-field-during-review",
        name: "Edit Field During Review (Cloze)",
        description: "Edit a field right on the card while reviewing, with {{edit:Field}} in the card template.",
        ankiwebId: 385888438,
        load: () => import("../../plugins/edit-field-during-review"),
    },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
    return catalog.find((entry) => entry.id === id);
}
