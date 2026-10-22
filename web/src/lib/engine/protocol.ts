// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** Messages between the main thread and the engine worker. */

export interface EngineInit {
    wasmUrl: string;
    /** Encoded anki.backend.BackendInit. */
    backendInit: Uint8Array;
    /**
     * [0] is set to 1 by the main thread to abort the running operation; [1]
     * counts requests sent, so background work can give way; [2] is how many
     * seconds a network request may go without traffic.
     */
    abortFlag: SharedArrayBuffer;
}

export type EngineRequest =
    | { type: "init"; id: number; init: EngineInit; ioPort: MessagePort }
    /** `quiet` calls wait for background work instead of interrupting it. */
    | { type: "call"; id: number; service: number; method: number; input: Uint8Array; quiet?: boolean }
    | { type: "db"; id: number; input: Uint8Array }
    /** Mounts /profiles/<name> with its media and backup folders. */
    | { type: "mountProfile"; id: number; name: string }
    | { type: "unmountProfile"; id: number; name: string }
    | { type: "cancelDownloads"; id: number }
    /** Deletes or renames an unmounted profile's files. */
    | { type: "deleteProfile"; id: number; name: string }
    | { type: "renameProfile"; id: number; name: string; newName: string }
    /** Names of the profiles with files in OPFS or the pool. */
    | { type: "storedProfiles"; id: number }
    /** Places a blob (such as a file to import) at a path in a memory-backed folder. */
    | { type: "putFile"; id: number; path: string; blob: Blob }
    | { type: "readFile"; id: number; path: string }
    /** Copies a file, such as a backup about to be restored, to another path. */
    | { type: "copyFile"; id: number; path: string; to: string }
    /**
     * Moves a finished export out of the engine to OPFS's exports folder as
     * `name`, so the page can download it from disk.
     */
    | { type: "exportFile"; id: number; path: string; name: string }
    | { type: "removeFile"; id: number; path: string }
    | { type: "listDir"; id: number; path: string };

export type EngineResponse =
    | { type: "reply"; id: number; ok: true; output?: Uint8Array | string[] | null }
    | { type: "reply"; id: number; ok: false; error?: Uint8Array; message: string }
    | { type: "progress"; progress: Uint8Array }
    /** Bytes of the engine downloaded so far during init, and whether that is all. */
    | { type: "loading"; loaded: number; done: boolean }
    /** Background tasks ran, or were cut short for a waiting request. */
    | { type: "background" }
    | { type: "crashed"; message: string };

/** Folders in the virtual filesystem. */
export const VFS = {
    profiles: "/profiles",
    tmp: "/tmp",
    imports: "/tmp/imports",
    /** Kept on disk in the file pool, not in memory: exports and copies of backups. */
    exports: "/tmp/exports",
} as const;

/** The OPFS layout. */
export const OPFS = {
    pool: "pool",
    profiles: "profiles",
    /** Finished exports waiting to be downloaded. */
    exports: "exports",
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
