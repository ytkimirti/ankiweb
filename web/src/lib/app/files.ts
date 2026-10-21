// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Moving files between the user's device and the engine's virtual
 * filesystem: picking files to import, and downloading exports.
 */

import { VFS } from "../engine/protocol";
import { getEngine } from "./backend";

/** Shows the browser's file picker. Resolves to [] if the user cancels. */
export function pickFiles(options: { accept?: string; multiple?: boolean } = {}): Promise<File[]> {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = options.accept ?? "";
        input.multiple = !!options.multiple;
        input.style.display = "none";
        let settled = false;
        const finish = (files: File[]) => {
            if (!settled) {
                settled = true;
                input.remove();
                resolve(files);
            }
        };
        input.addEventListener("change", () => finish([...(input.files ?? [])]));
        input.addEventListener("cancel", () => finish([]));
        document.body.appendChild(input);
        input.click();
    });
}

let uploadCounter = 0;

/** Characters the engine's paths cannot contain. */
function safeName(name: string): string {
    return name.replace(/[/\\:*?"<>|\0]/g, "_") || "file";
}

/**
 * Makes a file readable by the engine, returning its virtual path. The file
 * is read lazily, so large imports are not copied into memory up front.
 */
export async function fileToEnginePath(file: Blob, name: string): Promise<string> {
    const path = `${VFS.imports}/${++uploadCounter}-${safeName(name)}`;
    await getEngine().putFile(path, file);
    return path;
}

/** The filename part of a virtual path, without our upload prefix. */
export function displayName(path: string): string {
    const base = path.split("/").pop() ?? path;
    return path.startsWith(VFS.imports) ? base.replace(/^\d+-/, "") : base;
}

export function downloadBlob(data: Blob | Uint8Array, filename: string, type = "application/octet-stream"): void {
    const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Reads a file the engine wrote (eg an export) and removes it. */
export async function takeEngineFile(path: string): Promise<Uint8Array> {
    const engine = getEngine();
    const data = await engine.readFile(path);
    await engine.removeFile(path);
    return data;
}

export function newExportPath(filename: string): string {
    return `${VFS.exports}/${safeName(filename)}`;
}

export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "svg", "webp", "ico", "avif", "tif", "tiff", "bmp"];
export const AUDIO_EXTENSIONS = ["mp3", "ogg", "wav", "m4a", "opus", "flac", "oga", "spx", "aac", "3gp", "amr"];
export const VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "mkv", "avi", "mpg", "mpeg", "ogv", "m4v", "flv", "3gp"];
