// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Collection content (deck descriptions, notetype names) can come from shared
 * decks. Desktop shows it in a webview; here it would run in the app's own
 * page, so it is reduced to a safe subset of HTML first.
 */

const ALLOWED_TAGS = new Set([
    "a", "abbr", "b", "big", "blockquote", "br", "center", "code", "dd", "del", "div", "dl", "dt", "em", "font",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s",
    "small", "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u",
    "ul",
]);

const ALLOWED_ATTRIBUTES = new Set(["alt", "class", "colspan", "color", "height", "href", "rowspan", "src", "title", "width"]);

/** Dropped along with their contents. */
const DROPPED_TAGS = new Set(["script", "style", "template", "noscript", "iframe", "object", "embed", "svg", "math"]);

function safeUrl(value: string, forImage: boolean): boolean {
    const url = value.trim().toLowerCase();
    if (/^(https?:|mailto:)/.test(url)) {
        return true;
    }
    if (forImage && url.startsWith("data:image/") && !url.startsWith("data:image/svg")) {
        return true;
    }
    // relative references, e.g. media files
    return !/^[a-z][a-z0-9+.-]*:/.test(url);
}

function clean(node: Node, doc: Document): Node | null {
    if (node.nodeType === Node.TEXT_NODE) {
        return doc.createTextNode(node.textContent ?? "");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
        return null;
    }
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (DROPPED_TAGS.has(tag)) {
        return null;
    }
    const children = [...el.childNodes].map((child) => clean(child, doc)).filter((c): c is Node => !!c);
    if (!ALLOWED_TAGS.has(tag)) {
        const fragment = doc.createDocumentFragment();
        fragment.append(...children);
        return fragment;
    }
    const out = doc.createElement(tag);
    for (const attr of el.attributes) {
        const name = attr.name.toLowerCase();
        if (!ALLOWED_ATTRIBUTES.has(name)) {
            continue;
        }
        if ((name === "href" || name === "src") && !safeUrl(attr.value, name === "src")) {
            continue;
        }
        out.setAttribute(name, attr.value);
    }
    if (tag === "a") {
        out.setAttribute("target", "_blank");
        out.setAttribute("rel", "noopener noreferrer");
    }
    out.append(...children);
    return out;
}

export function sanitizeHtml(html: string): string {
    // a parsed (not live) document runs no scripts and loads nothing
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const doc = document.implementation.createHTMLDocument("");
    const container = doc.createElement("div");
    for (const child of [...parsed.body.childNodes]) {
        const cleaned = clean(child, doc);
        if (cleaned) {
            container.append(cleaned);
        }
    }
    return container.innerHTML;
}

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
