// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { redirect } from "@sveltejs/kit";

import { connectToHost } from "$web/app/webview";

import type { PageLoad } from "./$types";

// The card frame (desktop's reviewer webview). It lives at the site root so
// that relative media references in cards resolve to /<filename>.
export const load: PageLoad = async () => {
    if (!connectToHost()) {
        redirect(307, "/");
    }
    await import("$ts/reviewer/index_wrapper");
};
