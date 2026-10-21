<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    import * as tr from "@generated/ftl";

    import { cancelProgress, progressState } from "$web/app/progress";

    let cancelled = $state(false);

    $effect(() => {
        if (!$progressState) {
            cancelled = false;
        }
    });
</script>

{#if $progressState}
    <div class="progress-backdrop">
        <div class="progress-box" role="status" aria-live="polite">
            {#if $progressState.title}
                <div class="title">{$progressState.title}</div>
            {/if}
            <div class="label">{$progressState.label}</div>
            {#if $progressState.max}
                <progress value={$progressState.value ?? 0} max={$progressState.max}></progress>
            {:else}
                <progress></progress>
            {/if}
            {#if $progressState.cancellable}
                <button
                    type="button"
                    class="btn btn-secondary"
                    disabled={cancelled}
                    onclick={() => {
                        cancelled = true;
                        cancelProgress();
                    }}
                >
                    {tr.actionsCancel()}
                </button>
            {/if}
        </div>
    </div>
{/if}

<style lang="scss">
    .progress-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1050;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.25);
    }

    .progress-box {
        background: var(--canvas-elevated);
        color: var(--fg);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 1rem 1.25rem;
        width: min(24rem, calc(100vw - 2rem));
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
    }

    .title {
        font-weight: 600;
    }

    .label {
        white-space: pre-line;
        min-height: 1.2em;
    }

    progress {
        width: 100%;
    }

    button {
        align-self: flex-end;
    }
</style>
