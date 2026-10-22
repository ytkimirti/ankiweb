// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// @ts-nocheck: run with `bun test web/tests`; bun:test has no types in this repo

import { describe, expect, mock, test } from "bun:test";

// the @generated alias is not resolvable here; point it at the generated modules
for (const name of ["scheduler_pb", "search_pb", "notetypes_pb"]) {
    const real = await import(`../../out/ts/lib/generated/anki/${name}.js`);
    mock.module(`@generated/anki/${name}`, () => real);
}
const { answerCss, cssString, DEFAULTS: ARBB_DEFAULTS, easeBorderColor, loadConfig } = await import(
    "../src/plugins/advanced-review-bottombar"
);
const { printPage, stripTypeAnswer } = await import("../src/plugins/basic-printing");
const { addCounts, emptyCounts, isEnded, withLater } = await import("../src/plugins/enhance-main-window");
const { frontWithOptions, maybeAddConfigOption, olderVersion, optionsFromFront, templateVersion, updatedFront } =
    await import("../src/plugins/enhanced-cloze");
const { lengthClass } = await import("../src/plugins/fill-the-blanks");
const { adjustQuestions, DEFAULTS: MC_DEFAULTS, optionsScript, withOptions } = await import(
    "../src/plugins/multiple-choice"
);
const { stripClozes } = await import("../src/plugins/popup-dictionary");
const { barText, DEFAULTS: PB_DEFAULTS, remaining, SessionProgress } = await import("../src/plugins/progress-bar");
const { formatCountdown } = await import("../src/plugins/speed-focus-mode");
const { DEFAULT_SYMBOLS, matchKeyword, matchList, parseSymbols } = await import("../src/plugins/symbols-as-you-type");

describe("Progress Bar", () => {
    test("remaining weighs the counts, and new cards only after reviews if asked", () => {
        const counts = { newCount: 3, learnCount: 2, reviewCount: 5 };
        expect(remaining(counts, PB_DEFAULTS)).toBe(5 + 2 + 6);
        const noNew = { ...PB_DEFAULTS, includeNew: false, includeNewAfterReviews: true };
        expect(remaining(counts, noNew)).toBe(7);
        expect(remaining({ ...counts, reviewCount: 0 }, noNew)).toBe(2 + 6);
    });

    test("session progress keeps the total and counts what is done", () => {
        const p = new SessionProgress();
        p.update(1n, 10, false);
        p.update(1n, 7, false);
        expect(p.values([1n])).toEqual({ done: 3, total: 10 });
        // more cards turned up
        p.update(1n, 9, false);
        expect(p.values([1n])).toEqual({ done: 3, total: 12 });
        p.update(1n, 4, true);
        expect(p.values([1n])).toEqual({ done: 3, total: 7 });
        p.update(2n, 5, false);
        expect(p.values([1n, 2n])).toEqual({ done: 3, total: 12 });
    });

    test("bar text", () => {
        const all = { showNumber: true, showPercent: true, showLeftCards: true, showLeftTime: true };
        expect(barText(1500, 3000, 1500, 12, all)).toBe("1,500 / 3,000 (50%) | left 1,500 cards | left 12 min");
        expect(barText(0, 0, 0, null, { ...all, showNumber: false })).toBe("100% | left 0 cards");
    });
});

describe("Basic Printing", () => {
    test("strips type-answer boxes and lays out rows", () => {
        expect(stripTypeAnswer("a[[type:Back]]b")).toBe("ab");
        const page = printPage(["1", "2", "3"], 2, "https://x/");
        expect(page.match(/<tr>/g)?.length).toBe(2);
        expect(page).toContain("<base href=\"https://x/\">");
        expect(page).toContain("<td width=\"50%\"><center>3</center></td>");
    });
});

describe("Fill the blanks", () => {
    test("box widths follow the original", () => {
        expect(lengthClass("abc", "")).toBe("ftb-xs");
        expect(lengthClass("abcdefg", "")).toBe("ftb-sm");
        expect(lengthClass("a", "a hint of fifteen")).toBe("ftb-md");
        expect(lengthClass("x".repeat(21), "")).toBe("ftb-lg");
    });
});

describe("Symbols As You Type", () => {
    test("the default list has the Greek letters without final sigma", () => {
        const map = new Map(DEFAULT_SYMBOLS);
        expect(map.get(":alpha:")).toBe("α");
        expect(map.get(":sigma:")).toBe("σ");
        expect(map.get(":omega:")).toBe("ω");
        expect(map.get(":Sigma:")).toBe("Σ");
        expect(map.get(":Omega:")).toBe("Ω");
    });

    test("matches keys at the caret, longest first, plain keys only after a space", () => {
        const list = matchList([["->", "→"], ["--", "‒"], ["---", "—"], ["teh", "the"], ["::b::", "<b>b</b>"]]);
        expect(list[0].key).toBe("::b::");
        expect(list.find((e) => e.key === "::b::").f).toBe(2);
        expect(list.find((e) => e.key === "->").f).toBe(1);
        expect(list.find((e) => e.key === "teh").f).toBe(0);
        expect(matchKeyword(list, "a ->", 4, false).val).toBe("→");
        expect(matchKeyword(list, "a ---", 5, true).val).toBe("—");
        expect(matchKeyword(list, "a---", 4, true)).toBeNull();
        expect(matchKeyword(list, "x teh", 5, false)).toBeNull();
        expect(matchKeyword(list, "x teh", 5, true).val).toBe("the");
        expect(matchKeyword(list, "xteh", 4, true)).toBeNull();
    });

    test("parses the settings text", () => {
        expect(parseSymbols(":a: α\n\n:b:  β β").symbols).toEqual([[":a:", "α"], [":b:", "β β"]]);
        expect(parseSymbols(":a:\n:b: x\n:b: y").errors.length).toBe(2);
    });
});

describe("Pop-up Dictionary", () => {
    test("strips clozes", () => {
        expect(stripClozes("a {{c1::b}} {{c2::c::hint}}")).toBe("a b c");
    });
});

describe("Speed Focus Mode", () => {
    test("countdown", () => {
        expect(formatCountdown(65)).toBe("1:05");
        expect(formatCountdown(-3)).toBe("0:00");
    });
});

describe("Advanced Review Bottombar", () => {
    test("config merges nested records", () => {
        const c = loadConfig({ labels: { again: "Nope" } });
        expect(c.labels.again).toBe("Nope");
        expect(c.labels.good).toBe(ARBB_DEFAULTS.labels.good);
        expect(c.buttonStyle).toBe(ARBB_DEFAULTS.buttonStyle);
    });

    test("CSS strings are escaped", () => {
        expect(cssString("a\"b\\c\nd")).toBe("\"a\\\"b\\\\c\\a d\"");
    });

    test("ease border colours", () => {
        const thresholds = [200, 250, 300, 350];
        const colors = ["r", "o", "g", "b"];
        expect(easeBorderColor(0, 2500, thresholds, colors)).toBeNull();
        expect(easeBorderColor(2, 1300, thresholds, colors)).toBe("r");
        expect(easeBorderColor(2, 2500, thresholds, colors)).toBe("g");
        expect(easeBorderColor(2, 4000, thresholds, colors)).toBe("#7000A8");
    });

    test("answer styles are scoped to the theme", () => {
        expect(answerCss(ARBB_DEFAULTS, false)).toContain(":root:not(.night-mode) .reviewer-bar");
        expect(answerCss(ARBB_DEFAULTS, true)).toContain(".night-mode .reviewer-bar");
    });
});

describe("Enhance main window", () => {
    test("counts add up, flags included", () => {
        const a = emptyCounts();
        const b = emptyCounts();
        b.cards = 3;
        b.flags[2] = 1;
        addCounts(a, b);
        addCounts(a, b);
        expect(a.cards).toBe(6);
        expect(a.flags[2]).toBe(2);
    });

    test("end symbols and later counts", () => {
        const symbols = { endSymbol: ";", givenUpSymbol: "/", pauseSymbol: "=" };
        expect(isEnded("Lang::French;", symbols)).toBe(true);
        expect(isEnded("Lang;::French", symbols)).toBe(false);
        expect(isEnded("Lang::French", symbols)).toBe(false);
        expect(withLater(3, 0)).toBe("3");
        expect(withLater(3, 4)).toBe("3 (4)");
    });
});

describe("Multiple Choice", () => {
    const front = "<script>\nconst OPTIONS = {\n    maxQuestionsToShow: 0\n};\n</script>\n"
        + "<div class=\"hidden\" id=\"Q_1\">{{Q_1}}</div>\n"
        + "<div class=\"hidden\" id=\"Q_2\">{{Q_2}}</div>\n"
        + "<div class=\"hidden\" id=\"Q_3\">{{Q_3}}</div>\n"
        + "<div class=\"hidden\" id=\"Q_4\">{{Q_4}}</div>\n"
        + "<div class=\"hidden\" id=\"Q_5\">{{Q_5}}</div>\n";

    test("rewrites the options blocks", () => {
        const out = withOptions(front, optionsScript({ ...MC_DEFAULTS, maxQuestionsToShow: 3 }, "front"));
        expect(out).toContain("maxQuestionsToShow: 3");
        expect(out).not.toContain("maxQuestionsToShow: 0");
        const back = optionsScript({ ...MC_DEFAULTS, hideAnswerTable: true, answerColoring: "ALTERNATE_COLORING" }, "back");
        expect(back).toContain("visible: false");
        expect(back).toContain("colors: ALTERNATE_COLORING");
    });

    test("a question row for each Q_n field", () => {
        const fewer = adjustQuestions(front, ["Question", "Q_1", "Q_2", "Q_3"]);
        expect(fewer).not.toContain("{{Q_4}}");
        expect(fewer).not.toContain("{{Q_5}}");
        const more = adjustQuestions(front, ["Q_1", "Q_2", "Q_3", "Q_4", "Q_5", "Q_6", "Q_7"]);
        expect(more).toContain("{{Q_5}}</div>\n<div class=\"hidden\" id=\"Q_6\">{{Q_6}}</div>\n<div class=\"hidden\" id=\"Q_7\">");
    });
});

describe("Enhanced Cloze", () => {
    const front = "<!-- VERSION 1.14 -->\n<script>\n    var scrollToClozeOnToggle = true\n    var shortcut = \"J\"\n</script>\n"
        + "<!-- CONFIG END -->\nbody\n<!-- ENHANCED_CLOZE -->\nold";

    test("versions", () => {
        expect(templateVersion(front)).toEqual([1, 14]);
        expect(templateVersion("x")).toBeNull();
        expect(olderVersion([1, 9], [1, 14])).toBe(true);
        expect(olderVersion([1, 14], [1, 14])).toBe(false);
    });

    test("reads and writes the options", () => {
        expect(optionsFromFront(front)).toEqual({ scrollToClozeOnToggle: true, shortcut: "J" });
        const out = frontWithOptions(front, { scrollToClozeOnToggle: false, shortcut: "Shift+\"J" });
        expect(out).toContain("<script>\nvar scrollToClozeOnToggle=false\nvar shortcut=\"Shift+\\\"J\"\n</script>\n<!-- CONFIG END -->");
        expect(frontWithOptions("no config", {})).toBeNull();
    });

    test("updates keep the options and add new ones", () => {
        const incoming = "<!-- VERSION 1.15 -->\n<script>\nvar a = 1\n</script>\n<!-- CONFIG END -->\nnew body\n"
            + "<!-- ENHANCED_CLOZE -->\nnew";
        const out = updatedFront(front, incoming);
        expect(out.startsWith("<!-- VERSION 1.15 -->\n<script>\n    var scrollToClozeOnToggle = true\n")).toBe(true);
        expect(out).toContain("    var animateScroll = true\n");
        expect(out.endsWith("body\n<!-- ENHANCED_CLOZE -->\nnew")).toBe(true);
        expect(maybeAddConfigOption(out, "animateScroll", "var animateScroll = true", "x")).toBe(out);
    });
});
