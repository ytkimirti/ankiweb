// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// @ts-nocheck: run with `bun test web/tests`; bun:test has no types in this repo

import { describe, expect, test } from "bun:test";

import { Pool } from "../src/lib/engine/pool";

/** In-memory stand-ins for OPFS handles; files persist across Pool.open calls. */
class FakeSyncHandle {
    constructor(public file: { data: Uint8Array }) {}
    getSize(): number {
        return this.file.data.length;
    }
    read(out: Uint8Array, { at }: { at: number }): number {
        const chunk = this.file.data.subarray(at, at + out.length);
        out.set(chunk);
        return chunk.length;
    }
    write(data: Uint8Array, { at }: { at: number }): number {
        if (at + data.length > this.file.data.length) {
            const grown = new Uint8Array(at + data.length);
            grown.set(this.file.data);
            this.file.data = grown;
        }
        this.file.data.set(data, at);
        return data.length;
    }
    truncate(size: number): void {
        const next = new Uint8Array(size);
        next.set(this.file.data.subarray(0, size));
        this.file.data = next;
    }
    flush(): void {}
    close(): void {}
}

class FakeDir {
    files = new Map<string, { data: Uint8Array }>();
    async *entries(): AsyncGenerator<[string, unknown]> {
        for (const name of this.files.keys()) {
            yield [name, this.handle(name)];
        }
    }
    async getFileHandle(name: string, _opts?: { create?: boolean }): Promise<unknown> {
        if (!this.files.has(name)) {
            this.files.set(name, { data: new Uint8Array() });
        }
        return this.handle(name);
    }
    private handle(name: string) {
        const file = this.files.get(name)!;
        return { kind: "file", createSyncAccessHandle: async () => new FakeSyncHandle(file) };
    }
}

const open = (dir: FakeDir) => Pool.open(dir as unknown as FileSystemDirectoryHandle);
const text = (s: string) => new TextEncoder().encode(s);
function contents(pool: Pool, path: string): string {
    const file = pool.file(path)!;
    const out = new Uint8Array(file.size());
    file.read(0, out);
    return new TextDecoder().decode(out);
}

describe("pool", () => {
    test("lookups of one file share an identity, a new file gets another", async () => {
        const pool = await open(new FakeDir());
        pool.create("/p/a").write(0, text("x"));
        expect(pool.file("/p/a")!.identity).toBe(pool.file("/p/a")!.identity);
        const before = pool.file("/p/a")!.identity;
        pool.rename("/p/a", "/p/b");
        expect(pool.file("/p/b")!.identity).toBe(before);
        pool.remove("/p/b");
        pool.create("/p/b");
        expect(pool.file("/p/b")!.identity).not.toBe(before);
    });

    test("rename over a file replaces it and survives reopening", async () => {
        const dir = new FakeDir();
        const pool = await open(dir);
        pool.create("/p/old").write(0, text("old"));
        pool.create("/p/new").write(0, text("new"));
        pool.rename("/p/new", "/p/old");
        expect(pool.has("/p/new")).toBe(false);
        expect(contents(pool, "/p/old")).toBe("new");
        const reopened = await open(dir);
        expect(reopened.paths().sort()).toEqual(["/p/old"]);
        expect(contents(reopened, "/p/old")).toBe("new");
    });

    test("two slots claiming a path after a crash keep the newer", async () => {
        const dir = new FakeDir();
        const pool = await open(dir);
        pool.create("/p/col").write(0, text("old"));
        pool.create("/p/tmp").write(0, text("new"));
        // simulate a crash after the moved header was written but before
        // the old target was cleared: copy the old slot back in afterwards
        const oldSlot = [...dir.files.entries()].find(([, f]) => new TextDecoder().decode(f.data).includes("/p/col"))!;
        const saved = oldSlot[1].data.slice();
        pool.rename("/p/tmp", "/p/col");
        oldSlot[1].data = saved;
        const reopened = await open(dir);
        expect(reopened.paths().filter((p) => p === "/p/col").length).toBe(1);
        expect(contents(reopened, "/p/col")).toBe("new");
    });

    test("renameUnder moves nothing when a new path is too long", async () => {
        const pool = await open(new FakeDir());
        pool.create("/p/a/x");
        pool.create("/p/a/y");
        expect(() => pool.renameUnder("/p/a", `/p/${"z".repeat(5000)}`)).toThrow();
        expect(pool.paths().sort()).toEqual(["/p/a/x", "/p/a/y"]);
    });
});
