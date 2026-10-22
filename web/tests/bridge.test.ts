// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// @ts-nocheck: run with `bun test web/tests`; bun:test has no types in this repo

import { describe, expect, test } from "bun:test";

import { BridgeDir } from "../src/lib/engine/bridge";
import { WasiError } from "../src/lib/engine/errno";

const NOENT = 44;

/** Stands in for the IO worker: a folder of files, whose full listing can be made to fail. */
class FakeClient {
    files = new Map<string, { size: number; mtimeMs: number }>();
    statDirFailures = 0;

    constructor(count: number) {
        for (let i = 0; i < count; i++) {
            this.files.set(`f${i}.jpg`, { size: 100 + i, mtimeMs: 1000 + i });
        }
    }

    async list() {
        return [...this.files.keys()].map((name) => ({ name, size: NaN, mtimeMs: NaN, dir: false }));
    }

    async readJson() {
        return null;
    }

    statDir() {
        if (this.statDirFailures > 0) {
            this.statDirFailures--;
            throw new WasiError(29, "unreadable file");
        }
        return [...this.files].map(([name, s]) => [name, s.size, s.mtimeMs]);
    }

    callJson(req) {
        if (req.op === "statFile") {
            const stat = this.files.get(req.name);
            if (!stat) {
                throw new WasiError(NOENT);
            }
            return { ...stat };
        }
        if (req.op === "rename") {
            const stat = this.files.get(req.name)!;
            this.files.delete(req.name);
            return { ...stat };
        }
        throw new Error(`unexpected ${req.op}`);
    }

    call() {
        return { payload: new Uint8Array(), total: 0 };
    }
}

/** The size and time the media scan sees for each file, or the error it gets. */
function scan(dir: BridgeDir): (string | [number, number])[] {
    return dir.names().map((name) => {
        try {
            const file = dir.get(name);
            return [file.size(), file.mtimeMs];
        } catch (err) {
            return err instanceof WasiError ? `errno ${err.errno}` : String(err);
        }
    });
}

describe("BridgeDir", () => {
    test("a failed full listing is retried, and never makes files look empty", async () => {
        const client = new FakeClient(40);
        const dir = await BridgeDir.open(client, ["media"]);
        client.statDirFailures = 1;
        const first = scan(dir);
        // 32 read one by one, then the listing that fails
        expect(first.slice(0, 32).every((r) => Array.isArray(r))).toBe(true);
        expect(first[32]).toBe("errno 29");
        // nothing is ever reported as an empty (deleted) file
        expect(first.some((r) => Array.isArray(r) && r[0] === 0)).toBe(false);
        // the next scan lists the folder again and sees every file as it is
        const second = scan(dir);
        expect(second).toEqual([...client.files.values()].map((s) => [s.size, s.mtimeMs]));
    });

    test("the folder time is not taken from a failed listing", async () => {
        const client = new FakeClient(5);
        const dir = await BridgeDir.open(client, ["media"]);
        client.statDirFailures = 1;
        expect(() => dir.mtimeMs).toThrow();
        expect(dir.mtimeMs).toBe(1004);
    });

    test("a file gone from OPFS fails instead of counting as empty", async () => {
        const client = new FakeClient(40);
        const dir = await BridgeDir.open(client, ["media"]);
        const file = dir.get("f39.jpg");
        client.files.delete("f39.jpg");
        scan(dir);
        expect(() => file.size()).toThrow(WasiError);
    });

    test("a file moved into a listed folder keeps its size", async () => {
        const client = new FakeClient(3);
        const src = await BridgeDir.open(client, ["src"]);
        const dest = await BridgeDir.open(client, ["media"]);
        // the destination's full listing has been read already
        dest.mtimeMs;
        client.files.set("f0.jpg", { size: 555, mtimeMs: 2000 });
        src.moveWithin("f0.jpg", dest, "moved.jpg");
        const moved = dest.get("moved.jpg");
        expect(moved.size()).toBe(555);
    });
});
