// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Syntax Highlighting for Code, AnkiWeb 1463041493: an editor button (Alt+S)
 * that replaces the selected text, or pastes the clipboard, as highlighted
 * code. The original uses Pygments; this tokenizes with CodeMirror's language
 * modes and writes the same kind of HTML: Pygments' "default" colours inline
 * (or its class names), optional line numbers in a table, optionally centered.
 * The language is picked in a dialog that starts on the last one used.
 */

import "codemirror/addon/runmode/runmode";
import "codemirror/addon/mode/simple";
import "codemirror/mode/clike/clike";
import "codemirror/mode/clojure/clojure";
import "codemirror/mode/commonlisp/commonlisp";
import "codemirror/mode/css/css";
import "codemirror/mode/dart/dart";
import "codemirror/mode/diff/diff";
import "codemirror/mode/dockerfile/dockerfile";
import "codemirror/mode/erlang/erlang";
import "codemirror/mode/gas/gas";
import "codemirror/mode/go/go";
import "codemirror/mode/haskell/haskell";
import "codemirror/mode/htmlmixed/htmlmixed";
import "codemirror/mode/javascript/javascript";
import "codemirror/mode/julia/julia";
import "codemirror/mode/lua/lua";
import "codemirror/mode/markdown/markdown";
import "codemirror/mode/octave/octave";
import "codemirror/mode/perl/perl";
import "codemirror/mode/php/php";
import "codemirror/mode/powershell/powershell";
import "codemirror/mode/python/python";
import "codemirror/mode/r/r";
import "codemirror/mode/ruby/ruby";
import "codemirror/mode/rust/rust";
import "codemirror/mode/scheme/scheme";
import "codemirror/mode/shell/shell";
import "codemirror/mode/sql/sql";
import "codemirror/mode/stex/stex";
import "codemirror/mode/swift/swift";
import "codemirror/mode/xml/xml";
import "codemirror/mode/yaml/yaml";

import CodeMirror from "codemirror";

import type { EditorContext } from "$web/plugins/hooks";
import type { Plugin, PluginApi } from "$web/plugins/loader";

const LANGUAGES: Record<string, string> = {
    "Assembly (GAS)": "gas",
    Bash: "shell",
    C: "text/x-csrc",
    "C#": "text/x-csharp",
    "C++": "text/x-c++src",
    Clojure: "clojure",
    "Common Lisp": "commonlisp",
    CSS: "css",
    Dart: "dart",
    Diff: "diff",
    Dockerfile: "dockerfile",
    Erlang: "erlang",
    Go: "go",
    Haskell: "haskell",
    HTML: "htmlmixed",
    Java: "text/x-java",
    JavaScript: "javascript",
    JSON: "application/json",
    Julia: "julia",
    Kotlin: "text/x-kotlin",
    LaTeX: "stex",
    Lua: "lua",
    Markdown: "markdown",
    Matlab: "octave",
    "Objective-C": "text/x-objectivec",
    Perl: "perl",
    PHP: "text/x-php",
    PowerShell: "powershell",
    Python: "python",
    R: "r",
    Ruby: "ruby",
    Rust: "rust",
    Scala: "text/x-scala",
    Scheme: "scheme",
    SQL: "text/x-sql",
    Swift: "swift",
    TypeScript: "text/typescript",
    XML: "xml",
    YAML: "yaml",
};

/** CodeMirror token types as Pygments token classes and their "default" style. */
const TOKENS: Record<string, [cls: string, style: string]> = {
    keyword: ["k", "color: #008000; font-weight: bold"],
    atom: ["kc", "color: #008000; font-weight: bold"],
    number: ["m", "color: #666666"],
    def: ["nf", "color: #0000FF"],
    "variable-2": ["nv", "color: #19177C"],
    "variable-3": ["kt", "color: #B00040"],
    type: ["kt", "color: #B00040"],
    operator: ["o", "color: #666666"],
    comment: ["c", "color: #3D7B7B; font-style: italic"],
    string: ["s", "color: #BA2121"],
    "string-2": ["sr", "color: #A45A77"],
    meta: ["cp", "color: #9C6500"],
    qualifier: ["nd", "color: #AA22FF"],
    builtin: ["nb", "color: #008000"],
    tag: ["nt", "color: #008000; font-weight: bold"],
    attribute: ["na", "color: #687822"],
    header: ["gh", "color: #000080; font-weight: bold"],
    quote: ["ge", "font-style: italic"],
    link: ["nl", "color: #767600"],
    positive: ["gi", "color: #008400"],
    negative: ["gd", "color: #A00000"],
    error: ["err", "border: 1px solid #FF0000"],
};

interface Config {
    hotkey: string;
    lastLanguage: string;
    linenos: boolean;
    centerfragments: boolean;
    cssclasses: boolean;
    /** Languages to offer, comma separated; empty for all. */
    limitToLangs: string;
}

const DEFAULTS: Config = {
    hotkey: "Alt+S",
    lastLanguage: "Python",
    linenos: true,
    centerfragments: true,
    cssclasses: false,
    limitToLangs: "",
};

function escapeHtml(text: string): string {
    return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Highlighted HTML for code, in the shape Pygments' HtmlFormatter writes. */
export function highlight(
    code: string,
    language: string,
    config: Pick<Config, "linenos" | "centerfragments" | "cssclasses">,
): string {
    const mode = LANGUAGES[language] ?? "text/plain";
    let body = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (CodeMirror as any).runMode(
        code.replace(/\r\n?/g, "\n").replace(/\n$/, ""),
        mode,
        (text: string, style?: string | null) => {
            const token = style?.split(" ").map((s) => TOKENS[s]).find(Boolean);
            const escaped = escapeHtml(text);
            if (!token) {
                body += escaped;
            } else if (config.cssclasses) {
                body += `<span class="${token[0]}">${escaped}</span>`;
            } else {
                body += `<span style="${token[1]}">${escaped}</span>`;
            }
        },
    );
    const lines = body.split("\n").length;
    // Pygments sets no text colour, which leaves plain text unreadable on this background in night mode
    const highlightClass = config.cssclasses
        ? `class="highlight"`
        : `class="highlight" style="background: #f8f8f8; color: #000000"`;
    const pre = `<div ${highlightClass}><pre style="line-height: 125%; margin: 0">${body}</pre></div>`;
    let html = config.linenos
        ? `<table class="highlighttable"><tbody><tr><td class="linenos"><div class="linenodiv"><pre style="line-height: 125%; margin: 0; color: #6e6e6e; text-align: right; padding: 0 5px">${
            Array.from({ length: lines }, (_, i) => i + 1).join("\n")
        }</pre></div></td><td class="code">${pre}</td></tr></tbody></table>`
        : pre;
    // keep Anki from reading code as field references or clozes
    html = html.replace(/\{\{/g, "{<!---->{").replace(/\}\}/g, "}<!---->}").replace(/::/g, ":<!---->:");
    return config.centerfragments ? `<center>${html}</center><br>` : `${html}<br>`;
}

async function paste(api: PluginApi, editor: EditorContext): Promise<void> {
    const config = { ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) };
    let code = editor.selectedText();
    const restore = editor.keepSelection();
    if (!code) {
        code = await navigator.clipboard?.readText().catch(() => "") ?? "";
    }
    if (!code.trim()) {
        await api.dialogs.showWarning("Select the code to highlight, or copy it first.");
        await restore();
        return;
    }
    const allowed = config.limitToLangs.split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);
    const languages = Object.keys(LANGUAGES)
        .filter((l) => !allowed.length || allowed.includes(l.toLowerCase()))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const choice = await api.dialogs.chooseFrom("Language:", languages, {
        title: "Syntax Highlighting",
        selected: Math.max(0, languages.indexOf(config.lastLanguage)),
        filter: true,
    });
    await restore();
    if (choice === null) {
        return;
    }
    const language = languages[choice];
    api.setConfig({ ...config, lastLanguage: language });
    editor.insertHtml(highlight(code, language, config));
}

export default {
    name: "Syntax Highlighting for Code",
    setup(api) {
        api.hooks.editorDidInitButtons.append((buttons) => {
            const config = { ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) };
            buttons.push({
                id: "syntax-highlighting",
                label: "<b style=\"font-family: ui-monospace, monospace; font-size: 0.8em\">CH</b>",
                tip: "Paste highlighted code",
                keys: config.hotkey || undefined,
                onClick: (editor) => void paste(api, editor).catch((err) => api.dialogs.showError(err)),
            });
        });
        api.setConfigAction(async () => {
            const config = { ...DEFAULTS, ...api.getConfig<Partial<Config>>({}) };
            const values = await api.dialogs.openForm(
                [
                    { key: "linenos", label: "Line numbers", type: "checkbox", value: config.linenos },
                    {
                        key: "centerfragments",
                        label: "Center code fragments",
                        type: "checkbox",
                        value: config.centerfragments,
                    },
                    {
                        key: "cssclasses",
                        label: "Use CSS classes instead of inline styles",
                        type: "checkbox",
                        value: config.cssclasses,
                    },
                    { key: "hotkey", label: "Hotkey", type: "text", value: config.hotkey },
                    {
                        key: "limitToLangs",
                        label: "Only offer these languages (comma separated)",
                        type: "text",
                        value: config.limitToLangs,
                        placeholder: "Python, JavaScript",
                    },
                ],
                { title: "Syntax Highlighting Options" },
            );
            if (values) {
                api.setConfig({ ...config, ...values });
            }
        });
    },
} satisfies Plugin;
