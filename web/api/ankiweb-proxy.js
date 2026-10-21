// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// Forwards the sync meta request to AnkiWeb (see vercel.json). AnkiWeb answers
// it with a 308 when the account lives on another server, and the browser
// would follow that redirect cross-origin and fail, so the redirect is passed
// back as headers on a 200 for the engine to turn into a 308 again
// (src/lib/engine/http.ts).

export const config = { runtime: "edge" };

const HOST = /^([a-z0-9-]+\.)?ankiweb\.net$/;
const DROPPED = ["host", "origin", "referer", "cookie", "connection", "content-length"];

export default async function handler(req) {
    const url = new URL(req.url);
    const host = url.searchParams.get("host") ?? "";
    const path = url.searchParams.get("path") ?? "";
    if (!HOST.test(host)) {
        return new Response("host not allowed", { status: 403 });
    }
    const headers = new Headers();
    for (const [key, value] of req.headers) {
        if (!DROPPED.includes(key) && !key.startsWith("x-vercel-") && !key.startsWith("x-forwarded-")) {
            headers.set(key, value);
        }
    }
    const upstream = await fetch(`https://${host}/${path}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
        redirect: "manual",
    });
    const location = upstream.headers.get("location");
    if (upstream.status >= 300 && upstream.status < 400 && location) {
        return new Response(null, {
            status: 200,
            headers: { "x-ankiweb-redirect": String(upstream.status), "x-ankiweb-location": location },
        });
    }
    const out = new Headers();
    for (const [key, value] of upstream.headers) {
        if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key)) {
            out.set(key, value);
        }
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
}
