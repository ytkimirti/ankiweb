// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Profiles (desktop's ProfileManager): each has its own collection, media
 * folder and backups. Profile settings live in localStorage; the collection
 * lives in OPFS via the engine.
 */

import { closeCollection, createBackup, openCollection } from "@generated/backend";
import { get, writable } from "svelte/store";

import { profilePaths, VFS } from "../engine/protocol";
import { getEngine } from "./backend";

const PROFILES_KEY = "ankiweb:profiles";
const META_KEY = "ankiweb:meta";
const profileKey = (name: string) => `ankiweb:profile:${name}`;

interface ProfileList {
    names: string[];
    last: string | null;
}

function readJson<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
        return fallback;
    }
}

function writeJson(key: string, value: unknown): void {
    localStorage.setItem(key, JSON.stringify(value));
}

function profileList(): ProfileList {
    return readJson<ProfileList>(PROFILES_KEY, { names: [], last: null });
}

export const currentProfile = writable<string | null>(null);
export const profileNames = writable<string[]>(profileList().names);

export function lastProfile(): string | null {
    const list = profileList();
    return list.last && list.names.includes(list.last) ? list.last : list.names[0] ?? null;
}

const INVALID_NAME = /[/\\:*?"<>|]/;

export function validateProfileName(name: string): string | null {
    name = name.trim();
    if (!name || INVALID_NAME.test(name) || name === "." || name === "..") {
        return null;
    }
    return name;
}

export function addProfile(name: string): void {
    const list = profileList();
    if (list.names.includes(name)) {
        throw new Error(`A profile named "${name}" already exists.`);
    }
    list.names.push(name);
    writeJson(PROFILES_KEY, list);
    profileNames.set(list.names);
}

/** Removes a closed profile and everything stored for it. */
export async function removeProfile(name: string): Promise<void> {
    if (get(currentProfile) === name) {
        throw new Error("close the profile first");
    }
    const list = profileList();
    list.names = list.names.filter((n) => n !== name);
    if (list.last === name) {
        list.last = list.names[0] ?? null;
    }
    writeJson(PROFILES_KEY, list);
    localStorage.removeItem(profileKey(name));
    profileNames.set(list.names);
    await getEngine().deleteProfileData(name);
}

/** Renames a closed profile, moving its files. */
export async function renameProfile(oldName: string, newName: string): Promise<void> {
    if (get(currentProfile) === oldName) {
        throw new Error("close the profile first");
    }
    const list = profileList();
    if (list.names.includes(newName)) {
        throw new Error(`A profile named "${newName}" already exists.`);
    }
    await getEngine().renameProfileData(oldName, newName);
    list.names = list.names.map((n) => (n === oldName ? newName : n));
    if (list.last === oldName) {
        list.last = newName;
    }
    writeJson(PROFILES_KEY, list);
    const config = localStorage.getItem(profileKey(oldName));
    if (config) {
        localStorage.setItem(profileKey(newName), config);
        localStorage.removeItem(profileKey(oldName));
    }
    profileNames.set(list.names);
}

export async function openProfile(name: string): Promise<void> {
    const engine = getEngine();
    await engine.mountProfile(name);
    const paths = profilePaths(name);
    await openCollection({
        collectionPath: paths.collection,
        mediaFolderPath: paths.mediaFolder,
        mediaDbPath: paths.mediaDb,
    });
    const list = profileList();
    if (!list.names.includes(name)) {
        list.names.push(name);
    }
    list.last = name;
    writeJson(PROFILES_KEY, list);
    profileNames.set(list.names);
    currentProfile.set(name);
}

/** Closes the open profile, creating a backup first unless asked not to. */
export async function closeProfile(options: { backup?: boolean } = {}): Promise<void> {
    const name = get(currentProfile);
    if (!name) {
        return;
    }
    if (options.backup ?? true) {
        try {
            await backupNow(false);
        } catch (err) {
            console.warn("backup failed", err);
        }
    }
    await closeCollection({ downgradeToSchema11: false });
    await getEngine().unmountProfile(name);
    currentProfile.set(null);
}

/**
 * Forgets the media sync state, so the next sync checks every file (desktop's
 * media.force_resync). The collection is reopened, since it holds the media DB.
 */
export async function forceMediaResync(): Promise<void> {
    const name = get(currentProfile);
    if (!name) {
        return;
    }
    const paths = profilePaths(name);
    await closeCollection({ downgradeToSchema11: false });
    try {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            await getEngine().removeFile(paths.mediaDb + suffix).catch(() => {});
        }
    } finally {
        await openCollection({
            collectionPath: paths.collection,
            mediaFolderPath: paths.mediaFolder,
            mediaDbPath: paths.mediaDb,
        });
    }
}

/** Marks the schema modified, so the next sync is a full one (desktop's col.mod_schema). */
export async function setSchemaModified(): Promise<void> {
    await getEngine().db({ kind: "query", sql: "update col set scm=?", args: [Date.now()], first_row_only: false });
}

/** Creates a backup if enough time has passed (or always, if forced). */
export async function backupNow(force: boolean): Promise<boolean> {
    const name = get(currentProfile);
    if (!name) {
        return false;
    }
    const created = await createBackup(
        { backupFolder: profilePaths(name).backups, force, waitForCompletion: true },
        { alertOnError: false },
    );
    return created.val;
}

// Settings
//////////////////////////////////////////////////////////////////////////////

export function getProfileConfig<T = unknown>(key: string, fallback?: T): T {
    const name = get(currentProfile);
    if (!name) {
        return fallback as T;
    }
    const config = readJson<Record<string, unknown>>(profileKey(name), {});
    return (key in config ? config[key] : fallback) as T;
}

export function setProfileConfig(key: string, value: unknown): void {
    const name = get(currentProfile);
    if (!name) {
        return;
    }
    const config = readJson<Record<string, unknown>>(profileKey(name), {});
    if (value === undefined || value === null) {
        delete config[key];
    } else {
        config[key] = value;
    }
    writeJson(profileKey(name), config);
}

export function getMeta<T = unknown>(key: string, fallback?: T): T {
    const meta = readJson<Record<string, unknown>>(META_KEY, {});
    return (key in meta ? meta[key] : fallback) as T;
}

export function setMeta(key: string, value: unknown): void {
    const meta = readJson<Record<string, unknown>>(META_KEY, {});
    meta[key] = value;
    writeJson(META_KEY, meta);
}

export function importsPath(name: string): string {
    return `${VFS.imports}/${name}`;
}
