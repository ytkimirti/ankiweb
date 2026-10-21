// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import svg from "@poppanator/sveltekit-svg";
import { sveltekit } from "@sveltejs/kit/vite";
import type { IncomingMessage, ServerResponse } from "http";
import { readFileSync, realpathSync } from "fs";
import { defineConfig, type Plugin } from "vite";

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
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
        if (key === "location") {
            value = value.replace(/^https:\/\/([^/]+)\//, `${PROXY_PREFIX}$1/`);
        }
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

export default defineConfig({
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
});
