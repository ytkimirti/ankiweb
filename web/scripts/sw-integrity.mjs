// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// Run after `vite build`: writes the SHA-256 of every file in web/build into
// build/service-worker.js. On the card origin, card scripts can write to the
// service worker's caches, so the worker checks cached files against these
// before serving them (see src/service-worker.ts). Also writes the list of
// files to precache, since SvelteKit's leaves out worker scripts, then runs
// the worker's install to check that it caches every file, and that it fails
// on a file that is not the one built.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import vm from "node:vm";

const build = join(import.meta.dirname, "..", "build");
const workerPath = join(build, "service-worker.js");
const PLACEHOLDER = /(["'`])__ANKIWEB_INTEGRITY__\1/;
const SIZES_PLACEHOLDER = /(["'`])__ANKIWEB_SIZES__\1/;
const FILES_PLACEHOLDER = /(["'`])__ANKIWEB_FILES__\1/;
/** Not precached: the shell is cached as "/", and the version is checked online. */
const UNCACHED = ["/index.html", "/_app/version.json"];
/** Cached by the worker when first used. */
const RUNTIME_PREFIX = "/_anki/js/vendor/";

function walk(dir) {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("base64");

const hashes = {};
const sizes = {};
for (const path of walk(build)) {
    if (path !== workerPath) {
        const key = `/${relative(build, path).split(sep).join("/")}`;
        hashes[key] = sha256(path);
        sizes[key] = statSync(path).size;
    }
}
// the app shell is cached under "/"
hashes["/"] = hashes["/index.html"];
sizes["/"] = sizes["/index.html"];

const files = Object.keys(sizes).filter((key) => key !== "/" && !UNCACHED.includes(key));

const worker = readFileSync(workerPath, "utf8");
if (!PLACEHOLDER.test(worker) || !SIZES_PLACEHOLDER.test(worker) || !FILES_PLACEHOLDER.test(worker)) {
    console.error("sw-integrity: placeholder not found in service-worker.js (already processed?)");
    process.exit(1);
}
// a string literal of JSON, which the worker parses
const processed = worker
    .replace(PLACEHOLDER, () => JSON.stringify(JSON.stringify(hashes)))
    .replace(SIZES_PLACEHOLDER, () => JSON.stringify(JSON.stringify(sizes)))
    .replace(FILES_PLACEHOLDER, () => JSON.stringify(JSON.stringify(files)));

const expected = [...files, "/"].filter((key) => !key.startsWith(RUNTIME_PREFIX));
const cached = await installedFiles(processed);
const uncached = expected.filter((key) => !cached.has(key));
if (uncached.length) {
    console.error(`sw-integrity: the service worker does not precache ${uncached.join(", ")}`);
    process.exit(1);
}
// as a server with a newer version answers for a file it no longer has
if (await installedFiles(processed, "/").then(() => true, () => false)) {
    console.error("sw-integrity: the service worker installs with a file that is not the one built");
    process.exit(1);
}
writeFileSync(workerPath, processed);
console.log(`sw-integrity: ${Object.keys(hashes).length} files`);

/**
 * Runs the worker's install event on the app's origin, serving the built
 * files (and something else for `wrong`), and returns the paths it fetched.
 */
async function installedFiles(code, wrong) {
    const fetched = new Set();
    const handlers = {};
    // reading the body as the browser's cache does
    const cache = { put: (_, response) => response.arrayBuffer(), match: async () => undefined, delete: async () => true };
    const location = new URL("https://app.invalid/service-worker.js");
    const self = {
        location,
        addEventListener: (type, fn) => (handlers[type] = fn),
        registration: { active: null },
        clients: { matchAll: async () => [], claim: async () => {} },
        skipWaiting: async () => {},
    };
    const context = vm.createContext({
        self,
        location,
        navigator: { userAgent: "Chrome/1" },
        caches: { open: async () => cache, delete: async () => true, keys: async () => [] },
        fetch: async (path) => {
            fetched.add(String(path));
            const file = join(build, String(path) === "/" ? "index.html" : String(path));
            return new Response(String(path) === wrong ? "<!doctype html>" : readFileSync(file));
        },
        console,
        crypto,
        btoa,
        AbortController,
        Blob,
        Headers,
        Response,
        TransformStream,
        URL,
    });
    vm.runInContext(code, context);
    let installed;
    handlers.install({ waitUntil: (promise) => (installed = promise) });
    await installed;
    return fetched;
}
