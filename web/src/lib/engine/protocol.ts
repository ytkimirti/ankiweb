// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** Messages between the main thread and the engine worker. */

export interface EngineInit {
    wasmUrl: string;
    /** Encoded anki.backend.BackendInit. */
    backendInit: Uint8Array;
    /** Set to 1 by the main thread to abort the running operation. */
    abortFlag: SharedArrayBuffer;
}

export type EngineRequest =
    | { type: "init"; id: number; init: EngineInit; ioPort: MessagePort }
    | { type: "call"; id: number; service: number; method: number; input: Uint8Array }
    | { type: "db"; id: number; input: Uint8Array }
    /** Mounts /profiles/<name> with its media and backup folders. */
    | { type: "mountProfile"; id: number; name: string }
    | { type: "unmountProfile"; id: number; name: string }
    /** Places a blob (such as a file to import) at a path in a memory-backed folder. */
    | { type: "putFile"; id: number; path: string; blob: Blob }
    | { type: "readFile"; id: number; path: string }
    | { type: "removeFile"; id: number; path: string }
    | { type: "listDir"; id: number; path: string };

export type EngineResponse =
    | { type: "reply"; id: number; ok: true; output?: Uint8Array | string[] | null }
    | { type: "reply"; id: number; ok: false; error?: Uint8Array; message: string }
    | { type: "progress"; progress: Uint8Array }
    | { type: "crashed"; message: string };

/** Folders in the virtual filesystem. */
export const VFS = {
    profiles: "/profiles",
    tmp: "/tmp",
    imports: "/tmp/imports",
    exports: "/tmp/exports",
} as const;

/** The OPFS layout. */
export const OPFS = {
    pool: "pool",
    profiles: "profiles",
} as const;

export function profilePaths(name: string) {
    const dir = `${VFS.profiles}/${name}`;
    return {
        dir,
        collection: `${dir}/collection.anki2`,
        mediaFolder: `${dir}/collection.media`,
        mediaDb: `${dir}/collection.media.db2`,
        backups: `${dir}/backups`,
    };
}
