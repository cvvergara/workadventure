<script type="typescript">
    import CoWebsite from "./CoWebsite.svelte";

    export let coWebsites: HTMLIFrameElement[];

    $: mainCowebsite = coWebsites[1];
</script>

<div class="cowebsite-container">
    <div class="cowebsite-sub-main">
        {#each coWebsites as coWebsite, i (coWebsite.id)}
            {#if i === 1}
                <CoWebsite coWebsite={coWebsite} index={i}></CoWebsite>
            {/if}
        {/each}
    </div>

    <div class="cowebsite-sub-container">
        {#each coWebsites as coWebsite, i (coWebsite.id)}
            {#if i !== 0 && i !== 1}
                <CoWebsite coWebsite={coWebsite} index={i}></CoWebsite>
            {/if}
        {/each}
    </div>
</div>

<style lang="scss">
    .cowebsite {
        &-container {

        }

        &-sub-main {
            height: 50%;
            margin: 2% 5%;
        }

        &-sub-container {
            position: absolute !important;
            display: inline-flex;
            justify-content: center;
            align-items: center;
            bottom: 23%;
            height: 20% !important;
            width: 100%;
        }
    }

</style>
