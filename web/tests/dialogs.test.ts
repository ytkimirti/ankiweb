// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// @ts-nocheck: run with `bun test web/tests`; bun:test has no types in this repo

import { describe, expect, mock, test } from "bun:test";
import { get } from "svelte/store";

// the generated translations are not resolvable here, and these tests need none
mock.module("@generated/ftl", () => new Proxy({}, { get: () => () => "" }));
const { dialogs, openDialog } = await import("../src/lib/app/dialogs");

const request = { text: "waiting", buttons: [{ label: "Abort", value: "abort" }] };

describe("openDialog with a signal", () => {
    test("aborting closes it as dismissed", async () => {
        const controller = new AbortController();
        const result = openDialog(request, controller.signal);
        expect(get(dialogs).length).toBe(1);
        controller.abort();
        expect(await result).toEqual({ button: null });
        expect(get(dialogs).length).toBe(0);
    });

    test("an aborted signal never shows it", async () => {
        const controller = new AbortController();
        controller.abort();
        expect(await openDialog(request, controller.signal)).toEqual({ button: null });
        expect(get(dialogs).length).toBe(0);
    });

    test("answering it first wins, and a later abort changes nothing", async () => {
        const controller = new AbortController();
        const result = openDialog(request, controller.signal);
        get(dialogs)[0].resolve({ button: "abort" });
        controller.abort();
        expect(await result).toEqual({ button: "abort" });
        expect(get(dialogs).length).toBe(0);
    });
});
