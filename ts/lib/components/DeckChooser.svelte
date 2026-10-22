<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    import { mdiBookOutline } from "./icons";
    import { getDeck, getDeckNames } from "@generated/backend";
    import ItemChooser from "./ItemChooser.svelte";
    import type { DeckNameId } from "@generated/anki/decks_pb";
    import * as tr from "@generated/ftl";
    import { registerOperationHandler } from "@tslib/operations";
    import { onMount } from "svelte";

    interface Props {
        onChange?: (deck: DeckNameId) => void;
    }
    let { onChange }: Props = $props();
    let selectedDeck: DeckNameId | null = $state(null);
    let decks: DeckNameId[] = $state([]);
    let itemChooser: ItemChooser<DeckNameId> | null = $state(null);

    /** A deck to select once the list has it. */
    let wanted: bigint | null = null;

    async function fetchDecks(skipEmptyDefault: boolean = true) {
        let entries = (await getDeckNames({ skipEmptyDefault, includeFiltered: false }))
            .entries;
        // the deck to select can be the empty default deck, which is left out
        if (wanted !== null && !entries.some((deck) => deck.id === wanted)) {
            entries = (
                await getDeckNames({ skipEmptyDefault: false, includeFiltered: false })
            ).entries;
        }
        decks = entries;
        if (wanted !== null) {
            const id = wanted;
            wanted = null;
            itemChooser?.select(id);
        }
    }

    export function select(deckId: bigint) {
        if (decks.some((deck) => deck.id === deckId)) {
            wanted = null;
            itemChooser?.select(deckId);
        } else {
            // asked before the list loaded, or for a deck it leaves out
            wanted = deckId;
            fetchDecks();
        }
    }

    export async function getSelected(): Promise<DeckNameId> {
        await fetchDecks(false);
        try {
            await getDeck({ did: selectedDeck!.id }, { alertOnError: false });
        } catch (error) {
            select(1n);
        }
        return selectedDeck!;
    }

    onMount(() => {
        registerOperationHandler((changes) => {
            if (changes.deck) {
                getSelected();
            }
        });
    });

    $effect(() => {
        fetchDecks();
    });
</script>

<ItemChooser
    bind:this={itemChooser}
    title={tr.decksChooseDeck()}
    bind:selectedItem={selectedDeck}
    {onChange}
    items={decks}
    icon={mdiBookOutline}
    keyCombination="Control+D"
    tooltip={tr.decksTargetDeckCtrlandd()}
/>
