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
    /** Without `stat`, files' sizes and times are NaN, as reading them is slow. */
    | { op: "list"; id: number; dir: string[]; create: boolean; stat: boolean }
    /** Reads a small JSON file; null if missing or unreadable. */
    | { op: "readJson"; id: number; dir: string[]; name: string }
    | { op: "removeDir"; id: number; dir: string[]; name: string }
    | { op: "renameDir"; id: number; dir: string[]; name: string; toName: string }
    | { op: "read"; dir: string[]; name: string; offset: number }
    | { op: "write"; dir: string[]; name: string; bytes: Uint8Array }
    | { op: "delete"; dir: string[]; name: string }
    | { op: "rename"; dir: string[]; name: string; toDir: string[]; toName: string }
    | { op: "mkdir"; dir: string[] }
    /** A file's size and time. */
    | { op: "statFile"; dir: string[]; name: string }
    /** The sizes and times of a directory's files, as JSON [name, size, mtimeMs][], read in chunks. */
    | { op: "statDir"; dir: string[]; offset: number }
    // requests the engine makes (see http.ts): start one unless one with the
    // key is running or has finished unread, ask how it is going (its
    // response metadata once finished, with the body size as the total),
    // read its body, and drop it
    | {
        op: "fetchStart";
        key: string;
        url: string;
        method: string;
        headers: [string, string][];
        body: Uint8Array;
        /** 0 for none. */
        timeoutMs: number;
        /** Fails it once nothing has been sent or received for this long; 0 for never. */
        stallMs: number;
    }
    | { op: "fetchPoll"; key: string }
    | { op: "fetchRead"; key: string; offset: number }
    | { op: "fetchAbort"; key: string }
    // drop them all (media sync aborted, profile closed)
    | { op: "fetchCancel" };

export interface ListReply {
    id: number;
    entries?: DirEntry[];
    value?: unknown;
    error?: string;
}
