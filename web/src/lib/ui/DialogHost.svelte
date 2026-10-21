<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    import { dialogs, notices, type DialogRequest } from "$web/app/dialogs";
    import { sanitizeHtml } from "$web/app/html";

    let inputValue = $state("");
    let choice = $state(0);
    let filter = $state("");
    let checks = $state<boolean[]>([]);
    let form = $state<Record<string, string | number | boolean>>({});
    let currentId = $state(0);

    const top = $derived($dialogs[$dialogs.length - 1] as DialogRequest | undefined);

    $effect(() => {
        if (top && top.id !== currentId) {
            currentId = top.id;
            inputValue = top.input?.value ?? "";
            choice = top.choices?.selected ?? 0;
            filter = "";
            checks = top.checks?.map((c) => c.checked) ?? [];
            form = Object.fromEntries((top.form ?? []).map((f) => [f.key, f.value]));
        }
    });

    const filtered = $derived(
        top?.choices
            ? top.choices.items
                .map((label, index) => ({ label, index }))
                .filter((item) => item.label.toLowerCase().includes(filter.toLowerCase()))
            : [],
    );

    $effect(() => {
        if (top?.choices && filtered.length && !filtered.some((item) => item.index === choice)) {
            choice = filtered[0].index;
        }
    });

    function finish(button: string | null): void {
        if (!top) {
            return;
        }
        top.resolve({
            button,
            input: top.input ? inputValue : undefined,
            choice: top.choices ? choice : undefined,
            checks: top.checks ? [...checks] : undefined,
            form: top.form ? { ...form } : undefined,
        });
    }

    function primary(): string | null {
        return top?.buttons.find((b) => b.primary)?.value ?? top?.buttons[top.buttons.length - 1]?.value ?? null;
    }

    function onKeydown(event: KeyboardEvent): void {
        if (!top) {
            return;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            const cancel = top.buttons.find((b) => ["cancel", "no"].includes(b.value));
            finish(cancel?.value ?? (top.buttons.length === 1 ? top.buttons[0].value : null));
        } else if (event.key === "Enter" && !(event.target instanceof HTMLTextAreaElement)) {
            if (event.target instanceof HTMLButtonElement) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            finish(primary());
        } else if (top.choices && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            const pos = filtered.findIndex((item) => item.index === choice);
            const next = filtered[Math.min(filtered.length - 1, Math.max(0, pos + (event.key === "ArrowDown" ? 1 : -1)))];
            if (next) {
                choice = next.index;
                document.getElementById(`dialog-choice-${next.index}`)?.scrollIntoView({ block: "nearest" });
            }
        }
    }

    function autofocus(node: HTMLElement): void {
        setTimeout(() => node.focus(), 0);
    }

    function focusIf(node: HTMLElement, condition: boolean): void {
        if (condition) {
            autofocus(node);
        }
    }
</script>

<svelte:window onkeydowncapture={onKeydown} />

{#each $dialogs as dialog (dialog.id)}
    <div class="dialog-backdrop" class:hidden={dialog !== top}>
        <div
            class="dialog {dialog.kind ?? ''}"
            role="dialog"
            aria-modal="true"
            aria-label={dialog.title ?? "Anki"}
        >
            {#if dialog.title}
                <h2 class="dialog-title">{dialog.title}</h2>
            {/if}
            <div class="dialog-text">
                {#if dialog.html}
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                    {@html sanitizeHtml(dialog.text)}
                {:else}
                    {dialog.text}
                {/if}
            </div>
            {#if dialog === top && dialog.input}
                {#if dialog.input.multiline}
                    <textarea
                        class="form-control"
                        rows="6"
                        bind:value={inputValue}
                        placeholder={dialog.input.placeholder}
                        use:autofocus
                    ></textarea>
                {:else}
                    <input
                        class="form-control"
                        type="text"
                        bind:value={inputValue}
                        placeholder={dialog.input.placeholder}
                        use:autofocus
                        onfocus={(e) => (e.currentTarget as HTMLInputElement).select()}
                    />
                {/if}
            {/if}
            {#if dialog === top && dialog.choices}
                {#if dialog.choices.filter}
                    <input class="form-control" type="search" bind:value={filter} use:autofocus />
                {/if}
                <div class="choices" role="listbox">
                    {#each filtered as item (item.index)}
                        <button
                            type="button"
                            id="dialog-choice-{item.index}"
                            class="choice"
                            class:selected={item.index === choice}
                            role="option"
                            aria-selected={item.index === choice}
                            onclick={() => (choice = item.index)}
                            ondblclick={() => finish(primary())}
                        >
                            {item.label}
                        </button>
                    {/each}
                </div>
            {/if}
            {#if dialog === top && dialog.checks}
                {#each dialog.checks as check, i}
                    <label class="check">
                        <input type="checkbox" bind:checked={checks[i]} />
                        {check.label}
                    </label>
                {/each}
            {/if}
            {#if dialog === top && dialog.form}
                <div class="form">
                    {#each dialog.form as field, i (field.key)}
                        {#if field.type === "checkbox"}
                            <label class="check">
                                <input type="checkbox" bind:checked={form[field.key] as boolean} />
                                {field.label}
                            </label>
                        {:else if field.type === "radio"}
                            <fieldset class="radio">
                                {#if field.label}<legend>{field.label}</legend>{/if}
                                {#each field.options as option (option.value)}
                                    <label class="check">
                                        <input
                                            type="radio"
                                            name={field.key}
                                            value={option.value}
                                            bind:group={form[field.key]}
                                        />
                                        {option.label}
                                    </label>
                                {/each}
                            </fieldset>
                        {:else}
                            <label class="field">
                                <span>{field.label}</span>
                                {#if field.type === "number"}
                                    <input
                                        class="form-control"
                                        type="number"
                                        min={field.min}
                                        max={field.max}
                                        step={field.step ?? 1}
                                        bind:value={form[field.key]}
                                        use:focusIf={i === 0}
                                    />
                                {:else if field.type === "select"}
                                    <select class="form-select" bind:value={form[field.key]}>
                                        {#each field.options as option (option.value)}
                                            <option value={option.value}>{option.label}</option>
                                        {/each}
                                    </select>
                                {:else if field.type === "password"}
                                    <input
                                        class="form-control"
                                        type="password"
                                        autocomplete="current-password"
                                        bind:value={form[field.key]}
                                    />
                                {:else}
                                    <input
                                        class="form-control"
                                        type="text"
                                        placeholder={field.placeholder}
                                        bind:value={form[field.key]}
                                        use:focusIf={i === 0}
                                    />
                                {/if}
                            </label>
                        {/if}
                    {/each}
                </div>
            {/if}
            <div class="dialog-buttons">
                {#each dialog.buttons as button (button.value)}
                    <button
                        type="button"
                        class="btn"
                        class:btn-primary={button.primary && !button.danger}
                        class:btn-danger={button.danger}
                        class:btn-secondary={!button.primary && !button.danger}
                        onclick={() => finish(button.value)}
                        use:focusIf={dialog === top && !dialog.input && !dialog.choices && !dialog.form && button.value === primary()}
                    >
                        {button.label}
                    </button>
                {/each}
            </div>
        </div>
    </div>
{/each}

<div class="notices" aria-live="polite">
    {#each $notices as notice (notice.id)}
        <div class="notice">{notice.text}</div>
    {/each}
</div>

<style lang="scss">
    .dialog-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.35);
        padding: 1rem;
        &.hidden {
            visibility: hidden;
        }
    }

    .dialog {
        background: var(--canvas-elevated);
        color: var(--fg);
        border: 1px solid var(--border);
        border-radius: var(--border-radius-medium, 8px);
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
        padding: 1.25rem;
        width: min(32rem, 100%);
        max-height: calc(100vh - 2rem);
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        &.warning {
            border-top: 4px solid var(--state-learn);
        }
        &.critical {
            border-top: 4px solid var(--accent-danger);
        }
    }

    .dialog-title {
        font-size: 1.1rem;
        margin: 0;
    }

    .dialog-text {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        overflow-y: auto;
        user-select: text;
    }

    .choices {
        overflow-y: auto;
        max-height: 50vh;
        border: 1px solid var(--border);
        border-radius: 4px;
        display: flex;
        flex-direction: column;
    }

    .choice {
        all: unset;
        padding: 0.25rem 0.5rem;
        cursor: pointer;
        &.selected {
            background: var(--selected-bg, var(--button-primary-bg));
            color: var(--selected-fg, white);
        }
    }

    .check {
        display: flex;
        gap: 0.5rem;
        align-items: center;
    }

    .form {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
        overflow-y: auto;
    }

    .field {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        > span {
            flex: 1;
        }
        > input,
        > select {
            width: auto;
            min-width: 8rem;
            max-width: 60%;
        }
    }

    .radio {
        border: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        legend {
            font-size: 1rem;
            margin-bottom: 0.2rem;
        }
    }

    .dialog-buttons {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        flex-wrap: wrap;
    }

    .notices {
        position: fixed;
        bottom: 4.5rem;
        left: 50%;
        transform: translateX(-50%);
        z-index: 1100;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        pointer-events: none;
    }

    .notice {
        background: var(--canvas-elevated);
        color: var(--fg);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.5rem 1rem;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
        max-width: 90vw;
        text-align: center;
    }
</style>
