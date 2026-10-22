<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    import type { NotetypeNameId } from "@generated/anki/notetypes_pb";

    import { mdiNewspaper } from "./icons";
    import { getNotetype, getNotetypeNames } from "@generated/backend";
    import ItemChooser from "./ItemChooser.svelte";
    import * as tr from "@generated/ftl";
    import { registerOperationHandler } from "@tslib/operations";
    import { onMount } from "svelte";

    interface Props {
        onChange?: (notetype: NotetypeNameId) => void;
    }
    let { onChange }: Props = $props();
    let selectedNotetype: NotetypeNameId | null = $state(null);
    let notetypes: NotetypeNameId[] = $state([]);
    let itemChooser: ItemChooser<NotetypeNameId> | null = $state(null);

    /** A notetype to select once the list has it. */
    let wanted: bigint | null = null;

    async function fetchNotetypes() {
        notetypes = (await getNotetypeNames({})).entries;
        if (wanted !== null) {
            const id = wanted;
            wanted = null;
            itemChooser?.select(id);
        }
    }

    export function select(notetypeId: bigint) {
        if (notetypes.some((notetype) => notetype.id === notetypeId)) {
            wanted = null;
            itemChooser?.select(notetypeId);
        } else {
            // asked before the list loaded, or for one added since
            wanted = notetypeId;
            fetchNotetypes();
        }
    }

    export async function getSelected(): Promise<NotetypeNameId> {
        await fetchNotetypes();
        try {
            await getNotetype({ ntid: selectedNotetype!.id }, { alertOnError: false });
        } catch (error) {
            select(notetypes[0].id);
        }
        return selectedNotetype!;
    }

    onMount(() => {
        registerOperationHandler((changes) => {
            if (changes.notetype) {
                getSelected();
            }
        });
    });

    $effect(() => {
        fetchNotetypes();
    });
</script>

<ItemChooser
    bind:this={itemChooser}
    title={tr.notetypesChooseNoteType()}
    bind:selectedItem={selectedNotetype}
    {onChange}
    items={notetypes}
    icon={mdiNewspaper}
    keyCombination="Control+N"
    tooltip={tr.notetypesChangeNoteTypeCtrlandn()}
/>
