<script type="typescript">
    import CoWebsite from "./CoWebsite.svelte";

    export let coWebsites: HTMLIFrameElement[];
</script>

<div>
    {#each coWebsites as coWebsite, i (coWebsite.id)}
        {#if i !== 0}
            <CoWebsite coWebsite={coWebsite}></CoWebsite>
        {/if}
    {/each}
</div>
