// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Collection changes made by backend operations, broadcast so screens can
 * refresh (desktop's operation_did_execute hook).
 */

import { OpChanges } from "@generated/anki/collection_pb";

type Listener = (changes: OpChanges) => void;

const listeners = new Set<Listener>();

export function onOpChanges(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function emitOpChanges(changes: OpChanges): void {
    for (const listener of [...listeners]) {
        try {
            listener(changes);
        } catch (err) {
            console.error(err);
        }
    }
}

/** Returns the bytes of the first length-delimited field 1 in a message. */
function field1(bytes: Uint8Array): Uint8Array | null {
    let pos = 0;
    const varint = (): number => {
        let result = 0;
        let shift = 0;
        for (;;) {
            const byte = bytes[pos++];
            result += (byte & 0x7f) * 2 ** shift;
            if (!(byte & 0x80)) {
                return result;
            }
            shift += 7;
        }
    };
    while (pos < bytes.length) {
        const tag = varint();
        const field = Math.floor(tag / 8);
        const wire = tag & 7;
        if (wire === 0) {
            varint();
        } else if (wire === 1) {
            pos += 8;
        } else if (wire === 2) {
            const len = varint();
            if (field === 1) {
                return bytes.subarray(pos, pos + len);
            }
            pos += len;
        } else if (wire === 5) {
            pos += 4;
        } else {
            return null;
        }
    }
    return null;
}

/**
 * Extracts the OpChanges from a method's output. `level` is the generated
 * opChangesType: 1 when the output is OpChanges, 2 when it is the output's
 * first field, 3 when nested one more level.
 */
export function opChangesFromOutput(output: Uint8Array, level: number): OpChanges | null {
    let bytes: Uint8Array | null = output;
    for (let i = 1; i < level && bytes; i++) {
        bytes = field1(bytes);
    }
    return bytes ? OpChanges.fromBinary(bytes) : null;
}
