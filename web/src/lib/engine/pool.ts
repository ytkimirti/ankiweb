// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Files that need fast synchronous access (the collection and media
 * databases, their journals and temp files beside them) live in a pool of
 * OPFS files whose sync access handles are opened up front. OPFS can only
 * open files asynchronously, so the pool keeps spare slots ready, and the
 * engine tops it up between backend calls.
 *
 * Each slot file starts with a header holding the virtual path it stores and
 * its mtime; the file data follows.
 */

import { Errno, fail } from "./errno";
import { now, type VDir, type VFile, type VNode } from "./vfs";

const HEADER = 4096;
const MAGIC = "ANKIPL01";
const MIN_FREE = 8;
const MAX_PATH = HEADER - 24;

interface Slot {
    name: string;
    handle: FileSystemSyncAccessHandle;
    path: string;
    mtimeMs: number;
    /** Bumped when the slot is freed, so stale descriptors stop touching it. */
    gen: number;
    /** Replaced when the slot is freed; the file's identity for inode numbers. */
    identity: object;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Opens a slot, waiting a few seconds if it is still held: after a reload the
 * old page's engine worker can outlive it briefly, mid media sync say.
 */
async function openWhenFree(fh: FileSystemFileHandle): Promise<FileSystemSyncAccessHandle> {
    for (let attempt = 1;; attempt++) {
        try {
            return await fh.createSyncAccessHandle();
        } catch (err) {
            if ((err as DOMException)?.name !== "NoModificationAllowedError" || attempt >= 50) {
                throw err;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
}

export class Pool {
    private slots: Slot[] = [];
    private byPath = new Map<string, Slot>();
    private nextId = 0;

    private constructor(private dir: FileSystemDirectoryHandle) {}

    static async open(dir: FileSystemDirectoryHandle): Promise<Pool> {
        const pool = new Pool(dir);
        for await (const [name, handle] of dir.entries()) {
            if (handle.kind !== "file" || !name.startsWith("slot-")) {
                continue;
            }
            const id = parseInt(name.slice(5), 10);
            pool.nextId = Math.max(pool.nextId, id + 1);
            const sah = await openWhenFree(handle as FileSystemFileHandle);
            const slot: Slot = { name, handle: sah, path: "", mtimeMs: 0, gen: 0, identity: {} };
            pool.readHeader(slot);
            pool.slots.push(slot);
            if (!slot.path) {
                continue;
            }
            // A crash during rename can leave two slots claiming one path;
            // the moved file is the newer one.
            const other = pool.byPath.get(slot.path);
            if (other && other.mtimeMs > slot.mtimeMs) {
                pool.clear(slot);
                continue;
            }
            if (other) {
                pool.clear(other);
            }
            pool.byPath.set(slot.path, slot);
        }
        await pool.topUp();
        return pool;
    }

    /** Ensures enough free slots exist for files created during the next call. */
    async topUp(): Promise<void> {
        let free = this.slots.filter((s) => !s.path).length;
        while (free < MIN_FREE) {
            const name = `slot-${this.nextId++}`;
            const fh = await this.dir.getFileHandle(name, { create: true });
            const handle = await fh.createSyncAccessHandle();
            const slot: Slot = { name, handle, path: "", mtimeMs: 0, gen: 0, identity: {} };
            this.clear(slot);
            this.slots.push(slot);
            free++;
        }
    }

    close(): void {
        for (const slot of this.slots) {
            slot.handle.flush();
            slot.handle.close();
        }
        this.slots = [];
        this.byPath.clear();
    }

    paths(): string[] {
        return [...this.byPath.keys()];
    }

    has(path: string): boolean {
        return this.byPath.has(path);
    }

    file(path: string): PoolFile | undefined {
        const slot = this.byPath.get(path);
        return slot ? new PoolFile(this, slot) : undefined;
    }

    create(path: string): PoolFile {
        const existing = this.byPath.get(path);
        if (existing) {
            return new PoolFile(this, existing);
        }
        const slot = this.slots.find((s) => !s.path);
        if (!slot) {
            fail(Errno.NOSPC, "file pool exhausted");
        }
        slot.path = path;
        slot.mtimeMs = now();
        slot.handle.truncate(HEADER);
        this.writeHeader(slot);
        this.byPath.set(path, slot);
        return new PoolFile(this, slot);
    }

    remove(path: string): void {
        const slot = this.byPath.get(path);
        if (!slot) {
            fail(Errno.NOENT);
        }
        this.byPath.delete(path);
        this.clear(slot);
    }

    rename(from: string, to: string): void {
        const slot = this.byPath.get(from);
        if (!slot) {
            fail(Errno.NOENT);
        }
        if (from === to) {
            return;
        }
        // Persist the moved header before dropping the old target, so a crash
        // in between leaves the new file rather than neither.
        const target = this.byPath.get(to);
        this.byPath.delete(from);
        slot.path = to;
        slot.mtimeMs = Math.max(now(), (target?.mtimeMs ?? 0) + 1);
        this.writeHeader(slot);
        slot.handle.flush();
        if (target) {
            this.clear(target);
        }
        this.byPath.set(to, slot);
    }

    /** Removes every file under a folder, or those whose path below it `which` picks. */
    removeUnder(dir: string, which: (rest: string) => boolean = () => true): void {
        for (const path of this.paths()) {
            if (path.startsWith(`${dir}/`) && which(path.slice(dir.length + 1))) {
                this.remove(path);
            }
        }
    }

    /** Moves every file under one folder to another; nothing moves if any new path is too long. */
    renameUnder(from: string, to: string): void {
        const moves = this.paths()
            .filter((path) => path.startsWith(`${from}/`))
            .map((path) => [path, to + path.slice(from.length)] as const);
        if (moves.some(([, dest]) => encoder.encode(dest).length > MAX_PATH)) {
            fail(Errno.INVAL, "path too long");
        }
        for (const [path, dest] of moves) {
            this.rename(path, dest);
        }
    }

    /** @internal */
    writeHeader(slot: Slot): void {
        const header = new Uint8Array(HEADER);
        const view = new DataView(header.buffer);
        header.set(encoder.encode(MAGIC), 0);
        const path = encoder.encode(slot.path);
        if (path.length > MAX_PATH) {
            fail(Errno.INVAL, "path too long");
        }
        view.setUint32(8, path.length, true);
        view.setFloat64(12, slot.mtimeMs, true);
        header.set(path, 24);
        slot.handle.write(header, { at: 0 });
    }

    private readHeader(slot: Slot): void {
        const header = new Uint8Array(HEADER);
        const n = slot.handle.read(header, { at: 0 });
        if (n < 24 || decoder.decode(header.subarray(0, 8)) !== MAGIC) {
            this.clear(slot);
            return;
        }
        const view = new DataView(header.buffer);
        const len = view.getUint32(8, true);
        slot.mtimeMs = view.getFloat64(12, true);
        slot.path = decoder.decode(header.subarray(24, 24 + len));
    }

    private clear(slot: Slot): void {
        slot.gen++;
        slot.identity = {};
        slot.path = "";
        slot.mtimeMs = 0;
        slot.handle.truncate(HEADER);
        this.writeHeader(slot);
        slot.handle.flush();
    }
}

/**
 * A descriptor's view of a slot. Once the file is unlinked the view is
 * detached: reads return nothing and writes are dropped, matching what the
 * module could observe of an unlinked file closely enough for SQLite and
 * tempfile, which only unlink files they are done with.
 */
export class PoolFile implements VFile {
    readonly kind = "file";
    private dirtyMtime = false;
    private gen: number;
    readonly identity: object;

    constructor(private pool: Pool, private slot: Slot) {
        this.gen = slot.gen;
        this.identity = slot.identity;
    }

    private get live(): boolean {
        return this.gen === this.slot.gen;
    }

    get mtimeMs(): number {
        return this.slot.mtimeMs;
    }

    set mtimeMs(value: number) {
        this.slot.mtimeMs = value;
        this.dirtyMtime = true;
    }

    size(): number {
        return this.live ? Math.max(0, this.slot.handle.getSize() - HEADER) : 0;
    }

    read(pos: number, out: Uint8Array): number {
        return this.live ? this.slot.handle.read(out, { at: HEADER + pos }) : 0;
    }

    write(pos: number, data: Uint8Array): number {
        if (!this.live) {
            return data.length;
        }
        const n = this.slot.handle.write(data, { at: HEADER + pos });
        this.slot.mtimeMs = now();
        this.dirtyMtime = true;
        return n;
    }

    truncate(size: number): void {
        if (!this.live) {
            return;
        }
        this.slot.handle.truncate(HEADER + size);
        this.slot.mtimeMs = now();
        this.dirtyMtime = true;
    }

    flush(): void {
        if (!this.live) {
            return;
        }
        if (this.dirtyMtime) {
            this.pool.writeHeader(this.slot);
            this.dirtyMtime = false;
        }
        this.slot.handle.flush();
    }

    release(): void {
        this.flush();
    }
}

/**
 * A directory whose files live in the pool. Child directories can only be
 * mounted (the profile folder mounts its media and backup folders).
 */
export class PoolDir implements VDir {
    readonly kind = "dir";
    mtimeMs = now();
    private mounts = new Map<string, VNode>();

    constructor(private pool: Pool, private path: string) {}

    mount(name: string, node: VNode): void {
        this.mounts.set(name, node);
    }

    private childPath(name: string): string {
        return `${this.path}/${name}`;
    }

    names(): string[] {
        const prefix = `${this.path}/`;
        const files = this.pool
            .paths()
            .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
            .map((p) => p.slice(prefix.length));
        return [...files, ...this.mounts.keys()];
    }

    get(name: string): VNode | undefined {
        return this.mounts.get(name) ?? this.pool.file(this.childPath(name));
    }

    createFile(name: string): VFile {
        if (this.mounts.has(name)) {
            fail(Errno.ISDIR);
        }
        this.mtimeMs = now();
        return this.pool.create(this.childPath(name));
    }

    mkdir(): VDir {
        fail(Errno.NOTSUP, "subfolders are not supported here");
    }

    unlink(name: string): void {
        if (this.mounts.has(name)) {
            fail(Errno.ISDIR);
        }
        this.pool.remove(this.childPath(name));
        this.mtimeMs = now();
    }

    rmdir(name: string): void {
        fail(this.mounts.has(name) ? Errno.PERM : Errno.NOENT);
    }

    moveWithin(name: string, dest: VDir, newName: string): boolean {
        if (!(dest instanceof PoolDir) || dest.pool !== this.pool || this.mounts.has(name)) {
            return false;
        }
        this.pool.rename(this.childPath(name), dest.childPath(newName));
        this.mtimeMs = dest.mtimeMs = now();
        return true;
    }
}
