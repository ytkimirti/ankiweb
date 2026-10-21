<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    // desktop's profile manager (forms/profiles.ui, AnkiQt.onAddProfile etc.)
    import * as tr from "@generated/ftl";
    import * as trq from "@generated/ftl-qt";

    import { loadProfile } from "$web/app/boot";
    import { askUser, getText, showError, showWarning } from "$web/app/dialogs";
    import {
        addProfile,
        lastProfile,
        profileNames,
        removeProfile,
        renameProfile,
        validateProfileName,
    } from "$web/app/profiles";
    import { setGlobalShortcuts } from "$web/app/shortcuts";
    import { globalShortcuts } from "$web/app/boot";
    import { onDestroy, onMount } from "svelte";

    let selected = $state(lastProfile() ?? "");
    let busy = $state(false);

    $effect(() => {
        if (!$profileNames.includes(selected)) {
            selected = $profileNames[0] ?? "";
        }
    });

    // the main window's shortcuts do nothing without a profile
    onMount(() => setGlobalShortcuts([]));
    onDestroy(() => setGlobalShortcuts(globalShortcuts()));

    async function run(fn: () => Promise<void>): Promise<void> {
        if (busy) {
            return;
        }
        busy = true;
        try {
            await fn();
        } catch (err) {
            await showError(err);
        } finally {
            busy = false;
        }
    }

    function open(): Promise<void> {
        return run(async () => {
            if (selected) {
                await loadProfile(selected);
            }
        });
    }

    async function askName(prompt: string, value = ""): Promise<string | null> {
        const text = await getText(prompt, { value });
        if (text === null) {
            return null;
        }
        const name = validateProfileName(text);
        if (!name) {
            return null;
        }
        if ($profileNames.includes(name)) {
            await showWarning(trq.qtMiscNameExists());
            return null;
        }
        return name;
    }

    function add(): Promise<void> {
        return run(async () => {
            const name = await askName(tr.actionsName());
            if (name) {
                addProfile(name);
                selected = name;
            }
        });
    }

    function rename(): Promise<void> {
        return run(async () => {
            const old = selected;
            const name = await askName(tr.actionsNewName(), old);
            if (name && name !== old) {
                await renameProfile(old, name);
                selected = name;
            }
        });
    }

    function remove(): Promise<void> {
        return run(async () => {
            if ($profileNames.length < 2) {
                await showWarning(trq.qtMiscThereMustBeAtLeastOne());
                return;
            }
            const ok = await askUser(trq.qtMiscAllCardsNotesAndMediaFor2({ name: selected }), {
                defaultNo: true,
                danger: true,
            });
            if (ok) {
                await removeProfile(selected);
            }
        });
    }

    function onKeydown(event: KeyboardEvent): void {
        if (event.key === "Enter" && !busy) {
            event.preventDefault();
            void open();
        }
    }
</script>

<div class="profiles">
    <section class="panel" aria-label={tr.profilesProfiles()}>
        <h1>{tr.profilesProfiles()}</h1>
        <div class="body">
            <select
                class="list"
                size="8"
                bind:value={selected}
                ondblclick={() => void open()}
                onkeydown={onKeydown}
                aria-label={tr.profilesProfiles()}
            >
                {#each $profileNames as name (name)}
                    <option value={name}>{name}</option>
                {/each}
            </select>
            <div class="buttons">
                <button type="button" class="btn btn-primary" disabled={busy || !selected} onclick={() => void open()}>
                    {tr.profilesOpen()}
                </button>
                <button type="button" class="btn btn-secondary" disabled={busy} onclick={() => void add()}>
                    {tr.actionsAdd()}
                </button>
                <button type="button" class="btn btn-secondary" disabled={busy || !selected} onclick={() => void rename()}>
                    {tr.actionsRename()}
                </button>
                <button type="button" class="btn btn-secondary" disabled={busy || !selected} onclick={() => void remove()}>
                    {tr.actionsDelete()}
                </button>
            </div>
        </div>
    </section>
</div>

<style lang="scss">
    .profiles {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
    }

    .panel {
        width: min(32rem, 100%);
        padding: 1.25rem;
        border: 1px solid var(--border);
        border-radius: var(--border-radius-large, 8px);
        background: var(--canvas-elevated);
        box-shadow: 0 4px 16px var(--shadow);
    }

    h1 {
        margin: 0 0 1rem;
        font-size: 1.25rem;
    }

    .body {
        display: flex;
        gap: 1rem;
    }

    .list {
        flex: 1;
        min-height: 12rem;
        padding: 0.25rem;
        border: 1px solid var(--border);
        border-radius: var(--border-radius);
        background: var(--canvas-inset);
        color: var(--fg);
        option {
            padding: 0.35rem 0.5rem;
        }
    }

    .buttons {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        min-width: 7rem;
    }

    @media (max-width: 480px) {
        .body {
            flex-direction: column;
        }
        .buttons {
            flex-direction: row;
            flex-wrap: wrap;
            > * {
                flex: 1;
            }
        }
    }
</style>
