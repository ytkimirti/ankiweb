// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/** Tools > Check Media (desktop's mediacheck.py). */

import { checkMedia } from "@generated/backend";
import * as tr from "@generated/ftl";

import { runOp } from "../../app/run";
import { openWindow } from "../../app/windows";
import MediaCheck from "./MediaCheck.svelte";

export async function openMediaCheck(): Promise<void> {
    const output = await runOp(() => checkMedia({}), { progress: true, cancellable: true });
    if (!output) {
        return;
    }
    openWindow({ key: "mediaCheck", title: tr.mediaCheckWindowTitle(), component: MediaCheck, props: { output }, size: "lg" });
}
