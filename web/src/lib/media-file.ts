// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Reads files from a profile's media folder in OPFS for the service worker,
 * which serves them at the site root like desktop's media server, and for
 * card frames on the card origin, whose service worker asks the app for them.
 */

export interface MediaFile {
    status: number;
    headers: Record<string, string>;
    body: Blob | null;
}

const MIME: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
    tif: "image/tiff",
    tiff: "image/tiff",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/ogg",
    wav: "audio/wav",
    flac: "audio/flac",
    m4a: "audio/mp4",
    aac: "audio/aac",
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    ogv: "video/ogg",
    mov: "video/quicktime",
    css: "text/css",
    js: "text/javascript",
    json: "application/json",
    html: "text/html",
    htm: "text/html",
    txt: "text/plain",
    ttf: "font/ttf",
    otf: "font/otf",
    woff: "font/woff",
    woff2: "font/woff2",
    pdf: "application/pdf",
    mjs: "text/javascript",
    wasm: "application/wasm",
    map: "application/json",
    webmanifest: "application/manifest+json",
};

/** The content type for a file name or path, by its extension. */
export function mimeType(name: string): string {
    return MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

/**
 * The media file a root path like "/cat%201.jpg" names, honouring a Range
 * header, which Safari needs for audio and video. Null if there is none.
 */
export async function readMediaFile(profile: string | null, path: string, range: string | null): Promise<MediaFile | null> {
    let name: string;
    try {
        name = decodeURIComponent(path.replace(/^\//, ""));
    } catch {
        return null;
    }
    if (!profile || !name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
        return null;
    }
    let file: File;
    try {
        const root = await navigator.storage.getDirectory();
        const profiles = await root.getDirectoryHandle("profiles");
        const dir = await (await profiles.getDirectoryHandle(profile)).getDirectoryHandle("collection.media");
        file = await (await dir.getFileHandle(name.normalize("NFC"))).getFile();
    } catch {
        return null;
    }
    const type = mimeType(name);
    const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" };
    const parsed = /^bytes=(\d*)-(\d*)$/.exec(range ?? "");
    if (parsed && (parsed[1] || parsed[2])) {
        const size = file.size;
        let start: number;
        let end: number;
        if (parsed[1]) {
            start = Number(parsed[1]);
            end = parsed[2] ? Math.min(Number(parsed[2]), size - 1) : size - 1;
        } else {
            start = Math.max(0, size - Number(parsed[2]));
            end = size - 1;
        }
        if (start >= size || start > end) {
            return { status: 416, headers: { "Content-Range": `bytes */${size}` }, body: null };
        }
        return {
            status: 206,
            headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
            body: file.slice(start, end + 1),
        };
    }
    return { status: 200, headers: { ...headers, "Content-Length": String(file.size) }, body: file };
}
