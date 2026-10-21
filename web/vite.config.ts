// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import svg from "@poppanator/sveltekit-svg";
import { sveltekit } from "@sveltejs/kit/vite";
import type { IncomingMessage, ServerResponse } from "http";
import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { extname, join, normalize } from "path";
import { fileURLToPath } from "url";
import { gzipSync } from "zlib";
import { defineConfig, loadEnv, type Plugin } from "vite";

/**
 * The COEP that makes a page cross-origin isolated, which SharedArrayBuffer
 * needs: credentialless where supported, else require-corp (Safari and every
 * iOS browser), as in vercel.json and the service worker.
 */
function embedderPolicy(userAgent: string | undefined): string {
    return /(Chrome|Firefox)\//.test(userAgent ?? "") ? "credentialless" : "require-corp";
}

const PROXY_PREFIX = "/ankiweb-proxy/";
const PROXIED_HOST = /^([a-z0-9-]+\.)?ankiweb\.net$/;

/**
 * Forwards /ankiweb-proxy/<host>/<path> to https://<host>/<path> for AnkiWeb
 * hosts, since AnkiWeb does not allow cross-origin requests. Production uses
 * the rewrites in vercel.json instead.
 */
async function proxyAnkiWeb(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rest = (req.url ?? "").slice(PROXY_PREFIX.length);
    const slash = rest.indexOf("/");
    const host = slash < 0 ? rest : rest.slice(0, slash);
    if (!PROXIED_HOST.test(host)) {
        res.statusCode = 403;
        res.end("host not allowed");
        return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk as Buffer);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string" && !["host", "origin", "referer", "cookie", "connection"].includes(key)) {
            headers.set(key, value);
        }
    }
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const upstream = await fetch(`https://${rest}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
        redirect: "manual",
    });
    // as api/ankiweb-proxy.js does, so the browser does not follow it
    const location = upstream.headers.get("location");
    if (upstream.status >= 300 && upstream.status < 400 && location) {
        res.setHeader("x-ankiweb-redirect", String(upstream.status));
        res.setHeader("x-ankiweb-location", location);
        res.end();
        return;
    }
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
        if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key)) {
            res.setHeader(key, value);
        }
    });
    res.end(Buffer.from(await upstream.arrayBuffer()));
}

function devServerExtras(): Plugin {
    const install = (server: { middlewares: { use: (fn: any) => void } }) => {
        server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
            res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
            res.setHeader("Cross-Origin-Embedder-Policy", embedderPolicy(req.headers["user-agent"]));
            // card frames may come from another origin (lib/config.ts)
            if (req.url?.startsWith("/reviewer")) {
                res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
            }
            if (req.url?.startsWith(PROXY_PREFIX)) {
                proxyAnkiWeb(req, res).catch((err) => {
                    res.statusCode = 502;
                    res.end(String(err));
                });
                return;
            }
            next();
        });
    };
    return {
        name: "ankiweb-dev-server",
        configureServer: install,
        configurePreviewServer(server) {
            install(server);
            server.middlewares.use(serveBuild(join(fileURLToPath(new URL(".", import.meta.url)), "build")));
        },
    };
}

const COMPRESSIBLE: Record<string, string> = {
    ".wasm": "application/wasm",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".html": "text/html",
    ".ftl": "text/plain",
};

/**
 * For `vite preview`: serves the finished build (build/, whose service worker
 * has its integrity hashes), gzipped as production hosting would, since the
 * engine alone is 15 MB.
 */
function serveBuild(dir: string) {
    const gzipped = new Map<string, { mtimeMs: number; body: Buffer }>();
    return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        let path: string;
        try {
            path = normalize(decodeURIComponent((req.url ?? "").split("?")[0]));
        } catch {
            return next();
        }
        const type = COMPRESSIBLE[extname(path)];
        const file = join(dir, path);
        if (req.method !== "GET" || !type || !file.startsWith(dir + "/") || !existsSync(file) || !statSync(file).isFile()) {
            return next();
        }
        res.setHeader("Content-Type", type);
        res.setHeader("Vary", "Accept-Encoding");
        res.setHeader("Cache-Control", path.startsWith("/_app/immutable/") ? "public, max-age=31536000, immutable" : "no-cache");
        if (!/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
            res.end(readFileSync(file));
            return;
        }
        const { mtimeMs } = statSync(file);
        let entry = gzipped.get(file);
        if (entry?.mtimeMs !== mtimeMs) {
            entry = { mtimeMs, body: gzipSync(readFileSync(file)) };
            gzipped.set(file, entry);
        }
        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("Content-Length", entry.body.length);
        res.end(entry.body);
    };
}

/** The engine's size, so its download can show progress whatever the transfer encoding. */
function wasmSize(): number {
    const path = fileURLToPath(new URL("./static/engine/anki.wasm", import.meta.url));
    return existsSync(path) ? statSync(path).size : 0;
}

/** A misread card origin would quietly run cards on the app's origin. */
function checkCardOrigin(cardOrigin: string | undefined): void {
    if (!cardOrigin) {
        return;
    }
    let valid = false;
    try {
        valid = ["https:", "http:"].includes(new URL(cardOrigin).protocol);
    } catch {
        // not a URL
    }
    if (!valid) {
        throw new Error(`VITE_CARD_ORIGIN must be an origin like https://cards.example.com, not ${cardOrigin}`);
    }
}

export default defineConfig(({ mode }) => {
    // as Vite reads it: the environment, then .env files
    checkCardOrigin(loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_").VITE_CARD_ORIGIN);
    return {
        plugins: [
            devServerExtras(),
            sveltekit(),
            svg({ svgoOptions: { plugins: [{ name: "cleanupIds", params: { remove: false } }] } }),
        ],
        cacheDir: "../node_modules/.vite-web",
        define: {
            __ANKI_VERSION__: JSON.stringify(readFileSync("../.version", "utf8").trim()),
            __ANKI_WASM_SIZE__: JSON.stringify(wasmSize()),
        },
        build: {
            reportCompressedSize: false,
            target: "es2022",
            chunkSizeWarningLimit: 4096,
        },
        worker: { format: "es" },
        server: {
            host: "0.0.0.0",
            port: 5173,
            fs: { allow: [realpathSync("..")] },
        },
        preview: { host: "0.0.0.0", port: 4173 },
    };
});
