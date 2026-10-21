// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { dirname, join } from "path";
import preprocess from "svelte-preprocess";
import { fileURLToPath } from "url";

const webFolder = dirname(fileURLToPath(import.meta.url));
const tsFolder = join(webFolder, "../ts");

/** @type {import('@sveltejs/kit').Config} */
const config = {
    preprocess: [vitePreprocess(), preprocess()],
    // ts/ code is compiled with the same settings it uses on desktop
    compilerOptions: {},
    kit: {
        adapter: adapter({ pages: "build", assets: "build", fallback: "index.html", precompress: false }),
        alias: {
            "@tslib": join(tsFolder, "lib/tslib"),
            "@generated": join(webFolder, "../out/ts/lib/generated"),
            "$ts": tsFolder,
            "$web": join(webFolder, "src/lib"),
        },
        files: {
            // $lib keeps pointing at ts/lib, so the desktop components resolve unchanged
            lib: join(tsFolder, "lib"),
            routes: join(webFolder, "src/routes"),
            appTemplate: join(webFolder, "src/app.html"),
            hooks: { client: join(webFolder, "src/hooks.client") },
            serviceWorker: join(webFolder, "src/service-worker"),
            assets: join(webFolder, "static"),
        },
        serviceWorker: { register: false },
        outDir: join(webFolder, ".svelte-kit"),
        output: { preloadStrategy: "modulepreload" },
        prerender: { entries: [] },
        paths: { relative: false },
    },
};

export default config;
