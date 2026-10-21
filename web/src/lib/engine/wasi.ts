// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * The subset of WASI preview 1 that Rust's std and wasi-libc use, over the
 * VFS in vfs.ts. Runs in the engine worker; blocking calls (sleeps, IO bridge
 * requests) block only that worker.
 */

import { Errno, WasiError } from "./errno";
import { copyFile, lookup, lookupParent, splitPath, type VDir, type VFile, type VNode } from "./vfs";

const enum FileType {
    Unknown = 0,
    CharacterDevice = 2,
    Directory = 3,
    RegularFile = 4,
}

const enum OFlags {
    Creat = 1,
    Directory = 2,
    Excl = 4,
    Trunc = 8,
}

const enum FdFlags {
    Append = 1,
}

const enum FstFlags {
    Atim = 1,
    AtimNow = 2,
    Mtim = 4,
    MtimNow = 8,
}

const ALL_RIGHTS = 0x1fffffffn;

export class ExitStatus extends Error {
    constructor(public code: number) {
        super(`exit ${code}`);
    }
}

type Fd =
    | { kind: "stdio"; which: 0 | 1 | 2 }
    | { kind: "file"; node: VFile; path: string[]; pos: number; append: boolean }
    | { kind: "dir"; node: VDir; path: string[]; preopen?: string };

export interface WasiOptions {
    root: VDir;
    env?: Record<string, string>;
    log?: (stream: "stdout" | "stderr", line: string) => void;
}

export class Wasi {
    memory!: WebAssembly.Memory;
    private fds = new Map<number, Fd>();
    private nextFd = 4;
    private env: string[];
    private openCounts = new Map<VFile, number>();
    private inodes = new WeakMap<VNode, bigint>();
    private nextInode = 1n;
    private lineBuffers: Record<1 | 2, string> = { 1: "", 2: "" };
    private sleeper = new Int32Array(new SharedArrayBuffer(4));
    private encoder = new TextEncoder();
    private decoder = new TextDecoder();

    constructor(private options: WasiOptions) {
        this.env = Object.entries(options.env ?? {}).map(([k, v]) => `${k}=${v}`);
        this.fds.set(0, { kind: "stdio", which: 0 });
        this.fds.set(1, { kind: "stdio", which: 1 });
        this.fds.set(2, { kind: "stdio", which: 2 });
        this.fds.set(3, { kind: "dir", node: options.root, path: [], preopen: "/" });
    }

    private get view(): DataView {
        return new DataView(this.memory.buffer);
    }

    private get bytes(): Uint8Array {
        return new Uint8Array(this.memory.buffer);
    }

    private str(ptr: number, len: number): string {
        return this.decoder.decode(this.bytes.subarray(ptr, ptr + len));
    }

    private inode(node: VNode): bigint {
        let ino = this.inodes.get(node);
        if (!ino) {
            ino = this.nextInode++;
            this.inodes.set(node, ino);
        }
        return ino;
    }

    private fd(fd: number): Fd {
        const entry = this.fds.get(fd);
        if (!entry) {
            throw new WasiError(Errno.BADF);
        }
        return entry;
    }

    private dirFd(fd: number): Extract<Fd, { kind: "dir" }> {
        const entry = this.fd(fd);
        if (entry.kind !== "dir") {
            throw new WasiError(Errno.NOTDIR);
        }
        return entry;
    }

    private fileFd(fd: number): Extract<Fd, { kind: "file" }> {
        const entry = this.fd(fd);
        if (entry.kind === "dir") {
            throw new WasiError(Errno.ISDIR);
        }
        if (entry.kind !== "file") {
            throw new WasiError(Errno.BADF);
        }
        return entry;
    }

    /** Absolute path components for a path relative to a directory fd. */
    private resolve(fd: number, ptr: number, len: number): string[] {
        const dir = this.dirFd(fd);
        const rel = this.str(ptr, len);
        return splitPath(rel.startsWith("/") ? rel : [...dir.path, rel].join("/"));
    }

    private retain(node: VFile): void {
        this.openCounts.set(node, (this.openCounts.get(node) ?? 0) + 1);
    }

    private release(node: VFile): void {
        const count = (this.openCounts.get(node) ?? 1) - 1;
        if (count <= 0) {
            this.openCounts.delete(node);
            node.release?.();
        } else {
            this.openCounts.set(node, count);
        }
    }

    private writeFilestat(ptr: number, node: VNode | null, fileType?: FileType): void {
        const view = this.view;
        for (let i = 0; i < 64; i += 8) {
            view.setBigUint64(ptr + i, 0n, true);
        }
        const type = fileType ?? (node?.kind === "dir" ? FileType.Directory : FileType.RegularFile);
        view.setBigUint64(ptr + 8, node ? this.inode(node) : 0n, true);
        view.setUint8(ptr + 16, type);
        view.setBigUint64(ptr + 24, 1n, true);
        if (node) {
            const size = node.kind === "file" ? BigInt(node.size()) : 4096n;
            const mtime = BigInt(Math.round(node.mtimeMs * 1e6));
            view.setBigUint64(ptr + 32, size, true);
            view.setBigUint64(ptr + 40, mtime, true);
            view.setBigUint64(ptr + 48, mtime, true);
            view.setBigUint64(ptr + 56, mtime, true);
        }
    }

    private iovecs(ptr: number, count: number): Uint8Array[] {
        const view = this.view;
        const out: Uint8Array[] = [];
        for (let i = 0; i < count; i++) {
            const buf = view.getUint32(ptr + i * 8, true);
            const len = view.getUint32(ptr + i * 8 + 4, true);
            out.push(new Uint8Array(this.memory.buffer, buf, len));
        }
        return out;
    }

    private log(which: 1 | 2, text: string): void {
        const lines = (this.lineBuffers[which] + text).split("\n");
        this.lineBuffers[which] = lines.pop()!;
        for (const line of lines) {
            if (this.options.log) {
                this.options.log(which === 1 ? "stdout" : "stderr", line);
            } else {
                console.log(line);
            }
        }
    }

    private setTimes(node: VNode, mtim: bigint, flags: number): void {
        if (flags & FstFlags.MtimNow) {
            node.mtimeMs = Date.now();
        } else if (flags & FstFlags.Mtim) {
            node.mtimeMs = Number(mtim / 1000000n);
        }
    }

    private readFrom(entry: Extract<Fd, { kind: "file" }>, iovs: Uint8Array[], pos: number): number {
        let total = 0;
        for (const iov of iovs) {
            if (!iov.length) {
                continue;
            }
            const n = entry.node.read(pos + total, iov);
            total += n;
            if (n < iov.length) {
                break;
            }
        }
        return total;
    }

    private writeTo(entry: Extract<Fd, { kind: "file" }>, iovs: Uint8Array[], pos: number): number {
        let total = 0;
        for (const iov of iovs) {
            if (iov.length) {
                // copy out of wasm memory, which may move if the file grows memory
                total += entry.node.write(pos + total, iov.slice());
            }
        }
        return total;
    }

    /** Moves a file, copying across backends when they cannot rename directly. */
    private move(from: string[], to: string[]): void {
        const root = this.options.root;
        const [srcDir, srcName] = lookupParent(root, from);
        const [destDir, destName] = lookupParent(root, to);
        const node = srcDir.get(srcName);
        if (!node) {
            throw new WasiError(Errno.NOENT);
        }
        const existing = destDir.get(destName);
        if (existing?.kind === "dir") {
            if (node.kind !== "dir" || existing.names().length) {
                throw new WasiError(existing.names().length ? Errno.NOTEMPTY : Errno.ISDIR);
            }
            destDir.rmdir(destName);
        } else if (existing && node.kind === "dir") {
            throw new WasiError(Errno.NOTDIR);
        }
        if (srcDir.moveWithin(srcName, destDir, destName)) {
            return;
        }
        if (node.kind === "dir") {
            throw new WasiError(Errno.XDEV);
        }
        copyFile(node, existing?.kind === "file" ? existing : destDir.createFile(destName));
        srcDir.unlink(srcName);
    }

    private wrap(fn: (...args: any[]) => number | void): (...args: any[]) => number {
        return (...args: any[]) => {
            try {
                return fn(...args) ?? Errno.SUCCESS;
            } catch (err) {
                if (err instanceof WasiError) {
                    return err.errno;
                }
                if (err instanceof ExitStatus) {
                    throw err;
                }
                console.error("wasi call failed", fn.name, err);
                return Errno.IO;
            }
        };
    }

    imports(): Record<string, (...args: any[]) => number> {
        const calls: Record<string, (...args: any[]) => number | void> = {
            args_get: () => {},
            args_sizes_get: (countPtr: number, sizePtr: number) => {
                this.view.setUint32(countPtr, 0, true);
                this.view.setUint32(sizePtr, 0, true);
            },
            environ_get: (environPtr: number, bufPtr: number) => {
                for (const entry of this.env) {
                    const encoded = this.encoder.encode(entry + "\0");
                    this.bytes.set(encoded, bufPtr);
                    this.view.setUint32(environPtr, bufPtr, true);
                    environPtr += 4;
                    bufPtr += encoded.length;
                }
            },
            environ_sizes_get: (countPtr: number, sizePtr: number) => {
                const size = this.env.reduce((n, e) => n + this.encoder.encode(e).length + 1, 0);
                this.view.setUint32(countPtr, this.env.length, true);
                this.view.setUint32(sizePtr, size, true);
            },
            clock_res_get: (_id: number, ptr: number) => {
                this.view.setBigUint64(ptr, 1000n, true);
            },
            clock_time_get: (id: number, _precision: bigint, ptr: number) => {
                const ms = id === 0 ? performance.timeOrigin + performance.now() : performance.now();
                this.view.setBigUint64(ptr, BigInt(Math.round(ms * 1e6)), true);
            },
            random_get: (ptr: number, len: number) => {
                for (let off = 0; off < len; off += 65536) {
                    const chunk = new Uint8Array(Math.min(65536, len - off));
                    crypto.getRandomValues(chunk);
                    this.bytes.set(chunk, ptr + off);
                }
            },
            sched_yield: () => {},
            proc_exit: (code: number) => {
                throw new ExitStatus(code);
            },
            poll_oneoff: (inPtr: number, outPtr: number, nsubs: number, neventsPtr: number) => {
                const view = this.view;
                let sleepMs = Infinity;
                let events = 0;
                const ready: number[] = [];
                for (let i = 0; i < nsubs; i++) {
                    const sub = inPtr + i * 48;
                    const tag = view.getUint8(sub + 8);
                    if (tag === 0) {
                        const timeout = view.getBigUint64(sub + 24, true);
                        const flags = view.getUint16(sub + 40, true);
                        let ms = Number(timeout) / 1e6;
                        if (flags & 1) {
                            ms -= performance.timeOrigin + performance.now();
                        }
                        sleepMs = Math.min(sleepMs, Math.max(0, ms));
                    } else {
                        ready.push(i);
                    }
                }
                if (!ready.length && sleepMs !== Infinity) {
                    Atomics.wait(this.sleeper, 0, 0, sleepMs);
                    for (let i = 0; i < nsubs; i++) {
                        if (view.getUint8(inPtr + i * 48 + 8) === 0) {
                            ready.push(i);
                        }
                    }
                }
                for (const i of ready) {
                    const sub = inPtr + i * 48;
                    const ev = outPtr + events * 32;
                    view.setBigUint64(ev, view.getBigUint64(sub, true), true);
                    view.setUint16(ev + 8, 0, true);
                    view.setUint8(ev + 10, view.getUint8(sub + 8));
                    view.setBigUint64(ev + 16, 0n, true);
                    view.setUint16(ev + 24, 0, true);
                    events++;
                }
                view.setUint32(neventsPtr, events, true);
            },

            fd_advise: () => {},
            fd_allocate: () => {},
            fd_datasync: (fd: number) => {
                this.fileFd(fd).node.flush();
            },
            fd_sync: (fd: number) => {
                const entry = this.fd(fd);
                if (entry.kind === "file") {
                    entry.node.flush();
                }
            },
            fd_close: (fd: number) => {
                const entry = this.fd(fd);
                if (fd <= 3) {
                    return;
                }
                this.fds.delete(fd);
                if (entry.kind === "file") {
                    this.release(entry.node);
                }
            },
            fd_fdstat_get: (fd: number, ptr: number) => {
                const entry = this.fd(fd);
                const view = this.view;
                const type = entry.kind === "stdio"
                    ? FileType.CharacterDevice
                    : entry.kind === "dir"
                    ? FileType.Directory
                    : FileType.RegularFile;
                view.setUint8(ptr, type);
                view.setUint16(ptr + 2, entry.kind === "file" && entry.append ? FdFlags.Append : 0, true);
                view.setBigUint64(ptr + 8, ALL_RIGHTS, true);
                view.setBigUint64(ptr + 16, ALL_RIGHTS, true);
            },
            fd_fdstat_set_flags: (fd: number, flags: number) => {
                const entry = this.fd(fd);
                if (entry.kind === "file") {
                    entry.append = !!(flags & FdFlags.Append);
                }
            },
            fd_fdstat_set_rights: () => {},
            fd_filestat_get: (fd: number, ptr: number) => {
                const entry = this.fd(fd);
                if (entry.kind === "stdio") {
                    this.writeFilestat(ptr, null, FileType.CharacterDevice);
                } else {
                    this.writeFilestat(ptr, entry.node);
                }
            },
            fd_filestat_set_size: (fd: number, size: bigint) => {
                this.fileFd(fd).node.truncate(Number(size));
            },
            fd_filestat_set_times: (fd: number, _atim: bigint, mtim: bigint, flags: number) => {
                const entry = this.fd(fd);
                if (entry.kind !== "stdio") {
                    this.setTimes(entry.node, mtim, flags);
                }
            },
            fd_prestat_get: (fd: number, ptr: number) => {
                const entry = this.fds.get(fd);
                if (!entry || entry.kind !== "dir" || !entry.preopen) {
                    return Errno.BADF;
                }
                this.view.setUint8(ptr, 0);
                this.view.setUint32(ptr + 4, this.encoder.encode(entry.preopen).length, true);
            },
            fd_prestat_dir_name: (fd: number, ptr: number, len: number) => {
                const entry = this.fds.get(fd);
                if (!entry || entry.kind !== "dir" || !entry.preopen) {
                    return Errno.BADF;
                }
                this.bytes.set(this.encoder.encode(entry.preopen).subarray(0, len), ptr);
            },
            fd_read: (fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number) => {
                const entry = this.fd(fd);
                if (entry.kind === "stdio") {
                    this.view.setUint32(nreadPtr, 0, true);
                    return;
                }
                const file = this.fileFd(fd);
                const n = this.readFrom(file, this.iovecs(iovsPtr, iovsLen), file.pos);
                file.pos += n;
                this.view.setUint32(nreadPtr, n, true);
            },
            fd_pread: (fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nreadPtr: number) => {
                const file = this.fileFd(fd);
                const n = this.readFrom(file, this.iovecs(iovsPtr, iovsLen), Number(offset));
                this.view.setUint32(nreadPtr, n, true);
            },
            fd_write: (fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) => {
                const entry = this.fd(fd);
                const iovs = this.iovecs(iovsPtr, iovsLen);
                if (entry.kind === "stdio") {
                    let n = 0;
                    for (const iov of iovs) {
                        n += iov.length;
                        if (entry.which !== 0) {
                            this.log(entry.which, this.decoder.decode(iov));
                        }
                    }
                    this.view.setUint32(nwrittenPtr, n, true);
                    return;
                }
                const file = this.fileFd(fd);
                if (file.append) {
                    file.pos = file.node.size();
                }
                const n = this.writeTo(file, iovs, file.pos);
                file.pos += n;
                this.view.setUint32(nwrittenPtr, n, true);
            },
            fd_pwrite: (fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nwrittenPtr: number) => {
                const file = this.fileFd(fd);
                const n = this.writeTo(file, this.iovecs(iovsPtr, iovsLen), Number(offset));
                this.view.setUint32(nwrittenPtr, n, true);
            },
            fd_seek: (fd: number, offset: bigint, whence: number, newOffsetPtr: number) => {
                const entry = this.fd(fd);
                if (entry.kind !== "file") {
                    return Errno.SPIPE;
                }
                const base = whence === 0 ? 0 : whence === 1 ? entry.pos : entry.node.size();
                const pos = base + Number(offset);
                if (pos < 0) {
                    return Errno.INVAL;
                }
                entry.pos = pos;
                this.view.setBigUint64(newOffsetPtr, BigInt(pos), true);
            },
            fd_tell: (fd: number, ptr: number) => {
                this.view.setBigUint64(ptr, BigInt(this.fileFd(fd).pos), true);
            },
            fd_readdir: (fd: number, buf: number, bufLen: number, cookie: bigint, bufUsedPtr: number) => {
                const dir = this.dirFd(fd);
                const names = dir.node.names().sort();
                const chunks: Uint8Array[] = [];
                let size = 0;
                for (let i = Number(cookie); i < names.length && size < bufLen; i++) {
                    const name = this.encoder.encode(names[i]);
                    const child = dir.node.get(names[i]);
                    const entry = new Uint8Array(24 + name.length);
                    const view = new DataView(entry.buffer);
                    view.setBigUint64(0, BigInt(i + 1), true);
                    view.setBigUint64(8, child ? this.inode(child) : 0n, true);
                    view.setUint32(16, name.length, true);
                    view.setUint8(20, child?.kind === "dir" ? FileType.Directory : FileType.RegularFile);
                    entry.set(name, 24);
                    chunks.push(entry);
                    size += entry.length;
                }
                let used = 0;
                const out = this.bytes;
                for (const chunk of chunks) {
                    const n = Math.min(chunk.length, bufLen - used);
                    out.set(chunk.subarray(0, n), buf + used);
                    used += n;
                    if (used >= bufLen) {
                        break;
                    }
                }
                this.view.setUint32(bufUsedPtr, used, true);
            },
            fd_renumber: (from: number, to: number) => {
                const entry = this.fd(from);
                const existing = this.fds.get(to);
                if (existing?.kind === "file") {
                    this.release(existing.node);
                }
                this.fds.set(to, entry);
                this.fds.delete(from);
            },

            path_open: (
                fd: number,
                _dirflags: number,
                pathPtr: number,
                pathLen: number,
                oflags: number,
                _rightsBase: bigint,
                _rightsInheriting: bigint,
                fdflags: number,
                fdOutPtr: number,
            ) => {
                const parts = this.resolve(fd, pathPtr, pathLen);
                const root = this.options.root;
                let node = lookup(root, parts);
                if (node && oflags & OFlags.Excl && oflags & OFlags.Creat) {
                    return Errno.EXIST;
                }
                if (!node) {
                    if (!(oflags & OFlags.Creat) || oflags & OFlags.Directory) {
                        return Errno.NOENT;
                    }
                    const [parent, name] = lookupParent(root, parts);
                    node = parent.createFile(name);
                }
                if (oflags & OFlags.Directory && node.kind !== "dir") {
                    return Errno.NOTDIR;
                }
                const newFd = this.nextFd++;
                if (node.kind === "dir") {
                    this.fds.set(newFd, { kind: "dir", node, path: parts });
                } else {
                    if (oflags & OFlags.Trunc) {
                        node.truncate(0);
                    }
                    this.retain(node);
                    this.fds.set(newFd, {
                        kind: "file",
                        node,
                        path: parts,
                        pos: 0,
                        append: !!(fdflags & FdFlags.Append),
                    });
                }
                this.view.setUint32(fdOutPtr, newFd, true);
            },
            path_create_directory: (fd: number, pathPtr: number, pathLen: number) => {
                const parts = this.resolve(fd, pathPtr, pathLen);
                const [parent, name] = lookupParent(this.options.root, parts);
                if (parent.get(name)) {
                    return Errno.EXIST;
                }
                parent.mkdir(name);
            },
            path_filestat_get: (fd: number, _flags: number, pathPtr: number, pathLen: number, ptr: number) => {
                const node = lookup(this.options.root, this.resolve(fd, pathPtr, pathLen));
                if (!node) {
                    return Errno.NOENT;
                }
                this.writeFilestat(ptr, node);
            },
            path_filestat_set_times: (
                fd: number,
                _flags: number,
                pathPtr: number,
                pathLen: number,
                _atim: bigint,
                mtim: bigint,
                fstflags: number,
            ) => {
                const node = lookup(this.options.root, this.resolve(fd, pathPtr, pathLen));
                if (!node) {
                    return Errno.NOENT;
                }
                this.setTimes(node, mtim, fstflags);
            },
            path_link: () => Errno.NOTSUP,
            path_symlink: () => Errno.NOTSUP,
            path_readlink: (fd: number, pathPtr: number, pathLen: number) => {
                const node = lookup(this.options.root, this.resolve(fd, pathPtr, pathLen));
                return node ? Errno.INVAL : Errno.NOENT;
            },
            path_remove_directory: (fd: number, pathPtr: number, pathLen: number) => {
                const [parent, name] = lookupParent(this.options.root, this.resolve(fd, pathPtr, pathLen));
                parent.rmdir(name);
            },
            path_unlink_file: (fd: number, pathPtr: number, pathLen: number) => {
                const [parent, name] = lookupParent(this.options.root, this.resolve(fd, pathPtr, pathLen));
                parent.unlink(name);
            },
            path_rename: (fd: number, oldPtr: number, oldLen: number, newFd: number, newPtr: number, newLen: number) => {
                this.move(this.resolve(fd, oldPtr, oldLen), this.resolve(newFd, newPtr, newLen));
            },
        };
        const out: Record<string, (...args: any[]) => number> = {};
        for (const [name, fn] of Object.entries(calls)) {
            out[name] = this.wrap(fn);
        }
        return out;
    }
}
