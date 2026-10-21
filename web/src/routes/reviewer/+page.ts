// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { redirect } from "@sveltejs/kit";

import { connectCardPage } from "$web/app/cardpage";

import type { PageLoad } from "./$types";

// The card frame (desktop's reviewer webview), usually on the card origin
// (see lib/config.ts). It lives at the site root so that relative media
// references in cards resolve to /<filename>.
export const load: PageLoad = async () => {
    if (!(await connectCardPage())) {
        redirect(307, "/");
    }
    await import("$ts/reviewer/index_wrapper");
};
