<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    import type { CheckMediaResponse } from "@generated/anki/media_pb";
    import { emptyTrash, restoreTrash, trashMediaFiles } from "@generated/backend";
    import * as tr from "@generated/ftl";

    import { addTagsToNotes } from "$web/app/cardops";
    import { askUser, tooltip } from "$web/app/dialogs";
    import { runOp } from "$web/app/run";
    import type { WindowHandle } from "$web/app/windows";

    let { win, output }: { win: WindowHandle; output: CheckMediaResponse } = $props();

    let haveTrash = $state(output.haveTrash);
    let unusedTrashed = $state(false);

    async function trashUnused(): Promise<void> {
        if (!(await askUser(tr.mediaCheckDeleteUnusedConfirm()))) {
            return;
        }
        const names = output.unused;
        const done = await runOp(async () => {
            for (let i = 0; i < names.length; i += 25) {
                await trashMediaFiles({ fnames: names.slice(i, i + 25) });
            }
            return true;
        }, { progress: true });
        if (done) {
            unusedTrashed = true;
            haveTrash = true;
            tooltip(tr.mediaCheckDeleteUnusedComplete({ count: names.length }));
        }
    }

    async function tagMissing(): Promise<void> {
        await addTagsToNotes(output.missingMediaNotes, tr.mediaCheckMissingMediaTag());
    }

    async function onEmptyTrash(): Promise<void> {
        if (await runOp(() => emptyTrash({}), { progress: true })) {
            haveTrash = false;
            tooltip(tr.mediaCheckTrashEmptied());
        }
    }

    async function onRestoreTrash(): Promise<void> {
        if (await runOp(() => restoreTrash({}), { progress: true })) {
            haveTrash = false;
            tooltip(tr.mediaCheckTrashRestored());
        }
    }
</script>

<div class="media-check">
    <textarea readonly wrap="off">{output.report}</textarea>
    <footer>
        {#if output.unused.length}
            <button type="button" class="btn btn-secondary" disabled={unusedTrashed} onclick={() => void trashUnused()}>
                {tr.mediaCheckDeleteUnused()}
            </button>
        {/if}
        {#if output.missing.length}
            <button type="button" class="btn btn-secondary" onclick={() => void tagMissing()}>
                {tr.mediaCheckAddTag()}
            </button>
        {/if}
        {#if haveTrash}
            <button type="button" class="btn btn-secondary" onclick={() => void onEmptyTrash()}>
                {tr.mediaCheckEmptyTrash()}
            </button>
            <button type="button" class="btn btn-secondary" onclick={() => void onRestoreTrash()}>
                {tr.mediaCheckRestoreTrash()}
            </button>
        {/if}
        <span class="spacer"></span>
        <button type="button" class="btn btn-primary" onclick={() => win.close()}>{tr.actionsClose()}</button>
    </footer>
</div>

<style>
    .media-check {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
    }
    textarea {
        flex: 1;
        margin: 0.75rem;
        font-family: monospace;
        font-size: 0.85em;
        resize: none;
    }
    footer {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem;
        border-top: 1px solid var(--border-subtle);
    }
    .spacer {
        flex: 1;
    }
</style>
