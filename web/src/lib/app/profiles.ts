// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Profiles (desktop's ProfileManager): each has its own collection, media
 * folder and backups. Profile settings live in localStorage; the collection
 * lives in OPFS via the engine.
 */

import { closeCollection, createBackup, getUndoStatus, openCollection } from "@generated/backend";
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

/**
 * Renames a closed profile, moving its files. The list is written first, so
 * that if the page dies while the files move, the profile they move to is
 * listed (and boot lists the old name again if anything was left there).
 */
export async function renameProfile(oldName: string, newName: string): Promise<void> {
    if (get(currentProfile) === oldName) {
        throw new Error("close the profile first");
    }
    const before = profileList();
    if (before.names.includes(newName)) {
        throw new Error(`A profile named "${newName}" already exists.`);
    }
    const moveConfig = (from: string, to: string) => {
        const config = localStorage.getItem(profileKey(from));
        if (config) {
            localStorage.setItem(profileKey(to), config);
            localStorage.removeItem(profileKey(from));
        }
    };
    const list = {
        names: before.names.map((n) => (n === oldName ? newName : n)),
        last: before.last === oldName ? newName : before.last,
    };
    writeJson(PROFILES_KEY, list);
    moveConfig(oldName, newName);
    try {
        await getEngine().renameProfileData(oldName, newName);
    } catch (err) {
        writeJson(PROFILES_KEY, before);
        moveConfig(newName, oldName);
        throw err;
    }
    profileNames.set(list.names);
}

/**
 * Lists profiles whose files are stored but which the list lacks, such as
 * after the browser lost the list but kept the files.
 */
export async function addStoredProfiles(): Promise<void> {
    const stored = await getEngine().storedProfiles();
    const list = profileList();
    const missing = stored.filter((name) => !list.names.includes(name) && validateProfileName(name) === name);
    if (missing.length) {
        console.warn("listing stored profiles that were not listed:", missing);
        list.names.push(...missing.sort());
        writeJson(PROFILES_KEY, list);
        profileNames.set(list.names);
    }
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

/** True if the next sync will be a full one anyway (desktop's col.schema_changed). */
export async function schemaChanged(): Promise<boolean> {
    const rows = (await getEngine().db({
        kind: "query",
        sql: "select scm > ls from col",
        args: [],
        first_row_only: true,
    })) as unknown[][] | null;
    return !!rows?.[0]?.[0];
}

/**
 * Backs up before an operation that replaces the collection. If that fails,
 * asks whether to go on regardless; resolves false if not.
 */
export async function backupBeforeChange(force = true): Promise<boolean> {
    const { withProgress } = await import("./progress");
    const trq = await import("@generated/ftl-qt");
    try {
        await withProgress(() => backupNow(force), { label: trq.qtMiscBackingUp() });
        return true;
    } catch (err) {
        const { askUser, errorMessage } = await import("./dialogs");
        return askUser(`The backup failed: ${errorMessage(err)}\n\nContinue anyway?`, { defaultNo: true, danger: true });
    }
}

/** The collection could not be opened again after an operation closed it: nothing works until a reload. */
export async function reopenFailed(err: unknown): Promise<void> {
    try {
        // still open, if the operation failed before it closed it
        await getUndoStatus({}, { alertOnError: false });
        return;
    } catch {
        // closed
    }
    console.error(err);
    const { errorMessage, openDialog } = await import("./dialogs");
    await openDialog({
        kind: "critical",
        text: `Anki could not open your collection again: ${errorMessage(err)}\n\nReload to try again.`,
        dismissable: false,
        buttons: [{ label: "Reload", value: "reload", primary: true }],
    });
    location.reload();
}

/** Desktop's mw.confirm_schema_modification, defaulting to No as a full sync can lose changes. */
export async function confirmSchemaModification(): Promise<boolean> {
    if (await schemaChanged()) {
        return true;
    }
    const { askUser } = await import("./dialogs");
    const trq = await import("@generated/ftl-qt");
    return askUser(trq.qtMiscTheRequestedChangeWillRequireA(), { defaultNo: true });
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
