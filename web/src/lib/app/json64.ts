// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * JSON that keeps 64-bit integers intact. Legacy notetype JSON holds random
 * i64 field and template ids, which JSON.parse() would round.
 */

const MARK = "\u0000i64:";

/** Parses JSON, turning integers too large for a double into marked strings. */
export function parseJson64<T = any>(text: string): T {
    let out = "";
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === "\"") {
            // copy the string through, honouring escapes
            let j = i + 1;
            while (j < text.length && text[j] !== "\"") {
                j += text[j] === "\\" ? 2 : 1;
            }
            out += text.slice(i, j + 1);
            i = j + 1;
        } else if (c === "-" || (c >= "0" && c <= "9")) {
            let j = i + 1;
            while (j < text.length && /[0-9.eE+-]/.test(text[j])) {
                j++;
            }
            const token = text.slice(i, j);
            out += /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(MARK + token) : token;
            i = j;
        } else {
            out += c;
            i++;
        }
    }
    return JSON.parse(out);
}

/** Stringifies, writing marked strings back as bare integers. */
export function stringifyJson64(value: unknown): string {
    return JSON.stringify(value).replace(/"\\u0000i64:(-?\d+)"/g, "$1");
}

export function decodeJson64<T = any>(bytes: Uint8Array): T {
    return parseJson64<T>(new TextDecoder().decode(bytes));
}

export function encodeJson64(value: unknown): Uint8Array {
    return new TextEncoder().encode(stringifyJson64(value));
}
