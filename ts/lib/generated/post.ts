// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

export interface PostProtoOptions {
    /** True by default. Shows a dialog with the error message, then rethrows. */
    alertOnError?: boolean;
    /** If this is set, the request can be canceled by calling abort() on the corresponding AbortController. */
    signal?: AbortSignal;
    /** Passed to the transport; the web build uses it to tell screens which of them made a change. */
    initiator?: unknown;
}

/**
 * Hosts that run the backend in-process (the web build) install a transport
 * here instead of serving /_anki/ over HTTP. It receives the camelCase method
 * name and the encoded input, and resolves to the encoded output.
 */
export type ProtoTransport = (
    method: string,
    input: Uint8Array,
    opChangesType: number,
    signal?: AbortSignal,
    initiator?: unknown,
) => Promise<Uint8Array>;

let transport: ProtoTransport | null = null;
let alertOnErrorDefault = true;

export function setProtoTransport(newTransport: ProtoTransport | null): void {
    transport = newTransport;
}

/** Hosts with their own error reporting can turn off the default alert(). */
export function setAlertOnErrorDefault(alert: boolean): void {
    alertOnErrorDefault = alert;
}

export async function postProto<T>(
    method: string,
    input: { toBinary(): Uint8Array; getType(): { typeName: string } },
    outputType: { fromBinary(arr: Uint8Array): T },
    options: PostProtoOptions = {},
    opChangesType = 0,
): Promise<T> {
    const { alertOnError = alertOnErrorDefault, signal = undefined } = options;
    try {
        const inputBytes = input.toBinary();
        const path = `/_anki/${method}`;
        const outputBytes = transport
            ? await transport(method, inputBytes, opChangesType, signal, options.initiator)
            : await postProtoInner(path, inputBytes, opChangesType, signal);
        return outputType.fromBinary(outputBytes);
    } catch (err) {
        if (
            alertOnError && !(err instanceof Error && (err.message === "500: Interrupted" || err.name === "AbortError"))
        ) {
            alert(err);
        }
        throw err;
    }
}

async function postProtoInner(
    url: string,
    body: Uint8Array,
    opChangesType: number,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    const result = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/binary", "Anki-Op-Changes": opChangesType.toString() },
        body,
        signal,
    });
    if (!result.ok) {
        let msg = "something went wrong";
        try {
            msg = await result.text();
        } catch {
            // ignore
        }
        throw new Error(process.env.NODE_ENV === "production" ? `${msg}` : `${result.status}: ${msg}`);
    }
    const blob = await result.blob();
    const respBuf = await new Response(blob).arrayBuffer();
    return new Uint8Array(respBuf);
}
