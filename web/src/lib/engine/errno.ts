// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** WASI preview 1 errno values used by the VFS. */
export const enum Errno {
    SUCCESS = 0,
    ACCES = 2,
    BADF = 8,
    EXIST = 20,
    FBIG = 22,
    INVAL = 28,
    IO = 29,
    ISDIR = 31,
    NOENT = 44,
    NOSPC = 51,
    NOSYS = 52,
    NOTDIR = 54,
    NOTEMPTY = 55,
    NOTSUP = 58,
    PERM = 63,
    SPIPE = 70,
    XDEV = 75,
    NOTCAPABLE = 76,
}

export class WasiError extends Error {
    constructor(public errno: Errno, message?: string) {
        super(message ?? `wasi errno ${errno}`);
    }
}

export function fail(errno: Errno, message?: string): never {
    throw new WasiError(errno, message);
}
