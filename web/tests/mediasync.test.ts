// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// @ts-nocheck: run with `bun test web/tests`; bun:test has no types in this repo

import { describe, expect, test } from "bun:test";

import { describeMediaSync, mediaSyncFraction, MediaSyncTracker } from "../src/lib/app/mediasync";

const labels = { starting: "Media sync starting...", complete: "Media sync complete.", aborted: "Media sync aborted." };

const counts = (over = {}) => ({
    downloadedFiles: 0,
    downloadedDeletions: 0,
    uploadedFiles: 0,
    uploadedDeletions: 0,
    changesTotal: 0,
    changesDone: 0,
    uploadsTotal: 0,
    ...over,
});

describe("MediaSyncTracker", () => {
    test("shows a download as files of the total", () => {
        const tracker = new MediaSyncTracker();
        expect(tracker.status().stage).toBe("starting");
        const status = tracker.progress(counts({ changesTotal: 5678, changesDone: 1234, downloadedFiles: 1234 }), "");
        expect(status.stage).toBe("downloading");
        expect(describeMediaSync(status, labels)).toBe(
            `Downloading media: ${(1234).toLocaleString()} of ${(5678).toLocaleString()} files`,
        );
        expect(mediaSyncFraction(status)).toBeCloseTo(1234 / 5678);
    });

    test("adds up the runs an interrupted sync takes, and never goes back", () => {
        const tracker = new MediaSyncTracker();
        tracker.progress(counts({ changesTotal: 100, changesDone: 40, downloadedFiles: 40 }), "");
        expect(tracker.pause().stage).toBe("paused");
        tracker.resume();
        // the new run starts from the last finished batch: 70 left, not 60
        let status = tracker.progress(counts({ changesTotal: 70, changesDone: 0 }), "");
        expect(status.done).toBe(40);
        expect(status.total).toBe(100);
        status = tracker.progress(counts({ changesTotal: 70, changesDone: 50, downloadedFiles: 20 }), "");
        expect(status.done).toBe(80);
        expect(status.downloaded).toBe(60);
        status = tracker.finish("complete");
        expect(status.active).toBe(false);
        expect(status.done).toBe(100);
        expect(describeMediaSync(status, labels)).toBe("Media sync complete. Downloaded 60 files.");
    });

    test("a resumed run checking local files first does not finish the bar", () => {
        const tracker = new MediaSyncTracker();
        tracker.progress(counts({ changesTotal: 100, changesDone: 40, downloadedFiles: 40 }), "");
        tracker.pause();
        tracker.resume();
        const status = tracker.progress(counts(), "");
        expect(status.done).toBe(40);
        expect(status.total).toBe(100);
    });

    test("shows uploads once downloads are done", () => {
        const tracker = new MediaSyncTracker();
        const status = tracker.progress(counts({ uploadsTotal: 40, uploadedFiles: 12 }), "");
        expect(status.stage).toBe("uploading");
        expect(describeMediaSync(status, labels)).toBe("Uploading media: 12 of 40 files");
        expect(mediaSyncFraction(status)).toBeCloseTo(0.3);
    });

    test("a failure keeps its error, and later progress changes nothing", () => {
        const tracker = new MediaSyncTracker();
        tracker.finish("failed", "network unreachable");
        const status = tracker.progress(counts({ changesTotal: 10 }), "");
        expect(status.stage).toBe("failed");
        expect(describeMediaSync(status, labels)).toBe("Media sync failed: network unreachable");
    });
});
