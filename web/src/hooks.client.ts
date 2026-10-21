// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import type { HandleClientError } from "@sveltejs/kit";

export const handleError: HandleClientError = ({ error }) => {
    console.error(error);
    return { message: (error as Error)?.message ?? String(error) };
};
