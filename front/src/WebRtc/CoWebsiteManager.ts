import { HtmlUtils } from "./HtmlUtils";
import { Subject } from "rxjs";
import { iframeListener } from "../Api/IframeListener";
import { touchScreenManager } from "../Touch/TouchScreenManager";
import { waScaleManager } from "../Phaser/Services/WaScaleManager";

enum iframeStates {
    closed = 1,
    loading, // loading an iframe can be slow, so we show some placeholder until it is ready
    opened,
}

const cowebsiteDomId = "cowebsite"; // the id of the whole container.
const cowebsiteContainerDomId = "cowebsite-container"; // the id of the whole container.
const cowebsiteMainDomId = "cowebsite-slot-0"; // the id of the parent div of the iframe.
const cowebsiteBufferDomId = "cowebsite-buffer"; // the id of the container who contains cowebsite iframes.
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

interface CoWebsite {
    iframe: HTMLIFrameElement,
    position: number
}

interface CoWebsiteSlot {
    container: HTMLElement,
    position: number
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
    private cowebsiteDom: HTMLDivElement;
    private cowebsiteContainerDom: HTMLDivElement;
    private resizing: boolean = false;
    private cowebsiteMainDom: HTMLDivElement;
    private cowebsiteBufferDom: HTMLDivElement;
    private cowebsiteAsideDom: HTMLDivElement;
    private previousTouchMoveCoordinates: TouchMoveCoordinates | null = null; //only use on touchscreens to track touch movement

    private coWebsites: CoWebsite[] = [];

    private slots: CoWebsiteSlot[];

    private resizeObserver = new ResizeObserver(entries => {
        this.coWebsites.forEach((coWebsite: CoWebsite) => {
            const slot =  this.getSlotByPosition(coWebsite.position);

            if (slot) {
                this.setIframeOffset(coWebsite, slot);
            }
        });
    });

    get width(): number {
        return this.cowebsiteDom.clientWidth;
    }

    set width(width: number) {
        this.cowebsiteDom.style.width = width + "px";
    }

    set widthPercent(width: number) {
        this.cowebsiteDom.style.width = width + "%";
    }

    get height(): number {
        return this.cowebsiteDom.clientHeight;
    }

    set height(height: number) {
        this.cowebsiteDom.style.height = height + "px";
    }

    get verticalMode(): boolean {
        return window.innerWidth < window.innerHeight;
    }

    get isFullScreen(): boolean {
        return this.verticalMode ? this.height === window.innerHeight : this.width === window.innerWidth;
    }

    constructor() {
        this.cowebsiteDom = HtmlUtils.getElementByIdOrFail<HTMLDivElement>(cowebsiteDomId);
        this.cowebsiteContainerDom = HtmlUtils.getElementByIdOrFail<HTMLDivElement>(cowebsiteContainerDomId);
        this.cowebsiteMainDom = HtmlUtils.getElementByIdOrFail<HTMLDivElement>(cowebsiteMainDomId);
        this.cowebsiteBufferDom = HtmlUtils.getElementByIdOrFail<HTMLDivElement>(cowebsiteBufferDomId);
        this.cowebsiteAsideDom = HtmlUtils.getElementByIdOrFail<HTMLDivElement>(cowebsiteAsideDomId);
        this.initResizeListeners(touchScreenManager.supportTouchScreen);

        this.resizeObserver.observe(this.cowebsiteDom);
        this.resizeObserver.observe(this.cowebsiteContainerDom);

        this.slots = [
            {
                container: this.cowebsiteMainDom,
                position: 0
            },
            {
                container: HtmlUtils.getElementByIdOrFail<HTMLDivElement>('cowebsite-slot-1'),
                position: 1
            },
            {
                container: HtmlUtils.getElementByIdOrFail<HTMLDivElement>('cowebsite-slot-2'),
                position: 2
            },
            {
                container: HtmlUtils.getElementByIdOrFail<HTMLDivElement>('cowebsite-slot-3'),
                position: 3
            },
            {
                container: HtmlUtils.getElementByIdOrFail<HTMLDivElement>('cowebsite-slot-4'),
                position: 4
            },
        ];

        this.initActionsListeners();

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
            this.cowebsiteMainDom.style.display = "none";
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
            this.cowebsiteMainDom.style.display = "block";
            this.resizing = false;
        });
    }

    private getDevicePixelRatio(): number {
        //on chrome engines, movementX and movementY return global screens coordinates while other browser return pixels
        //so on chrome-based browser we need to adjust using 'devicePixelRatio'
        return window.navigator.userAgent.includes("Firefox") ? 1 : window.devicePixelRatio;
    }

    private closeMain(): void {
        this.cowebsiteDom.classList.remove("loaded"); //edit the css class to trigger the transition
        this.cowebsiteDom.classList.add("hidden");
        this.openedMain = iframeStates.closed;
        this.resetStyleMain();
    }
    private loadMain(): void {
        this.cowebsiteDom.classList.remove("hidden"); //edit the css class to trigger the transition
        this.cowebsiteDom.classList.add("loading");
        this.openedMain = iframeStates.loading;
    }
    private openMain(): void {
        this.cowebsiteDom.classList.remove("loading", "hidden"); //edit the css class to trigger the transition
        this.openedMain = iframeStates.opened;
        this.resetStyleMain();
    }

    public resetStyleMain() {
        this.cowebsiteDom.style.width = "";
        this.cowebsiteDom.style.height = "";
    }

    private initActionsListeners() {
        this.slots.forEach((slot: CoWebsiteSlot) => {
            const expandButton = slot.container.querySelector('.expand');
            const highlightButton = slot.container.querySelector('.hightlight');
            const closeButton = slot.container.querySelector('.close');

            if (expandButton) {
                expandButton.addEventListener('click', (event) => {
                    event.preventDefault();
                    const coWebsite = this.getCoWebsiteByPosition(slot.position);

                    if (!coWebsite) {
                        return;
                    }

                    this.moveRightPreviousCoWebsite(coWebsite, 0);
                });
            }

            if (highlightButton) {
                highlightButton.addEventListener('click', (event) => {
                    event.preventDefault();
                    const coWebsite = this.getCoWebsiteByPosition(slot.position);

                    if (!coWebsite) {
                        return;
                    }

                    this.moveRightPreviousCoWebsite(coWebsite, 1);
                });
            }

            if (closeButton) {
                closeButton.addEventListener('click', (event) => {
                    event.preventDefault();
                    const coWebsite = this.getCoWebsiteByPosition(slot.position);

                    if (!coWebsite) {
                        return;
                    }

                    this.removeCoWebsiteFromStack(coWebsite);
                });
            }
        });
    }

    private searchCoWebsiteById(coWebsiteId: string) {
        return this.coWebsites.find((coWebsite: CoWebsite) => coWebsite.iframe.id === coWebsiteId);
    }

    private getSlotByPosition(position: number): CoWebsiteSlot|undefined {
        return this.slots.find((slot: CoWebsiteSlot) => slot.position === position);
    }

    private getCoWebsiteByPosition(position: number): CoWebsite|undefined {
        return this.coWebsites.find((coWebsite: CoWebsite) => coWebsite.position === position);
    }

    private setIframeOffset(coWebsite: CoWebsite, slot: CoWebsiteSlot) {
        const bounding = slot.container.getBoundingClientRect();

        coWebsite.iframe.style.top = bounding.top + 'px';
        coWebsite.iframe.style.left = bounding.left + 'px';
        coWebsite.iframe.style.width = (bounding.right - bounding.left) + 'px';
        coWebsite.iframe.style.height = (bounding.bottom - bounding.top) + 'px';
    }

    private moveCoWebsite(coWebsite: CoWebsite, newPosition: number) {
        const newSlot = this.getSlotByPosition(newPosition);

        if (!newSlot) {
            return;
        }

        if (newPosition === 0) {
            coWebsite.iframe.classList.add('main');
            coWebsite.iframe.scrolling = "yes";
        } else {
            coWebsite.iframe.classList.remove('main');
            coWebsite.iframe.scrolling = "no";
        }

        if (newPosition === 1) {
            coWebsite.iframe.classList.add('sub-main');
            coWebsite.iframe.scrolling = "yes";
        } else {
            coWebsite.iframe.classList.remove('sub-main');
            coWebsite.iframe.scrolling = "no";
        }

        coWebsite.position = newPosition;

        this.setIframeOffset(coWebsite, newSlot);
    }

    private moveLeftPreviousCoWebsite(coWebsite: CoWebsite, newPosition: number) {
        this.moveCoWebsite(coWebsite, newPosition);
        this.coWebsites.forEach((coWebsiteToCheck: CoWebsite) => {
            if (coWebsiteToCheck.position === coWebsite.position + 1) {
                this.moveLeftPreviousCoWebsite(coWebsiteToCheck, coWebsiteToCheck.position--);
            }
        });
    }

    private moveRightPreviousCoWebsite(coWebsite: CoWebsite, newPosition: number) {
        this.moveCoWebsite(coWebsite, newPosition);

        this.coWebsites.forEach((coWebsiteToCheck: CoWebsite) => {
            if (coWebsiteToCheck.position === coWebsite.position) {
                this.moveRightPreviousCoWebsite(coWebsiteToCheck, coWebsiteToCheck.position++);
            }
        });
    }

    private removeCoWebsiteFromStack(coWebsite: CoWebsite) {
        this.coWebsites = this.coWebsites.filter(
            (coWebsiteToRemove: CoWebsite) => coWebsiteToRemove.iframe.id !== coWebsite.iframe.id
        );

        if (this.coWebsites.length < 1) {
            this.closeMain();
            return;
        }

        const previousCoWebsite = this.coWebsites.find((coWebsiteToCheck: CoWebsite) =>
            coWebsite.position + 1 === coWebsiteToCheck.position
        );

        if (previousCoWebsite) {
            this.moveLeftPreviousCoWebsite(previousCoWebsite, coWebsite.position);
        }

        coWebsite.iframe.remove();
    }

    public searchJitsi(): CoWebsite|undefined {
        return this.coWebsites.find((coWebsite : CoWebsite) =>
            coWebsite.iframe.id.toLowerCase().includes('jitsi')
        );
    }

    public loadCoWebsite(
        url: string,
        base: string,
        allowApi?: boolean,
        allowPolicy?: string,
        widthPercent?: number
    ): void {
        if (this.coWebsites.length < 1) {
            this.loadMain();
        } else if (this.coWebsites.length === 5) {
            return;
        }

        const iframe = document.createElement("iframe");

        do {
            iframe.id = "cowebsite-iframe-" + (Math.random() + 1).toString(36).substring(7);
        } while (iframe.id.toLowerCase().includes('jitsi') || this.searchCoWebsiteById(iframe.id));

        iframe.src = new URL(url, base).toString()

        if (allowPolicy) {
            iframe.allow = allowPolicy;
        }

        const onloadPromise = new Promise<void>((resolve) => {
            iframe.onload = () => resolve();
        });

        if (allowApi) {
            iframeListener.registerIframe(iframe);
        }

        const coWebsite = {
            iframe,
            position: this.coWebsites.length,
        };

        if (coWebsite.position) {
            iframe.scrolling = "no";
        }

        this.coWebsites.push(coWebsite);

        const onTimeoutPromise = new Promise<void>((resolve) => {
            setTimeout(() => resolve(), 2000);
        });

        this.currentOperationPromise = this.currentOperationPromise
            .then(() => Promise.race([onloadPromise, onTimeoutPromise]))
            .then(() => {
                if (this.coWebsites.length === 1) {
                    this.openMain();
                    if (widthPercent) {
                        this.widthPercent = widthPercent;
                    }
                    setTimeout(() => {
                        this.fire();

                        this.cowebsiteBufferDom.appendChild(coWebsite.iframe);
                        this.moveCoWebsite(coWebsite, coWebsite.position);
                    }, animationTime);
                } else {
                    this.cowebsiteBufferDom.appendChild(coWebsite.iframe);
                    this.moveCoWebsite(coWebsite, coWebsite.position);
                }
            })
            .catch((err) => {
                console.error("Error loadCoWebsite => ", err);
                this.removeCoWebsiteFromStack(coWebsite);
            });
    }

    /**
     * Just like loadCoWebsite but the div can be filled by the user.
     */
    public insertCoWebsite(callback: (jitsiBuffer: HTMLDivElement) => Promise<void>, widthPercent?: number): void {
        if (this.coWebsites.length < 1) {
            this.loadMain();
        } else if (this.coWebsites.length === 5) {
            return;
        }

        this.currentOperationPromise = this.currentOperationPromise
            .then(() => callback(this.cowebsiteBufferDom))
            .then(() => {
                const iframe = this.cowebsiteBufferDom.querySelector<HTMLIFrameElement>('[id*="jitsi" i]');

                if (!iframe) {
                    console.error("Error insertCoWebsite => Cannot find Iframe Element on Jitsi DOM");
                    return;
                }

                const coWebsite = {
                    iframe,
                    position: 0,
                };

                this.coWebsites.push(coWebsite);

                if (coWebsite.position) {
                    iframe.scrolling = "no";
                }

                this.coWebsites.push(coWebsite);

                if (this.coWebsites.length === 1) {
                    this.openMain();

                    if (widthPercent) {
                        this.widthPercent = widthPercent;
                    }

                    setTimeout(() => {
                        this.fire();
                    }, animationTime);
                }

                this.moveRightPreviousCoWebsite(coWebsite, coWebsite.position);
            })
            .catch((err) => {
                console.error("Error insertCoWebsite => ", err);
            });
    }

    public closeCoWebsite(coWebsite: CoWebsite): Promise<void> {
        this.currentOperationPromise = this.currentOperationPromise.then(
            () =>
                new Promise((resolve) => {
                    if (this.coWebsites.length === 1) {
                        if (this.openedMain === iframeStates.closed) resolve(); //this method may be called twice, in case of iframe error for example
                        this.closeMain();
                        this.fire();
                    }

                    if (coWebsite) {
                        iframeListener.unregisterIframe(coWebsite.iframe);
                    }

                    setTimeout(() => {
                        this.removeCoWebsiteFromStack(coWebsite);
                        resolve();
                    }, animationTime);
                })
        );
        return this.currentOperationPromise;
    }

    public closeJitsi() {
        const jitsi = this.searchJitsi();
        if (jitsi) {
            this.closeCoWebsite(jitsi);
        }
    }

    public closeCoWebsites(): Promise<void> {
        this.currentOperationPromise = this.currentOperationPromise
        .then(() => {
            this.coWebsites.forEach((coWebsite: CoWebsite) => {
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
