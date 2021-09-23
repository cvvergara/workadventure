import { get, writable } from "svelte/store";

export function getMainCoWebsite() {
    return get(coWebsites)[0];
}

export const coWebsites = writable(new Array<HTMLIFrameElement>());

coWebsites.subscribe(value => {
    console.log(get(coWebsites))
});
