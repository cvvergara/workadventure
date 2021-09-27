<script type="typescript">
    import {coWebsiteManager} from "../../WebRtc/CoWebsiteManager";

    import { onMount } from 'svelte';

    export let coWebsite: HTMLIFrameElement;
    export let index: number;

    let container: HTMLDivElement;

    function close() {
        container.style.display = "none";
        coWebsiteManager.closeCoWebsite(coWebsite);
    }

    function hightlight() {
        coWebsiteManager.moveToMainSubCoWebsite(coWebsite);
    }

    function expand() {
        coWebsiteManager.moveToMainCoWebsite(coWebsite);
    }

    onMount(() => {
        container.appendChild(coWebsite);
    });
</script>

<div class="cowebsite-iframe-container" class:main={index === 1} bind:this={container}>
    <div class="overlay">
        <div class="actions">
            <button type="button" class="nes-btn is-primary" on:click={expand}>></button>

            {#if index !== 1}
                <button type="button" class="nes-btn is-secondary" on:click={hightlight}>&Xi;</button>
            {/if}

            <button type="button" class="nes-btn is-error" on:click={close}>&times;</button>
        </div>
    </div>
</div>

<style lang="scss">
    .cowebsite-iframe-container {
        width: 33%;
        height: 100%;
        margin: 5px;
        position: relative;
    }

    .main {
        width: 100%
    }

    .overlay {
        width: 100%;
        height: 100%;
        z-index: 50;
        position: absolute;

        .actions {
            pointer-events: all !important;
            margin: 3% 2%;
            display: flex;
            flex-direction: row;
            justify-content: end;

            button {
                width: 32px;
                height: 32px;
                margin: 8px;
                display: flex;
                justify-content: center;
                align-items: center;
            }
        }
    }
</style>
