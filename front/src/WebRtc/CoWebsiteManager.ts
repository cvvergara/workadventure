import { HtmlUtils } from "./HtmlUtils";
import { Subject } from "rxjs";
import { iframeListener } from "../Api/IframeListener";
import { touchScreenManager } from "../Touch/TouchScreenManager";
import { waScaleManager } from "../Phaser/Services/WaScaleManager";
import { coWebsites, getMainCoWebsite } from "../Stores/CoWebsitesStore";
import { get } from "svelte/store";

enum iframeStates {
    closed = 1,
    loading, // loading an iframe can be slow, so we show some placeholder until it is ready
    opened,
}

const cowebsiteDivId = "cowebsite"; // the id of the whole container.
const cowebsiteMainDomId = "cowebsite-main"; // the id of the parent div of the iframe.
const cowebsiteJitsiBufferDomId = "cowebsite-jitsi-buffer"; // the id of the temporary Jitsi iframe parent.
const cowebsiteAsideDomId = "cowebsite-aside"; // the id of the parent div of the iframe.
export const cowebsiteCloseButtonId = "cowebsite-close";
const cowebsiteFullScreenButtonId = "cowebsite-fullscreen";
const cowebsiteOpenFullScreenImageId = "cowebsite-fullscreen-open";
const cowebsiteCloseFullScreenImageId = "cowebsite-fullscreen-close";
const animationTime = 500; //time used by the css transitions, in ms.

interface TouchMoveCoordinates {
    x: number;
    y: number;
}

class CoWebsiteManager {
    private openedMain: iframeStates = iframeStates.closed;

    private _onResize: Subject<void> = new Subject();
    public onResize = this._onResize.asObservable();
    /**
     * Quickly going in and out of an iframe trigger can create conflicts between the iframe states.
     * So we use this promise to queue up every cowebsite state transition
     */
    private currentOperationPromise: Promise<void> = Promise.resolve();
    private cowebsiteDiv: HTMLDivElement;
    private resizing: boolean = false;
    private cowebsiteMainDom: HTMLDivElement;
    private cowebsiteJitsiBufferDom: HTMLDivElement;
    private cowebsiteAsideDom: HTMLDivElement;
    private previousTouchMoveCoordinates: TouchMoveCoordinates | null = null; //only use on touchscreens to track touch movement

    get width(): number {
        return this.cowebsiteDiv.clientWidth;
    }

    set width(width: number) {
        this.cowebsiteDiv.style.width = width + "px";
    }

    set widthPercent(width: number) {
        this.cowebsiteDiv.style.width = width + "%";
    }

    get height(): number {
        return this.cowebsiteDiv.clientHeight;
    }

    set height(height: number) {
        this.cowebsiteDiv.style.height = height + "px";
    }

    get verticalMode(): boolean {
        return window.innerWidth < window.innerHeight;
    }

    get isFullScreen(): boolean {
        return this.verticalMode ? this.height === window.innerHeight : this.width === window.innerWidth;
    }

    constructor() {
        this.cowebsiteDiv = HtmlUtils.getElementByIdOrFail<HTMLDivElement>(cowebsiteDivId);
        this.cowebsiteMainDom = HtmlUtils.getElementByIdOrFail<HTMLDivElement>(cowebsiteMainDomId);
        this.cowebsiteJitsiBufferDom = HtmlUtils.getElementByIdOrFail<HTMLDivElement>(cowebsiteJitsiBufferDomId);
        this.cowebsiteAsideDom = HtmlUtils.getElementByIdOrFail<HTMLDivElement>(cowebsiteAsideDomId);
        this.initResizeListeners(touchScreenManager.supportTouchScreen);

        const buttonCloseCoWebsites = HtmlUtils.getElementByIdOrFail(cowebsiteCloseButtonId);
        buttonCloseCoWebsites.addEventListener("click", () => {
            buttonCloseCoWebsites.blur();
            this.closeCoWebsites();
        });

        const buttonFullScreenFrame = HtmlUtils.getElementByIdOrFail(cowebsiteFullScreenButtonId);
        buttonFullScreenFrame.addEventListener("click", () => {
            buttonFullScreenFrame.blur();
            this.fullscreen();
        });
    }

    private initResizeListeners(touchMode: boolean) {
        const movecallback = (event: MouseEvent | TouchEvent) => {
            let x, y;
            if (event.type === "mousemove") {
                x = (event as MouseEvent).movementX / this.getDevicePixelRatio();
                y = (event as MouseEvent).movementY / this.getDevicePixelRatio();
            } else {
                const touchEvent = (event as TouchEvent).touches[0];
                const last = { x: touchEvent.pageX, y: touchEvent.pageY };
                const previous = this.previousTouchMoveCoordinates as TouchMoveCoordinates;
                this.previousTouchMoveCoordinates = last;
                x = last.x - previous.x;
                y = last.y - previous.y;
            }

            this.verticalMode ? (this.height += y) : (this.width -= x);
            this.fire();
        };

        this.cowebsiteAsideDom.addEventListener(touchMode ? "touchstart" : "mousedown", (event) => {
            this.resizing = true;
            getMainCoWebsite().style.display = "none";
            if (touchMode) {
                const touchEvent = (event as TouchEvent).touches[0];
                this.previousTouchMoveCoordinates = { x: touchEvent.pageX, y: touchEvent.pageY };
            }

            document.addEventListener(touchMode ? "touchmove" : "mousemove", movecallback);
        });

        document.addEventListener(touchMode ? "touchend" : "mouseup", (event) => {
            if (!this.resizing) return;
            if (touchMode) {
                this.previousTouchMoveCoordinates = null;
            }
            document.removeEventListener(touchMode ? "touchmove" : "mousemove", movecallback);
            getMainCoWebsite().style.display = "block";
            this.resizing = false;
        });
    }

    private getDevicePixelRatio(): number {
        //on chrome engines, movementX and movementY return global screens coordinates while other browser return pixels
        //so on chrome-based browser we need to adjust using 'devicePixelRatio'
        return window.navigator.userAgent.includes("Firefox") ? 1 : window.devicePixelRatio;
    }

    private closeMain(): void {
        this.cowebsiteDiv.classList.remove("loaded"); //edit the css class to trigger the transition
        this.cowebsiteDiv.classList.add("hidden");
        this.openedMain = iframeStates.closed;
        this.resetStyleMain();
    }
    private loadMain(): void {
        this.cowebsiteDiv.classList.remove("hidden"); //edit the css class to trigger the transition
        this.cowebsiteDiv.classList.add("loading");
        this.openedMain = iframeStates.loading;
    }
    private openMain(): void {
        this.cowebsiteDiv.classList.remove("loading", "hidden"); //edit the css class to trigger the transition
        this.openedMain = iframeStates.opened;
        this.resetStyleMain();
    }

    public resetStyleMain() {
        this.cowebsiteDiv.style.width = "";
        this.cowebsiteDiv.style.height = "";
    }

    private searchCoWebsiteById(coWebsiteId: string) {
        return get(coWebsites).find((coWebsite: HTMLIFrameElement) => coWebsite.id === coWebsiteId);
    }

    private removeCoWebsiteFromStack(coWebsite: HTMLIFrameElement) {
        coWebsites.set(get(coWebsites).filter(
            (coWebsiteToRemove: HTMLIFrameElement) => coWebsiteToRemove.id !== coWebsite.id
        ));

        if (get(coWebsites).length < 1) {
            this.closeMain();
        }
    }

    public moveToMainCoWebsite(coWebsite: HTMLIFrameElement) {
        getMainCoWebsite().scrolling = "no";
        this.removeCoWebsiteFromStack(coWebsite);
        coWebsite.scrolling = "yes";
        coWebsites.set([coWebsite, ...get(coWebsites)]);
        this.cowebsiteMainDom.appendChild(coWebsite);
    }

    public moveToMainSubCoWebsite(coWebsite: HTMLIFrameElement) {
        this.removeCoWebsiteFromStack(coWebsite);
        const coWebsitesCopy = get(coWebsites);
        coWebsitesCopy.splice(1,0, coWebsite);
        coWebsites.set([...coWebsitesCopy.splice(1,0, coWebsite)]);
    }

    public searchJitsi(): HTMLIFrameElement|undefined {
        return get(coWebsites).find((coWebsite : HTMLIFrameElement) =>
            coWebsite.id.toLowerCase().includes('jitsi')
        );
    }

    public loadCoWebsite(
        url: string,
        base: string,
        allowApi?: boolean,
        allowPolicy?: string,
        widthPercent?: number
    ): void {
        if (get(coWebsites).length < 1) {
            this.loadMain();
        } else if (get(coWebsites).length === 5) {
            return;
        }

        const coWebsite = document.createElement("iframe");

        do {
            coWebsite.id = "cowebsite-iframe-" + (Math.random() + 1).toString(36).substring(7);
        } while (this.searchCoWebsiteById(coWebsite.id));

        coWebsite.src = new URL(url, base).toString()

        coWebsite.scrolling = "no";

        if (allowPolicy) {
            coWebsite.allow = allowPolicy;
        }

        const onloadPromise = new Promise<void>((resolve) => {
            coWebsite.onload = () => resolve();
        });

        if (allowApi) {
            iframeListener.registerIframe(coWebsite);
        }

        coWebsites.set([...get(coWebsites), coWebsite]);

        if (get(coWebsites).length === 1) {
            this.moveToMainCoWebsite(coWebsite);
        }

        const onTimeoutPromise = new Promise<void>((resolve) => {
            setTimeout(() => resolve(), 2000);
        });

        this.currentOperationPromise = this.currentOperationPromise
            .then(() => Promise.race([onloadPromise, onTimeoutPromise]))
            .then(() => {
                this.openMain();
                if (widthPercent) {
                    this.widthPercent = widthPercent;
                }
                setTimeout(() => {
                    this.fire();
                }, animationTime);
            })
            .catch((err) => {
                console.error("Error loadCoWebsite => ", err);
                this.removeCoWebsiteFromStack(coWebsite);
            });
    }

    /**
     * Just like loadCoWebsite but the div can be filled by the user.
     */
    public insertCoWebsite(callback: (cowebsite: HTMLDivElement) => Promise<void>, widthPercent?: number): void {
        if (get(coWebsites).length < 1) {
            this.loadMain();
        } else if (get(coWebsites).length === 5) {
            return;
        }

        this.currentOperationPromise = this.currentOperationPromise
            .then(() => callback(this.cowebsiteJitsiBufferDom))
            .then(() => {
                const coWebsite = this.cowebsiteJitsiBufferDom.getElementsByTagName('iframe').item(0);

                if (!coWebsite) {
                    console.error("Error insertCoWebsite => Cannot find Iframe Element on DOM");
                    return;
                }

                // Add to the stack and move to the main
                coWebsites.set([...get(coWebsites), coWebsite]);
                this.moveToMainCoWebsite(coWebsite);

                if (get(coWebsites).length === 1) {
                    this.openMain();

                    if (widthPercent) {
                        this.widthPercent = widthPercent;
                    }

                    setTimeout(() => {
                        this.fire();
                    }, animationTime);
                }
            })
            .catch((err) => {
                console.error("Error insertCoWebsite => ", err);
            });
    }

    public closeCoWebsite(coWebsite: HTMLIFrameElement): Promise<void> {
        this.currentOperationPromise = this.currentOperationPromise.then(
            () =>
                new Promise((resolve) => {
                    if (get(coWebsites).length === 1) {
                        if (this.openedMain === iframeStates.closed) resolve(); //this method may be called twice, in case of iframe error for example
                        this.closeMain();
                        this.fire();
                    }

                    if (coWebsite) {
                        iframeListener.unregisterIframe(coWebsite);
                    }

                    setTimeout(() => {
                        this.removeCoWebsiteFromStack(coWebsite);
                        coWebsite.remove();
                        resolve();
                    }, animationTime);
                })
        );
        return this.currentOperationPromise;
    }

    public closeJitsi() {
        const jitsi = this.searchJitsi();
        if (jitsi) {
            const newMainCoWebsite = get(coWebsites)[1];
            if (newMainCoWebsite) {
                this.moveToMainCoWebsite(newMainCoWebsite);
            }
            this.closeCoWebsite(jitsi);
        }
    }

    public closeCoWebsites(): Promise<void> {
        this.currentOperationPromise = this.currentOperationPromise
        .then(() => {
            get(coWebsites).forEach((coWebsite: HTMLIFrameElement) => {
                this.closeCoWebsite(coWebsite);
            });
        });
        return this.currentOperationPromise;
    }

    public getGameSize(): { width: number; height: number } {
        if (this.openedMain !== iframeStates.opened) {
            return {
                width: window.innerWidth,
                height: window.innerHeight,
            };
        }
        if (!this.verticalMode) {
            return {
                width: window.innerWidth - this.width,
                height: window.innerHeight,
            };
        } else {
            return {
                width: window.innerWidth,
                height: window.innerHeight - this.height,
            };
        }
    }

    private fire(): void {
        this._onResize.next();
        waScaleManager.applyNewSize();
    }

    private fullscreen(): void {
        if (this.isFullScreen) {
            this.resetStyleMain();
            this.fire();
            //we don't trigger a resize of the phaser game since it won't be visible anyway.
            HtmlUtils.getElementByIdOrFail(cowebsiteOpenFullScreenImageId).style.display = "inline";
            HtmlUtils.getElementByIdOrFail(cowebsiteCloseFullScreenImageId).style.display = "none";
        } else {
            this.verticalMode ? (this.height = window.innerHeight) : (this.width = window.innerWidth);
            //we don't trigger a resize of the phaser game since it won't be visible anyway.
            HtmlUtils.getElementByIdOrFail(cowebsiteOpenFullScreenImageId).style.display = "none";
            HtmlUtils.getElementByIdOrFail(cowebsiteCloseFullScreenImageId).style.display = "inline";
        }
    }
}

export const coWebsiteManager = new CoWebsiteManager();
