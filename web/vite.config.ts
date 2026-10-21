// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import svg from "@poppanator/sveltekit-svg";
import { sveltekit } from "@sveltejs/kit/vite";
import type { IncomingMessage, ServerResponse } from "http";
import { readFileSync, realpathSync } from "fs";
import { fileURLToPath } from "url";
import { defineConfig, loadEnv, type Plugin } from "vite";

/** Headers that make the page cross-origin isolated, which SharedArrayBuffer needs. */
export const isolationHeaders = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "credentialless",
};

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
            for (const [key, value] of Object.entries(isolationHeaders)) {
                res.setHeader(key, value);
            }
            // card frames may come from another origin (lib/config.ts)
            // (require-corp for Safari, which cannot embed credentialless frames)
            if (req.url?.startsWith("/reviewer")) {
                res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
                if (!/Chrome\/|Firefox\//.test(req.headers["user-agent"] ?? "")) {
                    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
                }
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
        configurePreviewServer: install,
    };
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
