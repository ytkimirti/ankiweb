// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Insert Symbols As You Type, AnkiWeb 2040501954: typing a key such as
 * ":alpha:" or "->" in the editor turns it into its symbol (α, →). Keys
 * between colons, and the arrows ->, <-, => and <=, are replaced as soon as
 * they are typed; other keys when followed by a space or Enter, if they start
 * a word; keys between double colons ("::key::") insert HTML. It works in
 * the editor's fields, the browser's search box and fields edited on a card
 * (Edit Field During Review). Tools > Insert Symbols edits the list, which
 * starts as the original's. The original keeps the list in the collection,
 * so it syncs; here it is kept with the app's settings.
 */

import type { Plugin, PluginApi } from "$web/plugins/loader";

export type Symbols = [key: string, value: string][];

/** A match list entry: f is 2 for HTML, 1 for keys replaced at once, 0 for keys replaced after a space. */
export interface MatchEntry {
    key: string;
    val: string;
    f: 0 | 1 | 2;
}

const SPECIAL_KEYS = ["->", "<-", "=>", "<="];

const ARROWS: Symbols = [
    ["->", "→"], ["=>", "⇒"], ["<-", "←"], ["<=", "⇐"],
    [":N:", "↑"], [":N2:", "⇑"], [":S:", "↓"], [":S2:", "⇓"],
    [":E:", "→"], [":E2:", "⇒"], [":W:", "←"], [":W2:", "⇐"],
];
const TYPOGRAPHY: Symbols = [
    ["--", "‒"], ["---", "—"], [":dagger:", "†"], [":ddagger:", "‡"],
    [":section:", "§"], [":paragraph:", "¶"],
];
const MATH: Symbols = [
    [":infty:", "∞"], [":deg:", "°"], [":permil:", "‰"], [":sqrt:", "√"],
    [":cubert:", "∛"], [":4thrt:", "∜"], [":angle:", "∠"], [":hbar:", "ℏ"],
    [":pm:", "±"], [":mp:", "∓"], [":dot:", "·"], [":times:", "×"], [":div:", "÷"],
    [":approx:", "≈"], [":equiv:", "≡"], [":propto:", "∝"], [":neq:", "≠"],
    [":geq:", "≥"], [":leq:", "≤"], [":>>:", "≫"], [":<<:", "≪"],
    [":subset:", "⊂"], [":subseteq:", "⊆"], [":supset:", "⊃"], [":supseteq:", "⊇"],
    [":in:", "∈"], [":ni:", "∋"], [":cap:", "∩"], [":cup:", "∪"], [":emptyset:", "∅"],
    [":neg:", "¬"], [":vee:", "∨"], [":wedge:", "∧"], [":forall:", "∀"],
    [":exists:", "∃"], [":therefore:", "∴"],
    [":nabla:", "∇"], [":partial:", "∂"], [":integral:", "∫"],
];
const FRACTIONS: Symbols = [
    [":1/2:", "½"], [":1/3:", "⅓"], [":2/3:", "⅔"], [":1/4:", "¼"], [":3/4:", "¾"],
    [":1/5:", "⅕"], [":2/5:", "⅖"], [":3/5:", "⅗"], [":4/5:", "⅘"], [":1/6:", "⅙"],
    [":5/6:", "⅚"], [":1/7:", "⅐"], [":1/8:", "⅛"], [":3/8:", "⅜"], [":5/8:", "⅝"],
    [":7/8:", "⅞"], [":1/9:", "⅑"], [":1/10:", "⅒"],
];
const GREEK_NAMES = [
    "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu",
    "nu", "xi", "omicron", "pi", "rho", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega",
];
/** α is U+03B1 and Α U+0391; both skip U+03C2 / U+03A2 (final sigma, unassigned) after rho. */
const greek = (upper: boolean): Symbols =>
    GREEK_NAMES.map((name, i) => {
        const code = (upper ? 0x391 : 0x3b1) + i + (i >= 17 ? 1 : 0);
        const key = upper ? name[0].toUpperCase() + name.slice(1) : name;
        return [`:${key}:`, String.fromCharCode(code)];
    });
const CURRENCY: Symbols = [
    [":cent:", "¢"], [":pound:", "£"], [":euro:", "€"], [":lira:", "₤"], [":peso:", "₱"],
    [":ruble:", "₽"], [":rupee:", "₹"], [":won:", "₩"], [":yen:", "¥"], [":yuan:", "¥"],
];

export const DEFAULT_SYMBOLS: Symbols = [
    ...ARROWS,
    ...TYPOGRAPHY,
    ...MATH,
    ...FRACTIONS,
    ...greek(false),
    ...greek(true),
    ...CURRENCY,
];

/** The match list, longest keys first (the original's get_match_list). */
export function matchList(symbols: Symbols): MatchEntry[] {
    return [...symbols]
        .sort((a, b) => b[0].length - a[0].length)
        .map(([key, val]) => ({
            key,
            val,
            f: key.startsWith("::") && key.endsWith("::")
                ? 2
                : (key.startsWith(":") && key.endsWith(":")) || SPECIAL_KEYS.includes(key)
                ? 1
                : 0,
        }));
}

/**
 * The entry whose key ends at `end` in `text` (the original's
 * matchesKeyword). Self-contained, as it is also sent to card frames.
 */
export function matchKeyword(
    list: MatchEntry[],
    text: string,
    end: number,
    whitespacePressed: boolean,
): MatchEntry | null {
    for (const entry of list) {
        const onSpace = entry.f === 0;
        if (onSpace && !whitespacePressed) {
            continue;
        }
        const start = end - entry.key.length;
        if (start < 0 || text.substring(start, end) !== entry.key) {
            continue;
        }
        if (onSpace && start > 0 && !/\s/.test(text[start - 1])) {
            continue;
        }
        return entry;
    }
    return null;
}

/** Parses the settings text, one "key value" a line; returns the list or the problems. */
export function parseSymbols(text: string): { symbols: Symbols; errors: string[] } {
    const symbols: Symbols = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    text.split("\n").forEach((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }
        const match = trimmed.match(/^(\S+)\s+(.+)$/);
        if (!match) {
            errors.push(`Line ${i + 1}: "${trimmed}" needs a key and a symbol`);
            return;
        }
        if (seen.has(match[1])) {
            errors.push(`Line ${i + 1}: "${match[1]}" is listed twice`);
            return;
        }
        seen.add(match[1]);
        symbols.push([match[1], match[2]]);
    });
    return { symbols, errors };
}

/**
 * Listens for keys in contenteditable fields under `doc` (fields in shadow
 * roots too) and replaces keys before the caret. Self-contained, as it also
 * runs in card frames. Returns a function that stops it.
 */
function watchEditables(doc: Document, list: MatchEntry[], match: typeof matchKeyword): () => void {
    let checkOnKeyup = false;
    const editableOf = (event: Event): HTMLElement | null => {
        const target = event.composedPath()[0];
        return target instanceof doc.defaultView!.HTMLElement && target.isContentEditable ? target : null;
    };
    const check = (el: HTMLElement, whitespace: boolean) => {
        const root = el.getRootNode() as Document | (ShadowRoot & { getSelection?: () => Selection | null });
        const selection = ("getSelection" in root && root.getSelection ? root.getSelection() : null) ?? doc.getSelection();
        if (!selection || !selection.isCollapsed || !selection.focusNode) {
            return;
        }
        const entry = match(list, selection.focusNode.textContent ?? "", selection.focusOffset, whitespace);
        if (!entry) {
            return;
        }
        for (let i = 0; i < entry.key.length; i++) {
            doc.execCommand("delete", false);
        }
        doc.execCommand(entry.f === 2 ? "insertHTML" : "insertText", false, entry.val);
    };
    const onKeyDown = (event: KeyboardEvent) => {
        const el = editableOf(event);
        if (!el || event.ctrlKey || event.metaKey || event.isComposing) {
            return;
        }
        if (event.key === " " || event.key === "Enter") {
            check(el, true);
        } else {
            checkOnKeyup = true;
        }
    };
    const onKeyUp = (event: KeyboardEvent) => {
        const el = editableOf(event);
        if (el && checkOnKeyup) {
            checkOnKeyup = false;
            check(el, false);
        }
    };
    doc.addEventListener("keydown", onKeyDown, true);
    doc.addEventListener("keyup", onKeyUp, true);
    return () => {
        doc.removeEventListener("keydown", onKeyDown, true);
        doc.removeEventListener("keyup", onKeyUp, true);
    };
}

/** Runs in card frames, once per frame, with the list kept up to date. */
function cardScript(list: MatchEntry[], match: typeof matchKeyword, watch: typeof watchEditables): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    if (w.__symbolsAsYouType) {
        w.__symbolsAsYouType.splice(0, Infinity, ...list);
        return;
    }
    w.__symbolsAsYouType = list;
    watch(document, list, match);
}

/** The browser's search box (the original's BrowserReplacer). */
function watchSearchBox(list: () => MatchEntry[]): () => void {
    const isSearch = (target: EventTarget | null): target is HTMLInputElement =>
        target instanceof HTMLInputElement && target.matches(".browser input.search");
    const replace = (input: HTMLInputElement, whitespace: boolean) => {
        const end = input.selectionStart ?? input.value.length;
        if (end !== input.selectionEnd) {
            return;
        }
        const entry = matchKeyword(list(), input.value, end, whitespace);
        if (!entry || entry.f === 2) {
            return;
        }
        const start = end - entry.key.length;
        input.value = input.value.slice(0, start) + entry.val + input.value.slice(end);
        input.setSelectionRange(start + entry.val.length, start + entry.val.length);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const onKeyDown = (event: KeyboardEvent) => {
        if (isSearch(event.target) && !event.ctrlKey && !event.metaKey && (event.key === " " || event.key === "Enter")) {
            replace(event.target, true);
        }
    };
    const onInput = (event: Event) => {
        if (isSearch(event.target) && !(event as InputEvent).isComposing && (event as InputEvent).inputType?.startsWith("insert")) {
            replace(event.target, false);
        }
    };
    addEventListener("keydown", onKeyDown, true);
    addEventListener("input", onInput, true);
    return () => {
        removeEventListener("keydown", onKeyDown, true);
        removeEventListener("input", onInput, true);
    };
}

async function editSymbols(api: PluginApi, current: Symbols): Promise<Symbols | null> {
    let text = current.map(([k, v]) => `${k} ${v}`).join("\n");
    for (;;) {
        const values = await api.dialogs.openForm(
            [
                { key: "text", label: "Symbols, one a line: the key, a space, then the symbol", type: "textarea", value: text, rows: 16 },
                { key: "reset", label: "Reset to the default list", type: "checkbox", value: false },
            ],
            {
                title: "Insert Symbols",
                text: "Keys between colons (:alpha:) and the arrows ->, <-, => and <= are replaced as you type them; "
                    + "other keys after a space. Keys between double colons (::key::) insert HTML.",
            },
        );
        if (!values) {
            return null;
        }
        if (values.reset) {
            return DEFAULT_SYMBOLS;
        }
        text = String(values.text);
        const { symbols, errors } = parseSymbols(text);
        if (!errors.length) {
            return symbols;
        }
        await api.dialogs.showWarning(errors.slice(0, 10).join("\n"));
    }
}

export default {
    name: "Insert Symbols As You Type",
    setup(api) {
        const symbols = (): Symbols => api.getConfig<{ symbols?: Symbols }>({}).symbols ?? DEFAULT_SYMBOLS;
        /** One array, changed in place, so the listeners see a new list. */
        const list = matchList(symbols());
        const update = (next: Symbols) => list.splice(0, Infinity, ...matchList(next));

        const stops: (() => void)[] = [];
        const watched = new WeakSet<Document>();
        const watch = (frame: Window) => {
            const doc = frame.document;
            if (!watched.has(doc)) {
                watched.add(doc);
                stops.push(watchEditables(doc, list, matchKeyword));
            }
        };
        // every editor (add, edit current, browser) sets up its shortcuts
        api.hooks.editorDidInitShortcuts.append((_shortcuts, editor) => watch(editor.frame));
        api.hooks.editorDidLoadNote.append(watch);
        stops.push(watchSearchBox(() => list));
        api.onUnload(() => stops.forEach((stop) => stop()));

        // fields edited on a card (Edit Field During Review)
        api.hooks.cardWillShow.append((html, _card, kind) => {
            if (!kind.startsWith("review") || !/data-efdrc-field|contenteditable/i.test(html)) {
                return html;
            }
            return `${html}<script>(${cardScript.toString()})(${JSON.stringify(list)}, ${matchKeyword.toString()}, ${
                watchEditables.toString()
            });</script>`;
        });

        const configure = async () => {
            const next = await editSymbols(api, symbols());
            if (next) {
                api.setConfig({ symbols: next });
                update(next);
            }
        };
        api.setConfigAction(configure);
        api.hooks.mainMenuWillShow.append((sections) => {
            (sections.find((s) => s.title.replace(/&/g, "") === "Tools") ?? sections[3])?.items.push({
                label: "Insert Symbols...",
                action: () => void configure(),
            });
        });
    },
} satisfies Plugin;
