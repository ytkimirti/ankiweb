import { redirect } from "@sveltejs/kit";

// Unknown paths get the SPA fallback page, and SvelteKit reloads them when no
// route matches, forever; send them to the app instead. Not inside a frame,
// though (a relative link in a card when cards share the app's origin): a
// second app there would open the same collection again.
export function load(): void {
    if (window.self === window.top) {
        redirect(307, "/");
    }
}
