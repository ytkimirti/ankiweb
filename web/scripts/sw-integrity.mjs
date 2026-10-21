// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// Run after `vite build`: writes the SHA-256 of every file in web/build into
// build/service-worker.js. On the card origin, card scripts can write to the
// service worker's caches, so the worker checks cached files against these
// before serving them (see src/service-worker.ts).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const build = join(import.meta.dirname, "..", "build");
const workerPath = join(build, "service-worker.js");
const PLACEHOLDER = /(["'`])__ANKIWEB_INTEGRITY__\1/;

function walk(dir) {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("base64");

const hashes = {};
for (const path of walk(build)) {
    if (path !== workerPath) {
        hashes[`/${relative(build, path).split(sep).join("/")}`] = sha256(path);
    }
}
// the app shell is cached under "/"
hashes["/"] = hashes["/index.html"];

const worker = readFileSync(workerPath, "utf8");
if (!PLACEHOLDER.test(worker)) {
    console.error("sw-integrity: placeholder not found in service-worker.js (already processed?)");
    process.exit(1);
}
// a string literal of JSON, which the worker parses
writeFileSync(workerPath, worker.replace(PLACEHOLDER, () => JSON.stringify(JSON.stringify(hashes))));
console.log(`sw-integrity: ${Object.keys(hashes).length} files`);
