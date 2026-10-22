// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// @ts-nocheck: run with `bun test web/tests`; bun:test has no types in this repo

import { describe, expect, test } from "bun:test";

import { Hook } from "../src/lib/plugins/hooks";
import { PluginRegistry } from "../src/lib/plugins/registry";
import { combine } from "../src/plugins/batch-editing";
import { EditAccess } from "../src/plugins/edit-field-during-review";

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

describe("edit field during review access", () => {
    const html = (field: string, nid: bigint) => `<div data-efdrc-field="${field}" data-efdrc-nid="${nid}">x</div>`;

    test("only fields the reviewer showed can be loaded, on the current card", () => {
        const access = new EditAccess();
        access.wrap(1n, "Front");
        access.wrap(1n, "Back");
        expect(access.show(1n, 10n, html("Front", 10n), true)).toBe(true);
        expect(access.canLoad(1n, "10", "Front")).toBe(true);
        // wrapped but not on the side shown
        expect(access.canLoad(1n, "10", "Back")).toBe(false);
        expect(access.canLoad(2n, "10", "Front")).toBe(false);
        expect(access.canLoad(1n, "11", "Front")).toBe(false);
    });

    test("html a card adds itself grants nothing the filter did not wrap", () => {
        const access = new EditAccess();
        access.wrap(1n, "Front");
        expect(access.show(1n, 10n, html("Front", 10n) + html("Back", 10n) + html("Front", 99n), true)).toBe(true);
        expect(access.saveTarget("10", "Back")).toBe(null);
        expect(access.saveTarget("99", "Front")).toBe(null);
    });

    test("previews grant nothing", () => {
        const access = new EditAccess();
        access.wrap(5n, "Front");
        expect(access.saveTarget("50", "Front")).toBe(null);
    });

    test("an edit begun on the question can be saved after the answer shows", () => {
        const access = new EditAccess();
        access.wrap(1n, "Front");
        access.show(1n, 10n, html("Front", 10n), true);
        expect(access.show(1n, 10n, "answer without the field", false)).toBe(false);
        expect(access.saveTarget("10", "Front")).toBe(10n);
    });

    test("saves reach the current and previous card only", () => {
        const access = new EditAccess();
        for (const id of [1n, 2n, 3n]) {
            access.wrap(id, "Front");
            access.show(id, id * 10n, html("Front", id * 10n), true);
        }
        expect(access.saveTarget("30", "Front")).toBe(30n);
        expect(access.saveTarget("20", "Front")).toBe(20n);
        expect(access.saveTarget("10", "Front")).toBe(null);
        // a card without editable fields still moves the others back
        access.show(4n, 40n, "plain", true);
        expect(access.saveTarget("20", "Front")).toBe(null);
    });

    test("field names are unescaped", () => {
        const access = new EditAccess();
        access.wrap(1n, `Say "hi"`);
        access.show(1n, 10n, html("Say &#34;hi&#34;", 10n), true);
        expect(access.canLoad(1n, "10", `Say "hi"`)).toBe(true);
    });
});

describe("PluginRegistry", () => {
    const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    /** A plugin whose setup adds a "hook" to `live` and returns how to remove it. */
    function plugin(name: string, live: Set<string>, wait = 0) {
        return {
            name,
            async setup(api) {
                await later(wait);
                live.add(name);
                api.disposers.push(() => live.delete(name));
            },
        };
    }
    function registry(modules: Record<string, (r) => object>, timeoutMs = 1000) {
        const r = new PluginRegistry({
            apiFor: (record) => record,
            importModule: async (url) => modules[url](r),
            timeoutMs,
            unloadableByDefault: () => true,
        });
        return r;
    }

    test("removing a module while its other plugins start stops them all", async () => {
        const live = new Set<string>();
        const a = plugin("a", live), b = plugin("b", live), c = plugin("c", live, 30);
        const r = registry({
            m: (r) => {
                r.capture(a);
                r.capture(b);
                r.capture(c);
                return {};
            },
        });
        const loading = r.load("m");
        await later(10);
        const unloading = r.unload("m");
        await loading;
        expect(await unloading).toBe(true);
        expect([...live]).toEqual([]);
        expect(r.loaded.size).toBe(0);
    });

    test("enabling again brings back what a cached module registered", async () => {
        const live = new Set<string>();
        const a = plugin("a", live), b = plugin("b", live);
        let imports = 0;
        const r = registry({
            m: (r) => {
                // a cached module runs no code the second time
                if (imports++ === 0) {
                    r.capture(a);
                    r.capture(b);
                }
                return {};
            },
        });
        await r.load("m");
        await r.unload("m");
        expect([...live]).toEqual([]);
        await r.load("m");
        expect([...live].sort()).toEqual(["a", "b"]);
    });

    test("a default export comes first and registered ones run with it", async () => {
        const live = new Set<string>();
        const main = plugin("main", live), extra = plugin("extra", live);
        const r = registry({
            m: (r) => {
                r.capture(extra);
                return { default: main };
            },
        });
        await r.load("m");
        expect([...r.loaded.keys()]).toEqual(["m", "m\n1"]);
        await r.unload("m");
        expect([...live]).toEqual([]);
    });

    test("a setup that takes too long fails, and is undone when it finishes", async () => {
        const live = new Set<string>();
        const slow = plugin("slow", live, 40);
        const r = registry({ m: () => ({ default: slow }) }, 10);
        await expect(r.load("m")).rejects.toThrow("took too long");
        expect(r.loaded.size).toBe(0);
        await later(60);
        expect([...live]).toEqual([]);
    });

    test("a setup that takes too long and then fails is undone", async () => {
        const live = new Set<string>();
        const r = registry({
            m: () => ({
                default: {
                    name: "bad",
                    async setup(api) {
                        await later(20);
                        live.add("bad");
                        api.disposers.push(() => live.delete("bad"));
                        throw new Error("broken");
                    },
                },
            }),
        }, 5);
        await expect(r.load("m")).rejects.toThrow("took too long");
        await later(40);
        expect([...live]).toEqual([]);
    });

    test("a plugin a setup registers starts after it, on its own", async () => {
        const live = new Set<string>();
        const sub = plugin("sub", live);
        const r = registry({
            m: (r) => ({
                default: {
                    name: "main",
                    async setup(api) {
                        // as loader.ts's registerGlobal: not waited for
                        void r.register(sub, "manual:sub");
                        live.add("main");
                        api.disposers.push(() => live.delete("main"));
                    },
                },
            }),
        }, 200);
        await r.load("m");
        await r.unload("m");
        expect([...live]).toEqual(["sub"]);
        expect([...r.loaded.keys()]).toEqual(["manual:sub"]);
        await r.unload("manual:sub");
        expect([...live]).toEqual([]);
    });

    test("registering under a taken key replaces the plugin, in turn", async () => {
        const live = new Set<string>();
        const r = registry({});
        const first = r.register(plugin("one", live, 20), "k");
        const second = r.register(plugin("two", live), "k");
        await Promise.all([first, second]);
        expect([...live]).toEqual(["two"]);
        await r.unload("k");
        expect([...live]).toEqual([]);
    });

    test("capture is false outside an import", () => {
        const r = registry({});
        expect(r.capture({ name: "x", setup() {} })).toBe(false);
    });
});
