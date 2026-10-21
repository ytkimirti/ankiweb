<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's RecordDialog (sound.py)
    import * as tr from "@generated/ftl";
    import * as trq from "@generated/ftl-qt";
    import { onDestroy, onMount } from "svelte";

    import { errorMessage } from "$web/app/dialogs";
    import { startRecording, type Recorder } from "$web/app/sound";
    import type { WindowHandle } from "$web/app/windows";

    let { win, onDone }: { win: WindowHandle; onDone: (blob: Blob | null) => void } = $props();

    let recorder: Recorder | null = null;
    let started = 0;
    let elapsed = $state(0);
    let level = $state(0);
    let error = $state<string | null>(null);
    let frame = 0;

    function tick(): void {
        if (!recorder) {
            return;
        }
        elapsed = (Date.now() - started) / 1000;
        level = recorder.level();
        frame = requestAnimationFrame(tick);
    }

    onMount(async () => {
        try {
            recorder = await startRecording();
            started = Date.now();
            tick();
        } catch (err) {
            error = trq.qtMiscUnableToRecord({ error: errorMessage(err) });
        }
    });

    onDestroy(() => {
        cancelAnimationFrame(frame);
        recorder?.cancel();
        recorder = null;
    });

    async function save(): Promise<void> {
        const active = recorder;
        if (!active) {
            return;
        }
        recorder = null;
        cancelAnimationFrame(frame);
        const { blob } = await active.stop();
        onDone(blob);
        win.close();
    }

    function cancel(): void {
        onDone(null);
        win.close();
    }
</script>

<div class="record">
    {#if error}
        <p class="error">{error}</p>
    {:else}
        <p>{tr.mediaRecordingtime({ secs: elapsed.toFixed(1) })}</p>
        <div class="meter" aria-hidden="true">
            <div class="level" style:width="{Math.min(100, level * 140)}%"></div>
        </div>
    {/if}
    <footer>
        <button type="button" class="btn btn-secondary" onclick={cancel}>{tr.actionsCancel()}</button>
        <button type="button" class="btn btn-primary" disabled={!!error} onclick={() => void save()}>
            {tr.actionsSave()}
        </button>
    </footer>
</div>

<style>
    .record {
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }
    .meter {
        height: 0.6rem;
        border-radius: 0.3rem;
        background: var(--canvas-inset);
        overflow: hidden;
    }
    .level {
        height: 100%;
        background: var(--state-new);
        transition: width 80ms linear;
    }
    .error {
        color: var(--accent-danger);
    }
    footer {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
    }
</style>
