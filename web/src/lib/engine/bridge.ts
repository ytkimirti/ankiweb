// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Directories stored as plain OPFS files (the media folder and backups), which
 * the service worker can also read. The engine keeps a listing in memory and
 * loads file contents on demand through the IO worker, blocking until each
 * operation completes.
 */

import { Errno, fail, WasiError } from "./errno";
import { Ctl, type DirEntry, IO_CHUNK, type IoRequest, type ListReply, State } from "./io-protocol";
import { MemFile, now, type VDir, type VFile, type VNode } from "./vfs";

const decoder = new TextDecoder();

export class BridgeClient {
    private ctl = new Int32Array(new SharedArrayBuffer(16));
    private data = new SharedArrayBuffer(IO_CHUNK);
    private nextId = 1;
    private pending = new Map<number, (reply: ListReply) => void>();

    constructor(private port: MessagePort) {
        port.onmessage = (event) => {
            const reply = event.data as ListReply;
            this.pending.get(reply.id)?.(reply);
            this.pending.delete(reply.id);
        };
        this.post({ op: "channel", ctl: this.ctl.buffer as SharedArrayBuffer, data: this.data });
    }

    private post(req: IoRequest, transfer: Transferable[] = []): void {
        this.port.postMessage(req, transfer);
    }

private asyncRequest<T>(build: (id: number) => IoRequest): Promise<T> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, (reply) => (reply.error ? reject(new Error(reply.error)) : resolve(reply.entries as T)));
            this.post(build(id));
        });
    }

    /** Lists a directory asynchronously (used while setting up, before the module runs). */
    list(dir: string[], create = true): Promise<DirEntry[]> {
        return this.asyncRequest((id) => ({ op: "list", id, dir, create }));
    }

    removeDir(dir: string[], name: string): Promise<void> {
        return this.asyncRequest((id) => ({ op: "removeDir", id, dir, name }));
    }

    renameDir(dir: string[], name: string, toName: string): Promise<void> {
        return this.asyncRequest((id) => ({ op: "renameDir", id, dir, name, toName }));
    }

    /** Performs a request and blocks until the IO worker answers. */
    call(req: IoRequest, transfer: Transferable[] = []): { payload: Uint8Array; total: number } {
        Atomics.store(this.ctl, Ctl.State, State.Waiting);
        this.post(req, transfer);
        Atomics.wait(this.ctl, Ctl.State, State.Waiting);
        const status = Atomics.load(this.ctl, Ctl.Status);
        const len = Atomics.load(this.ctl, Ctl.Length);
        const payload = new Uint8Array(this.data, 0, len).slice();
        if (status) {
            let message: string | undefined;
            try {
                message = JSON.parse(decoder.decode(payload)).message;
            } catch {
                // no message
            }
            throw new WasiError(status, message);
        }
        return { payload, total: Atomics.load(this.ctl, Ctl.Total) };
    }

    callJson<T>(req: IoRequest, transfer: Transferable[] = []): T {
        return JSON.parse(decoder.decode(this.call(req, transfer).payload));
    }

    readFile(dir: string[], name: string): Uint8Array {
        let out: Uint8Array | null = null;
        let offset = 0;
        for (;;) {
            const { payload, total } = this.call({ op: "read", dir, name, offset });
            out ??= new Uint8Array(total);
            out.set(payload, offset);
            offset += payload.length;
            if (offset >= total || !payload.length) {
                return out.subarray(0, offset);
            }
        }
    }
}

interface Entry {
    size: number;
    mtimeMs: number;
}

class BridgeFile implements VFile {
    readonly kind = "file";
    /** Contents, once loaded or written. */
    private buf: MemFile | null = null;
    private dirty = false;

    constructor(private dir: BridgeDir, private name: string, private entry: Entry, fresh = false) {
        if (fresh) {
            this.buf = new MemFile();
            this.dirty = true;
        }
    }

    get mtimeMs(): number {
        return this.entry.mtimeMs;
    }

    set mtimeMs(value: number) {
        this.entry.mtimeMs = value;
    }

    private load(): MemFile {
        if (!this.buf) {
            this.buf = new MemFile(this.dir.client.readFile(this.dir.path, this.name));
        }
        return this.buf;
    }

    size(): number {
        return this.buf ? this.buf.size() : this.entry.size;
    }

    read(pos: number, out: Uint8Array): number {
        return this.load().read(pos, out);
    }

    write(pos: number, data: Uint8Array): number {
        // a write that starts the file afresh does not need the old contents
        if (!this.buf && pos === 0 && data.length >= this.entry.size) {
            this.buf = new MemFile();
        }
        const n = this.load().write(pos, data);
        this.dirty = true;
        this.entry.size = this.buf!.size();
        this.entry.mtimeMs = now();
        return n;
    }

    truncate(size: number): void {
        if (size === 0) {
            this.buf = new MemFile();
        } else {
            this.load().truncate(size);
        }
        this.dirty = true;
        this.entry.size = size;
        this.entry.mtimeMs = now();
    }

    flush(): void {
        if (!this.dirty || !this.buf) {
            return;
        }
        const bytes = this.buf.contents().slice();
        const { mtimeMs } = this.dir.client.callJson<{ mtimeMs: number }>(
            { op: "write", dir: this.dir.path, name: this.name, bytes },
            [bytes.buffer],
        );
        this.entry.mtimeMs = mtimeMs;
        this.entry.size = bytes.length;
        this.dirty = false;
        this.dir.touch();
    }

    release(): void {
        this.flush();
        // contents are reloaded on demand; media files can be large
        this.buf = null;
    }

    /** @internal */
    detach(): void {
        this.dirty = false;
        this.buf = null;
    }
}

export class BridgeDir implements VDir {
    readonly kind = "dir";
    private lastChange = 0;
    private files = new Map<string, BridgeFile>();
    private subdirs = new Map<string, BridgeDir>();

    private constructor(
        readonly client: BridgeClient,
        readonly path: string[],
        private entries: Map<string, Entry>,
    ) {
        for (const entry of entries.values()) {
            this.lastChange = Math.max(this.lastChange, entry.mtimeMs);
        }
    }

    /** Loads the listing of an OPFS directory, creating it if needed. */
    static async open(client: BridgeClient, path: string[]): Promise<BridgeDir> {
        const listing = await client.list(path);
        const entries = new Map<string, Entry>();
        const dir = new BridgeDir(client, path, entries);
        for (const item of listing) {
            if (item.dir) {
                dir.subdirs.set(item.name, await BridgeDir.open(client, [...path, item.name]));
            } else {
                entries.set(item.name, { size: item.size, mtimeMs: item.mtimeMs });
            }
        }
        dir.lastChange = Math.max(dir.lastChange, 0);
        for (const entry of entries.values()) {
            dir.lastChange = Math.max(dir.lastChange, entry.mtimeMs);
        }
        return dir;
    }

    get mtimeMs(): number {
        return this.lastChange;
    }

    set mtimeMs(value: number) {
        this.lastChange = value;
    }

    /** @internal */
    touch(): void {
        this.lastChange = Math.max(now(), this.lastChange + 1);
    }

    names(): string[] {
        return [...this.entries.keys(), ...this.subdirs.keys()];
    }

    get(name: string): VNode | undefined {
        const sub = this.subdirs.get(name);
        if (sub) {
            return sub;
        }
        const entry = this.entries.get(name);
        if (!entry) {
            return undefined;
        }
        let file = this.files.get(name);
        if (!file) {
            file = new BridgeFile(this, name, entry);
            this.files.set(name, file);
        }
        return file;
    }

    createFile(name: string): VFile {
        if (this.subdirs.has(name)) {
            fail(Errno.ISDIR);
        }
        const entry: Entry = { size: 0, mtimeMs: now() };
        this.entries.set(name, entry);
        const file = new BridgeFile(this, name, entry, true);
        this.files.set(name, file);
        this.touch();
        return file;
    }

    mkdir(name: string): VDir {
        if (this.entries.has(name) || this.subdirs.has(name)) {
            fail(Errno.EXIST);
        }
        const path = [...this.path, name];
        this.client.call({ op: "mkdir", dir: path });
        const dir = new BridgeDir(this.client, path, new Map());
        this.subdirs.set(name, dir);
        this.touch();
        return dir;
    }

    unlink(name: string): void {
        if (this.subdirs.has(name)) {
            fail(Errno.ISDIR);
        }
        if (!this.entries.has(name)) {
            fail(Errno.NOENT);
        }
        try {
            this.client.call({ op: "delete", dir: this.path, name });
        } catch (err) {
            // a file created but never flushed does not exist in OPFS yet
            if (!(err instanceof WasiError && err.errno === Errno.NOENT)) {
                throw err;
            }
        }
        this.files.get(name)?.detach();
        this.files.delete(name);
        this.entries.delete(name);
        this.touch();
    }

    rmdir(name: string): void {
        const sub = this.subdirs.get(name);
        if (!sub) {
            fail(this.entries.has(name) ? Errno.NOTDIR : Errno.NOENT);
        }
        if (sub.names().length) {
            fail(Errno.NOTEMPTY);
        }
        this.client.call({ op: "delete", dir: this.path, name });
        this.subdirs.delete(name);
        this.touch();
    }

    moveWithin(name: string, dest: VDir, newName: string): boolean {
        if (!(dest instanceof BridgeDir) || dest.client !== this.client || this.subdirs.has(name)) {
            return false;
        }
        const entry = this.entries.get(name);
        if (!entry) {
            fail(Errno.NOENT);
        }
        this.files.get(name)?.flush();
        const { mtimeMs } = this.client.callJson<{ mtimeMs: number }>({
            op: "rename",
            dir: this.path,
            name,
            toDir: dest.path,
            toName: newName,
        });
        this.files.get(name)?.detach();
        this.files.delete(name);
        this.entries.delete(name);
        dest.files.get(newName)?.detach();
        dest.files.delete(newName);
        dest.entries.set(newName, { size: entry.size, mtimeMs });
        this.touch();
        dest.touch();
        return true;
    }
}
