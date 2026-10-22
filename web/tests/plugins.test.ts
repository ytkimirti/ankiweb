// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// @ts-nocheck: run with `bun test web/tests`; bun:test has no types in this repo

import { describe, expect, test } from "bun:test";

import { Hook } from "../src/lib/plugins/hooks";
import { combine } from "../src/plugins/batch-editing";

describe("Hook", () => {
    test("runAsync waits for each listener in turn", async () => {
        const hook = new Hook<[string[]]>();
        hook.append(async (out) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            out.push("slow");
        });
        hook.append((out) => void out.push("fast"));
        const out: string[] = [];
        await hook.runAsync(out);
        expect(out).toEqual(["slow", "fast"]);
    });

    test("a failing listener does not stop the others", async () => {
        const hook = new Hook<[string[]]>();
        hook.append(() => {
            throw new Error("broken");
        });
        hook.append(async () => {
            throw new Error("broken");
        });
        hook.append((out) => void out.push("ran"));
        const out: string[] = [];
        hook.run(out);
        await hook.runAsync(out);
        expect(out).toEqual(["ran", "ran"]);
    });

    test("append returns a remover", () => {
        const hook = new Hook<[]>();
        const remove = hook.append(() => {});
        remove();
        expect(hook.count()).toBe(0);
    });
});

describe("batch editing", () => {
    test("plain text goes on a new line", () => {
        expect(combine("old", "new\nline", "after", false)).toBe("old<br/>new<br/>line");
        expect(combine("old", "new", "before", false)).toBe("new<br/>old");
    });

    test("no extra break where the field already breaks", () => {
        expect(combine("old<br>", "new", "after", false)).toBe("old<br>new");
        expect(combine("<div>old</div>", "new", "before", false)).toBe("new<div>old</div>");
    });

    test("html is added as it is, on a new source line", () => {
        expect(combine("old", "<b>new</b>", "after", true)).toBe("old\n<b>new</b>");
        expect(combine("old\n", "<b>new</b>", "after", true)).toBe("old\n<b>new</b>");
    });

    test("replace", () => {
        expect(combine("old", "a\nb", "replace", false)).toBe("a<br/>b");
        expect(combine("old", "a\nb", "replace", true)).toBe("a\nb");
    });
});
