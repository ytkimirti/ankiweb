// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Files kept for a plugin (desktop add-ons' user_files folder), such as
 * images the user picked, in IndexedDB. They stay on this device: they are
 * not part of the collection or its media, so they are never synced.
 */

const DB_NAME = "ankiweb-plugin-files";
const STORE = "files";

export interface PluginFiles {
    get(name: string): Promise<Blob | null>;
    put(name: string, blob: Blob): Promise<void>;
    remove(name: string): Promise<void>;
    list(): Promise<string[]>;
}

let opened: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
    opened ??= new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
            opened = null;
            reject(request.error);
        };
    });
    return opened;
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await database();
    return new Promise((resolve, reject) => {
        const request = fn(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export function pluginFiles(plugin: string): PluginFiles {
    const prefix = `${plugin}/`;
    return {
        async get(name) {
            const value = await run("readonly", (store) => store.get(prefix + name));
            return value instanceof Blob ? value : null;
        },
        async put(name, blob) {
            await run("readwrite", (store) => store.put(blob, prefix + name));
        },
        async remove(name) {
            await run("readwrite", (store) => store.delete(prefix + name));
        },
        async list() {
            const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
            const keys = await run("readonly", (store) => store.getAllKeys(range));
            return keys.map((key) => String(key).slice(prefix.length));
        },
    };
}
