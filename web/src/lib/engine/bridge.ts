// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Directories stored as plain OPFS files (the media folder and backups), which
 * the service worker can also read. The engine keeps a listing in memory and
 * loads file contents on demand through the IO worker, blocking until each
 * operation completes.
 *
 * Opening lists names only, since reading every file's size and time takes
 * seconds with many media files; they are read when first asked for, one by
 * one or, once many are, all at once (the media scan). The media folder's own
 * time, which tells the scan whether anything changed, is the latest change
 * the engine made; it is kept in a marker file beside the folder, written
 * when changes settle and removed before the next change, so that a marker
 * found when opening is known to be current.
 */

import { Errno, fail, WasiError } from "./errno";
import { Ctl, type DirEntry, IO_CHUNK, type IoRequest, type ListReply, State } from "./io-protocol";
import { MemFile, now, type VDir, type VFile, type VNode } from "./vfs";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** How long after the last change the folder's marker is written. */
const MARKER_DELAY_MS = 3000;
/** Files looked up one by one before the rest are read all at once. */
const SINGLE_STATS = 32;

export class BridgeClient {
    private ctl = new Int32Array(new SharedArrayBuffer(16));
    private data = new SharedArrayBuffer(IO_CHUNK);
    private nextId = 1;
    private pending = new Map<number, (reply: ListReply) => void>();
    /** The last file the IO worker could not read (see takeUnreadable). */
    private unreadable: { dir: string[]; name: string } | null = null;

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
            this.pending.set(
                id,
                (reply) => (reply.error ? reject(new Error(reply.error)) : resolve((reply.value ?? reply.entries) as T)),
            );
            this.post(build(id));
        });
    }

    /**
     * Lists a directory asynchronously (used while setting up, before the
     * module runs); without `stat`, file sizes and times are NaN.
     */
    list(dir: string[], create = true, stat = true): Promise<DirEntry[]> {
        return this.asyncRequest((id) => ({ op: "list", id, dir, create, stat }));
    }

    /** Reads a small JSON file, or null if it is missing or unreadable. */
    readJson<T>(dir: string[], name: string): Promise<T | null> {
        return this.asyncRequest((id) => ({ op: "readJson", id, dir, name }));
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
            let file: string | undefined;
            try {
                ({ message, file } = JSON.parse(decoder.decode(payload)));
            } catch {
                // no message
            }
            if (file && "dir" in req) {
                this.unreadable = { dir: req.dir, name: file };
            }
            throw new WasiError(status, message);
        }
        return { payload, total: Atomics.load(this.ctl, Ctl.Total) };
    }

    /**
     * The file whose failed read most likely caused an IO error the engine
     * returned, since WASI passes on only the error's number.
     */
    takeUnreadable(): { dir: string[]; name: string } | null {
        const file = this.unreadable;
        this.unreadable = null;
        return file;
    }

    callJson<T>(req: IoRequest, transfer: Transferable[] = []): T {
        return JSON.parse(decoder.decode(this.call(req, transfer).payload));
    }

    /** Sizes and times of a directory's files. */
    statDir(dir: string[]): [name: string, size: number, mtimeMs: number][] {
        let out: Uint8Array | null = null;
        let offset = 0;
        for (;;) {
            const { payload, total } = this.call({ op: "statDir", dir, offset });
            out ??= new Uint8Array(total);
            out.set(payload, offset);
            offset += payload.length;
            if (offset >= total || !payload.length) {
                return JSON.parse(decoder.decode(out.subarray(0, offset)));
            }
        }
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

/** Size and time; NaN until read (see above). */
interface Entry {
    size: number;
    mtimeMs: number;
}

export class BridgeFile implements VFile {
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
        this.dir.knowStats(this.name, this.entry);
        return this.entry.mtimeMs;
    }

    set mtimeMs(value: number) {
        // so that reading the size later does not replace the time set
        this.dir.knowStats(this.name, this.entry);
        this.entry.mtimeMs = value;
    }

    private load(): MemFile {
        if (!this.buf) {
            this.buf = new MemFile(this.dir.client.readFile(this.dir.path, this.name));
        }
        return this.buf;
    }

    size(): number {
        if (this.buf) {
            return this.buf.size();
        }
        this.dir.knowStats(this.name, this.entry);
        return this.entry.size;
    }

    /** Reads the whole file without keeping its contents. */
    readOnce(): Uint8Array {
        return this.buf ? this.buf.contents().slice() : this.dir.client.readFile(this.dir.path, this.name);
    }

    /** Reads up to a chunk at `pos` without keeping the contents (copying a large file). */
    readDirect(pos: number, out: Uint8Array): number {
        if (this.buf) {
            return this.buf.read(pos, out);
        }
        const { payload } = this.dir.client.call({ op: "read", dir: this.dir.path, name: this.name, offset: pos });
        const n = Math.min(payload.length, out.length);
        out.set(payload.subarray(0, n));
        return n;
    }

    read(pos: number, out: Uint8Array): number {
        return this.load().read(pos, out);
    }

    write(pos: number, data: Uint8Array): number {
        // a write that starts the file afresh does not need the old contents
        if (!this.buf && pos === 0 && data.length >= this.size()) {
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
        this.dir.beforeChange();
        const { mtimeMs } = this.dir.client.callJson<{ mtimeMs: number }>(
            { op: "write", dir: this.dir.path, name: this.name, bytes },
            [bytes.buffer],
        );
        this.entry.mtimeMs = mtimeMs;
        this.entry.size = bytes.length;
        this.dirty = false;
        this.dir.touch();
        this.dir.afterChange();
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

/** The marker file that holds a folder's time (see above). */
interface Marker {
    dir: string[];
    name: string;
    /** The marker on disk holds the current time. */
    clean: boolean;
    timer: ReturnType<typeof setTimeout> | null;
}

export class BridgeDir implements VDir {
    readonly kind = "dir";
    /** The latest change; NaN until known, from the marker or the files' times. */
    private lastChange = NaN;
    /** Every file's size and time has been read. */
    private statted = false;
    private singleStats = 0;
    private marker: Marker | null = null;
    private files = new Map<string, BridgeFile>();
    private subdirs = new Map<string, BridgeDir>();

    private constructor(
        readonly client: BridgeClient,
        readonly path: string[],
        private entries: Map<string, Entry>,
    ) {}

    /**
     * Loads the listing of an OPFS directory, creating it if needed. With
     * `marker`, the name of a file beside it, the folder's time is kept there.
     */
    static async open(client: BridgeClient, path: string[], marker?: string): Promise<BridgeDir> {
        const listing = await client.list(path, true, false);
        const entries = new Map<string, Entry>();
        const dir = new BridgeDir(client, path, entries);
        for (const item of listing) {
            if (item.dir) {
                dir.subdirs.set(item.name, await BridgeDir.open(client, [...path, item.name]));
            } else {
                entries.set(item.name, { size: NaN, mtimeMs: NaN });
            }
        }
        if (marker) {
            const parent = path.slice(0, -1);
            const saved = await client.readJson<{ mtimeMs?: unknown }>(parent, marker);
            const clean = typeof saved?.mtimeMs === "number";
            // without one (the first time, or after closing during a change) the
            // folder counts as just changed: files' own times can be older than a
            // change, such as a removal, so they would not show it
            dir.lastChange = clean ? (saved.mtimeMs as number) : now();
            dir.marker = { dir: parent, name: marker, clean, timer: null };
            if (!clean) {
                // so that the next time it is opened, it need not be scanned
                dir.afterChange();
            }
        }
        return dir;
    }

    get mtimeMs(): number {
        if (Number.isNaN(this.lastChange)) {
            this.statAll();
            this.lastChange = 0;
            for (const entry of this.entries.values()) {
                if (!Number.isNaN(entry.mtimeMs)) {
                    this.lastChange = Math.max(this.lastChange, entry.mtimeMs);
                }
            }
        }
        return this.lastChange;
    }

    set mtimeMs(value: number) {
        this.lastChange = value;
    }

    /** @internal */
    touch(): void {
        this.lastChange = Math.max(now(), (Number.isNaN(this.lastChange) ? 0 : this.lastChange) + 1);
    }

    /**
     * @internal Reads a file's size and time if they are not known yet. They are
     * never guessed: the media scan skips empty files, so a file whose size
     * could not be read must fail the scan rather than count as deleted.
     */
    knowStats(name: string, entry: Entry): void {
        if (!Number.isNaN(entry.size)) {
            return;
        }
        if (!this.statted && ++this.singleStats > SINGLE_STATS) {
            this.statAll();
        }
        if (Number.isNaN(entry.size)) {
            // one by one, or a file the listing did not have (NOENT if gone)
            const stat = this.client.callJson<{ size: number; mtimeMs: number }>({
                op: "statFile",
                dir: this.path,
                name,
            });
            if (!Number.isFinite(stat.size) || !Number.isFinite(stat.mtimeMs)) {
                fail(Errno.IO, `no size for ${name}`);
            }
            entry.size = stat.size;
            entry.mtimeMs = stat.mtimeMs;
        }
    }

    private statAll(): void {
        if (this.statted) {
            return;
        }
        // statted is set only once the listing succeeds, so that a failed one is retried
        const stats = new Map(this.client.statDir(this.path).map(([name, size, mtimeMs]) => [name, { size, mtimeMs }]));
        this.statted = true;
        for (const [name, entry] of this.entries) {
            if (Number.isNaN(entry.size)) {
                const stat = stats.get(name);
                if (stat) {
                    Object.assign(entry, stat);
                } else if (!this.files.has(name)) {
                    // removed from OPFS since it was listed
                    this.entries.delete(name);
                }
            }
        }
    }

    /** @internal Called before changing the folder in OPFS, which makes a marker stale. */
    beforeChange(): void {
        const marker = this.marker;
        if (!marker) {
            return;
        }
        if (marker.timer) {
            clearTimeout(marker.timer);
            marker.timer = null;
        }
        if (marker.clean) {
            try {
                this.client.call({ op: "delete", dir: marker.dir, name: marker.name });
            } catch (err) {
                if (!(err instanceof WasiError && err.errno === Errno.NOENT)) {
                    throw err;
                }
            }
            marker.clean = false;
        }
    }

    /** @internal Called after changing the folder: the marker is written once changes settle. */
    afterChange(): void {
        const marker = this.marker;
        if (!marker) {
            return;
        }
        if (marker.timer) {
            clearTimeout(marker.timer);
        }
        marker.timer = setTimeout(() => {
            try {
                this.writeMarker();
            } catch (err) {
                console.warn("could not write the folder marker", err);
            }
        }, MARKER_DELAY_MS);
    }

    private writeMarker(): void {
        const marker = this.marker;
        if (!marker) {
            return;
        }
        if (marker.timer) {
            clearTimeout(marker.timer);
            marker.timer = null;
        }
        if (marker.clean) {
            return;
        }
        if (Number.isNaN(this.lastChange)) {
            // nothing has read the time yet, so a new one will do; the next
            // scan then looks at every file once
            this.lastChange = now();
        }
        const bytes = encoder.encode(JSON.stringify({ mtimeMs: this.lastChange }));
        this.client.call({ op: "write", dir: marker.dir, name: marker.name, bytes }, [bytes.buffer]);
        marker.clean = true;
    }

    /** Writes the marker if it is due; called when the profile closes. */
    close(): void {
        try {
            this.writeMarker();
        } catch (err) {
            console.warn("could not write the folder marker", err);
        }
        this.marker = null;
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
        this.beforeChange();
        this.client.call({ op: "mkdir", dir: path });
        const dir = new BridgeDir(this.client, path, new Map());
        dir.statted = true;
        this.subdirs.set(name, dir);
        this.touch();
        this.afterChange();
        return dir;
    }

    unlink(name: string): void {
        if (this.subdirs.has(name)) {
            fail(Errno.ISDIR);
        }
        if (!this.entries.has(name)) {
            fail(Errno.NOENT);
        }
        this.beforeChange();
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
        this.afterChange();
    }

    rmdir(name: string): void {
        const sub = this.subdirs.get(name);
        if (!sub) {
            fail(this.entries.has(name) ? Errno.NOTDIR : Errno.NOENT);
        }
        if (sub.names().length) {
            fail(Errno.NOTEMPTY);
        }
        this.beforeChange();
        this.client.call({ op: "delete", dir: this.path, name });
        this.subdirs.delete(name);
        this.touch();
        this.afterChange();
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
        this.beforeChange();
        dest.beforeChange();
        const { size, mtimeMs } = this.client.callJson<{ size: number; mtimeMs: number }>({
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
        dest.entries.set(newName, { size, mtimeMs });
        this.touch();
        dest.touch();
        this.afterChange();
        dest.afterChange();
        return true;
    }
}
