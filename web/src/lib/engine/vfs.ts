// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * The virtual filesystem the WASI module sees. Directories can be backed by
 * memory, by a pool of OPFS sync access handles (pool.ts) or by OPFS through
 * the IO worker (bridge.ts); a directory can mount another backend under a
 * child name.
 */

import { Errno, fail } from "./errno";

export interface VFile {
    readonly kind: "file";
    /** Stands for the file in inode numbers when the node object is not kept (pool files). */
    readonly identity?: object;
    mtimeMs: number;
    size(): number;
    read(pos: number, out: Uint8Array): number;
    write(pos: number, data: Uint8Array): number;
    truncate(size: number): void;
    /** Makes previous writes durable. */
    flush(): void;
    /** Called when the last descriptor for the file closes. */
    release?(): void;
}

export interface VDir {
    readonly kind: "dir";
    mtimeMs: number;
    names(): string[];
    get(name: string): VNode | undefined;
    createFile(name: string): VFile;
    mkdir(name: string): VDir;
    unlink(name: string): void;
    rmdir(name: string): void;
    /**
     * Moves child `name` to `dest` as `newName`, replacing any file there.
     * Returns false if `dest` uses a different backend; the caller then copies.
     */
    moveWithin(name: string, dest: VDir, newName: string): boolean;
}

export type VNode = VFile | VDir;

export function now(): number {
    return Date.now();
}

/** A growable in-memory file. */
export class MemFile implements VFile {
    readonly kind = "file";
    mtimeMs = now();
    private buf: Uint8Array;
    private len: number;

    constructor(data?: Uint8Array) {
        this.buf = data ?? new Uint8Array(0);
        this.len = this.buf.length;
    }

    size(): number {
        return this.len;
    }

    contents(): Uint8Array {
        return this.buf.subarray(0, this.len);
    }

    read(pos: number, out: Uint8Array): number {
        if (pos >= this.len) {
            return 0;
        }
        const n = Math.min(out.length, this.len - pos);
        out.set(this.buf.subarray(pos, pos + n));
        return n;
    }

    write(pos: number, data: Uint8Array): number {
        const end = pos + data.length;
        this.reserve(end);
        this.buf.set(data, pos);
        this.len = Math.max(this.len, end);
        this.mtimeMs = now();
        return data.length;
    }

    truncate(size: number): void {
        if (size > this.len) {
            this.reserve(size);
            this.buf.fill(0, this.len, size);
        }
        this.len = size;
        this.mtimeMs = now();
    }

    flush(): void {}

    private reserve(size: number): void {
        if (size <= this.buf.length) {
            return;
        }
        const grown = new Uint8Array(Math.max(size, this.buf.length * 2, 4096));
        grown.set(this.buf.subarray(0, this.len));
        this.buf = grown;
    }
}

/**
 * A read-only file backed by a Blob, read on demand with FileReaderSync so
 * large imports need not be copied into memory first.
 */
export class BlobFile implements VFile {
    readonly kind = "file";
    mtimeMs: number;
    private reader = new FileReaderSync();

    constructor(private blob: Blob) {
        this.mtimeMs = blob instanceof File ? blob.lastModified : now();
    }

    size(): number {
        return this.blob.size;
    }

    read(pos: number, out: Uint8Array): number {
        if (pos >= this.blob.size) {
            return 0;
        }
        const end = Math.min(this.blob.size, pos + out.length);
        const data = new Uint8Array(this.reader.readAsArrayBuffer(this.blob.slice(pos, end)));
        out.set(data);
        return data.length;
    }

    write(): number {
        fail(Errno.ACCES, "read-only file");
    }

    truncate(): void {
        fail(Errno.ACCES, "read-only file");
    }

    flush(): void {}
}

export class MemDir implements VDir {
    readonly kind = "dir";
    mtimeMs = now();
    protected children = new Map<string, VNode>();

    names(): string[] {
        return [...this.children.keys()];
    }

    get(name: string): VNode | undefined {
        return this.children.get(name);
    }

    /** Attaches a node (such as another backend's directory) under `name`. */
    mount(name: string, node: VNode): void {
        this.children.set(name, node);
        this.mtimeMs = now();
    }

    unmount(name: string): void {
        this.children.delete(name);
        this.mtimeMs = now();
    }

    createFile(name: string): VFile {
        const file = new MemFile();
        this.children.set(name, file);
        this.mtimeMs = now();
        return file;
    }

    mkdir(name: string): VDir {
        const dir = new MemDir();
        this.children.set(name, dir);
        this.mtimeMs = now();
        return dir;
    }

    unlink(name: string): void {
        const node = this.children.get(name);
        if (!node) {
            fail(Errno.NOENT);
        }
        if (node.kind === "dir") {
            fail(Errno.ISDIR);
        }
        this.children.delete(name);
        this.mtimeMs = now();
    }

    rmdir(name: string): void {
        const node = this.children.get(name);
        if (!node) {
            fail(Errno.NOENT);
        }
        if (node.kind !== "dir") {
            fail(Errno.NOTDIR);
        }
        if (node.names().length) {
            fail(Errno.NOTEMPTY);
        }
        this.children.delete(name);
        this.mtimeMs = now();
    }

    moveWithin(name: string, dest: VDir, newName: string): boolean {
        if (!(dest instanceof MemDir)) {
            return false;
        }
        const node = this.children.get(name);
        if (!node) {
            fail(Errno.NOENT);
        }
        this.children.delete(name);
        dest.children.set(newName, node);
        this.mtimeMs = dest.mtimeMs = now();
        return true;
    }
}

/** Copies a file's contents into a new file. */
export function copyFile(src: VFile, dest: VFile): void {
    dest.truncate(0);
    const chunk = new Uint8Array(Math.min(4 << 20, Math.max(src.size(), 1)));
    let pos = 0;
    for (;;) {
        const n = src.read(pos, chunk);
        if (!n) {
            break;
        }
        dest.write(pos, chunk.subarray(0, n));
        pos += n;
    }
    dest.flush();
    dest.release?.();
}

/** Reads a whole file. */
export function readAll(file: VFile): Uint8Array {
    const out = new Uint8Array(file.size());
    let pos = 0;
    while (pos < out.length) {
        const n = file.read(pos, out.subarray(pos));
        if (!n) {
            break;
        }
        pos += n;
    }
    return out.subarray(0, pos);
}

/** Splits a path into components, resolving "." and "..". */
export function splitPath(path: string): string[] {
    const parts: string[] = [];
    for (const part of path.split("/")) {
        if (!part || part === ".") {
            continue;
        }
        if (part === "..") {
            if (!parts.length) {
                fail(Errno.NOTCAPABLE, "path escapes root");
            }
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    return parts;
}

/** Resolves `parts` from `root`. */
export function lookup(root: VDir, parts: string[]): VNode | undefined {
    let node: VNode = root;
    for (const part of parts) {
        if (node.kind !== "dir") {
            return undefined;
        }
        const next: VNode | undefined = node.get(part);
        if (!next) {
            return undefined;
        }
        node = next;
    }
    return node;
}

/** Resolves the parent directory of `parts` and returns it with the leaf name. */
export function lookupParent(root: VDir, parts: string[]): [VDir, string] {
    if (!parts.length) {
        fail(Errno.INVAL, "empty path");
    }
    const parent = lookup(root, parts.slice(0, -1));
    if (!parent) {
        fail(Errno.NOENT);
    }
    if (parent.kind !== "dir") {
        fail(Errno.NOTDIR);
    }
    return [parent, parts[parts.length - 1]];
}

/** Creates directories along `path` as needed and returns the last one. */
export function mkdirp(root: VDir, path: string): VDir {
    let dir = root;
    for (const part of splitPath(path)) {
        const next = dir.get(part);
        if (!next) {
            dir = dir.mkdir(part);
        } else if (next.kind === "dir") {
            dir = next;
        } else {
            fail(Errno.NOTDIR);
        }
    }
    return dir;
}
