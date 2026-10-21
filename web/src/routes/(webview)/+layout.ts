// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { setupGlobalI18n } from "@tslib/i18n";
import { redirect } from "@sveltejs/kit";

import { connectToHost } from "$web/app/webview";

import type { LayoutLoad } from "./$types";

// Desktop pages, shown in iframes by the app (see $web/app/host.ts).
export const load: LayoutLoad = async () => {
    if (!connectToHost()) {
        // opened directly rather than inside the app
        redirect(307, "/");
    }
    await setupGlobalI18n();
};
