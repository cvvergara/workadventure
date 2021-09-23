<script type="typescript">
    import { onMount } from 'svelte';

    export let coWebsite: HTMLIFrameElement;
    let container: HTMLDivElement;

    onMount(() => {
        container.appendChild(coWebsite);
    });
</script>

<div class="container cowwebsite-container" bind:this={container}>
    <div class="overlay"></div>
</div>

<style lang="scss">
    .container {
        width: 25vw;
        height: 25vh;
        position: relative;
    }

    .overlay {
        width: 100%;
        height: 100%;
        z-index: 50;
        position: absolute;
    }
</style>
