// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Messages between the engine worker and the IO worker. The engine blocks on
 * a shared control word while the IO worker performs an OPFS operation, so
 * the module can use files that OPFS only exposes asynchronously.
 */

/** Bytes moved per read round trip. */
export const IO_CHUNK = 4 << 20;

/** Control word indices. */
export const enum Ctl {
    State = 0,
    Status = 1,
    Length = 2,
    Total = 3,
}

export const enum State {
    Waiting = 0,
    Done = 1,
}

export interface DirEntry {
    name: string;
    size: number;
    mtimeMs: number;
    dir: boolean;
}

export type IoRequest =
    | { op: "channel"; ctl: SharedArrayBuffer; data: SharedArrayBuffer }
    | { op: "list"; id: number; dir: string[]; create: boolean }
    | { op: "read"; dir: string[]; name: string; offset: number }
    | { op: "write"; dir: string[]; name: string; bytes: Uint8Array }
    | { op: "delete"; dir: string[]; name: string }
    | { op: "rename"; dir: string[]; name: string; toDir: string[]; toName: string }
    | { op: "mkdir"; dir: string[] };

export interface ListReply {
    id: number;
    entries?: DirEntry[];
    error?: string;
}
