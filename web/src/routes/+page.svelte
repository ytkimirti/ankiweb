<script lang="ts">
    import { openCollection, deckTree, addDeckLegacy, getDeckNames } from "@generated/backend";
    import { startEngine, getEngine } from "$web/app/backend";
    import { profilePaths } from "$web/engine/protocol";
    import { onMount } from "svelte";

    let log: string[] = [];
    function say(s: string) {
        log = [...log, s];
        console.log(s);
    }

    onMount(async () => {
        try {
            const t0 = performance.now();
            await startEngine();
            say(`engine started in ${Math.round(performance.now() - t0)}ms`);
            const engine = getEngine();
            engine.onProgress((p) => say(`progress: ${p.value.case}`));
            await engine.mountProfile("User 1");
            const paths = profilePaths("User 1");
            await openCollection({
                collectionPath: paths.collection,
                mediaFolderPath: paths.mediaFolder,
                mediaDbPath: paths.mediaDb,
            });
            say("collection open");
            const names = await getDeckNames({ skipEmptyDefault: false, includeFiltered: true });
            say("decks: " + names.entries.map((e) => e.name).join(", "));
            const tree = await deckTree({ now: BigInt(Math.floor(Date.now() / 1000)) });
            say("tree children: " + tree.children.length);
            (window as any).ankiEngine = engine;
            say("DONE");
        } catch (e) {
            say("ERROR: " + (e as Error).stack);
        }
    });
</script>

<pre id="log">{log.join("\n")}</pre>
