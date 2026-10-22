// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Media sync progress for the status bar and sync panel. Requests the app
 * makes interrupt media sync, which then starts again from where it got to
 * (see sync.ts), so the engine's counts restart with each run; this adds
 * them up over the whole sync.
 */

/** The engine's counts for one run (MediaSyncProgress). */
export interface MediaSyncCounts {
    downloadedFiles: number;
    downloadedDeletions: number;
    uploadedFiles: number;
    uploadedDeletions: number;
    /** Server changes this run fetches, and how many it has applied. */
    changesTotal: number;
    changesDone: number;
    /** Local changes this run sends. */
    uploadsTotal: number;
}

export type MediaSyncStage =
    | "starting"
    | "checking"
    | "downloading"
    | "uploading"
    | "paused"
    | "complete"
    | "aborted"
    | "failed";

export interface MediaSyncStatus {
    stage: MediaSyncStage;
    active: boolean;
    downloaded: number;
    uploaded: number;
    removed: number;
    /** Server changes applied, of those to apply. */
    done: number;
    total: number;
    /** Local changes sent, of those to send. */
    sent: number;
    toSend: number;
    /** Desktop's progress text: added, removed and checked. */
    detail: string;
    error: string | null;
    finishedAt: number | null;
}

const NO_COUNTS: MediaSyncCounts = {
    downloadedFiles: 0,
    downloadedDeletions: 0,
    uploadedFiles: 0,
    uploadedDeletions: 0,
    changesTotal: 0,
    changesDone: 0,
    uploadsTotal: 0,
};

export class MediaSyncTracker {
    /** Counts of the runs before this one. */
    private carried = { downloaded: 0, uploaded: 0, removed: 0, sent: 0 };
    private run: MediaSyncCounts = NO_COUNTS;
    private done = 0;
    private total = 0;
    /** The total known when this run started. */
    private totalBefore = 0;
    private toSend = 0;
    private stage: MediaSyncStage = "starting";
    private detail = "";
    private error: string | null = null;
    private finishedAt: number | null = null;

    progress(counts: MediaSyncCounts, detail: string): MediaSyncStatus {
        if (this.finishedAt !== null) {
            return this.status();
        }
        this.run = counts;
        this.detail = detail;
        // a later run starts again from the last batch of changes the one
        // before finished, so only what it has left is comparable; the bar
        // never goes back
        const remaining = Math.max(0, counts.changesTotal - counts.changesDone);
        // until it has heard from the server (checking local files first),
        // a run knows nothing of what is left
        if (counts.changesTotal) {
            this.total = Math.max(this.total, this.totalBefore ? remaining : counts.changesTotal);
            this.done = Math.max(this.done, this.total - remaining);
        }
        const sentThisRun = counts.uploadedFiles + counts.uploadedDeletions;
        this.toSend = Math.max(this.toSend, this.carried.sent + counts.uploadsTotal);
        if (counts.uploadsTotal > sentThisRun) {
            this.stage = "uploading";
        } else if (remaining > 0) {
            this.stage = "downloading";
        } else {
            this.stage = "checking";
        }
        return this.status();
    }

    /** Interrupted by other work; it continues with a new run. */
    pause(): MediaSyncStatus {
        if (this.finishedAt === null) {
            this.stage = "paused";
        }
        return this.status();
    }

    /** A new run starts, counting from zero. */
    resume(): MediaSyncStatus {
        const run = this.run;
        this.carried.downloaded += run.downloadedFiles;
        this.carried.uploaded += run.uploadedFiles;
        this.carried.removed += run.downloadedDeletions + run.uploadedDeletions;
        this.carried.sent += run.uploadedFiles + run.uploadedDeletions;
        this.run = NO_COUNTS;
        this.totalBefore = this.total;
        if (this.finishedAt === null) {
            this.stage = "checking";
        }
        return this.status();
    }

    finish(stage: "complete" | "aborted" | "failed", error: string | null = null, now = Date.now()): MediaSyncStatus {
        if (this.finishedAt === null) {
            this.stage = stage;
            this.error = error;
            this.finishedAt = now;
            if (stage === "complete") {
                this.done = this.total;
            }
        }
        return this.status();
    }

    status(): MediaSyncStatus {
        const run = this.run;
        return {
            stage: this.stage,
            active: this.finishedAt === null,
            downloaded: this.carried.downloaded + run.downloadedFiles,
            uploaded: this.carried.uploaded + run.uploadedFiles,
            removed: this.carried.removed + run.downloadedDeletions + run.uploadedDeletions,
            done: this.done,
            total: this.total,
            sent: this.carried.sent + run.uploadedFiles + run.uploadedDeletions,
            toSend: this.toSend,
            detail: this.detail,
            error: this.error,
            finishedAt: this.finishedAt,
        };
    }
}

const count = (n: number) => n.toLocaleString();

/** How far along it is, from 0 to 1, when that is known. */
export function mediaSyncFraction(status: MediaSyncStatus): number | null {
    if (status.stage === "uploading" && status.toSend) {
        return Math.min(1, status.sent / status.toSend);
    }
    if ((status.stage === "downloading" || status.stage === "paused") && status.total) {
        return Math.min(1, status.done / status.total);
    }
    return null;
}

/** What has moved so far, as "Downloaded 3 files, uploaded 1 file". */
export function mediaSyncTotals(status: MediaSyncStatus): string {
    const files = (n: number) => `${count(n)} ${n === 1 ? "file" : "files"}`;
    const parts: string[] = [];
    if (status.downloaded) {
        parts.push(`downloaded ${files(status.downloaded)}`);
    }
    if (status.uploaded) {
        parts.push(`uploaded ${files(status.uploaded)}`);
    }
    if (status.removed) {
        parts.push(`removed ${files(status.removed)}`);
    }
    const text = parts.join(", ");
    return text && text[0].toUpperCase() + text.slice(1);
}

/** One line for the status bar. */
export function describeMediaSync(
    status: MediaSyncStatus,
    labels: { starting: string; complete: string; aborted: string },
): string {
    switch (status.stage) {
        case "starting":
            return labels.starting;
        case "checking":
            return "Checking media with the server";
        case "downloading":
            return `Downloading media: ${count(status.done)} of ${count(status.total)} files`;
        case "uploading":
            return `Uploading media: ${count(status.sent)} of ${count(status.toSend)} files`;
        case "paused":
            return status.total
                ? `Media sync paused while Anki is busy: ${count(status.done)} of ${count(status.total)} files`
                : "Media sync paused while Anki is busy";
        case "complete": {
            const totals = mediaSyncTotals(status);
            return totals ? `${labels.complete} ${totals}.` : labels.complete;
        }
        case "aborted":
            return labels.aborted;
        case "failed":
            return `Media sync failed: ${status.error ?? ""}`;
    }
}
