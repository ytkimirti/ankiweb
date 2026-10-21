// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { redirect } from "@sveltejs/kit";

// Unknown paths get the SPA fallback page, and SvelteKit reloads them when no
// route matches, forever; send them to the app instead.
export function load(): never {
    redirect(307, "/");
}
