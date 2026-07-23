/**
 * Weld SDK - Iframe Manager
 * Manages creation, lifecycle, and communication with multiple iframes
 */

import type { ResolvedConfig, DeviceInfo } from '../types/config';
import { Logger } from '../utils/logger';

/**
 * Iframe types
 */
export enum IframeType {
  LAUNCHER = 'launcher',
  WIDGET = 'widget',
  BACKDROP = 'backdrop',
}

/**
 * Iframe metadata
 */
export interface IframeMetadata {
  type: IframeType;
  element: HTMLIFrameElement;
  container: HTMLDivElement;
  ready: boolean;
  visible: boolean;
  createdAt: number;
}

/**
 * Device detection result
 */
function detectDevice(): DeviceInfo {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const userAgent = navigator.userAgent;

  const isMobile = width < 768;
  const isTablet = width >= 768 && width <= 1024;
  const isDesktop = width > 1024;
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  return {
    type: isMobile ? 'mobile' : isTablet ? 'tablet' : 'desktop',
    isMobile,
    isTablet,
    isDesktop,
    isTouchDevice,
    screenWidth: width,
    screenHeight: height,
    orientation: width > height ? 'landscape' : 'portrait',
    userAgent,
  };
}

// Forward reference for MessageBroker to avoid circular imports
interface MessageBrokerInterface {
  setIframeDomLoaded(iframeType: IframeType): void;
}

/**
 * IframeManager class
 * Orchestrates multiple iframes for the widget system
 */
export class IframeManager {
  private config: ResolvedConfig;
  private logger: Logger;
  private iframes: Map<IframeType, IframeMetadata> = new Map();
  private rootContainer: HTMLDivElement | null = null;
  private appContainer: HTMLDivElement | null = null;
  private modalContainer: HTMLDivElement | null = null;
  private deviceInfo: DeviceInfo;
  private styleElement: HTMLStyleElement | null = null;
  private messageBroker: MessageBrokerInterface | null = null;

  // Bound handlers for proper cleanup
  private boundHandleResize: () => void;
  private boundHandleOrientationChange: () => void;
  private boundHandleVisualViewportResize: () => void;

  // Guard flag to prevent double-binding event listeners
  private eventListenersBound = false;

  constructor(config: ResolvedConfig) {
    this.config = config;
    this.logger = new Logger(config.logging);
    this.deviceInfo = detectDevice();

    // Bind handlers once for proper cleanup
    this.boundHandleResize = this.handleResize.bind(this);
    this.boundHandleOrientationChange = this.handleOrientationChange.bind(this);
    this.boundHandleVisualViewportResize = this.handleVisualViewportResize.bind(this);

    this.logger.info('IframeManager initialized', {
      device: this.deviceInfo.type,
      mobile: this.deviceInfo.isMobile,
    });
  }

  /**
   * Initialize all containers and iframes
   * @param messageBroker - MessageBroker instance for coordinating ready state
   */
  public async init(messageBroker?: MessageBrokerInterface): Promise<void> {
    this.logger.debug('Initializing iframe manager');
    this.messageBroker = messageBroker || null;

    try {
      // Create root container structure
      this.createRootContainer();

      // Inject CSS
      this.injectCSS();

      // Create iframes
      await this.createLauncherIframe();
      await this.createBackdropIframe();
      await this.createWidgetIframe();

      // Setup event listeners
      this.setupEventListeners();

      this.logger.info('IframeManager initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize IframeManager', error);
      throw error;
    }
  }

  /**
   * Create root container structure
   * Reuses existing container if it has the same widgetId (singleton behavior)
   */
  private createRootContainer(): void {
    const existingContainer = document.getElementById('weld-container') as HTMLDivElement | null;
    if (existingContainer) {
      // Reuse if same widgetId
      if (existingContainer.getAttribute('data-widget-id') === this.config.widgetId) {
        this.logger.debug('Reusing existing root container');
        this.rootContainer = existingContainer;
        this.appContainer = existingContainer.querySelector('.weld-app') as HTMLDivElement;
        this.modalContainer = document.getElementById('weld-modal-container') as HTMLDivElement;
        return;
      }
      this.logger.warn('Weld container already exists with different widgetId, removing old instance');
      existingContainer.remove();
    }

    // Create root container
    this.rootContainer = document.createElement('div');
    this.rootContainer.id = 'weld-container';
    this.rootContainer.className = 'weld-namespace';
    this.rootContainer.setAttribute('data-widget-id', this.config.widgetId);

    // Create app container
    this.appContainer = document.createElement('div');
    this.appContainer.className = 'weld-app';
    this.appContainer.setAttribute('aria-live', 'polite');
    this.appContainer.setAttribute('role', 'complementary');
    this.appContainer.setAttribute('aria-label', 'Weld Helpdesk Widget');

    // Create modal container
    this.modalContainer = document.createElement('div');
    this.modalContainer.id = 'weld-modal-container';

    // Assemble structure
    this.rootContainer.appendChild(this.appContainer);
    this.rootContainer.appendChild(this.modalContainer);
    document.body.appendChild(this.rootContainer);

    this.logger.debug('Root container created');
  }

  /**
   * Inject CSS into the page
   */
  private injectCSS(): void {
    // Remove existing style if present
    const existingStyle = document.getElementById('weld-styles');
    if (existingStyle) {
      existingStyle.remove();
    }

    this.styleElement = document.createElement('style');
    this.styleElement.id = 'weld-styles';
    this.styleElement.textContent = this.generateCSS();
    document.head.appendChild(this.styleElement);

    this.logger.debug('CSS injected');
  }

  /**
   * Generate CSS for containers
   */
  private generateCSS(): string {
    return `
      /* Import main stylesheet */
      @import url('/styles/index.css');

      /* Prevent page scroll when mobile widget is open */
      body.weld-mobile-open {
        overflow: hidden !important;
        position: fixed !important;
        width: 100% !important;
        height: 100% !important;
      }

      /* High contrast mode support */
      @media (prefers-contrast: high) {
        .weld-namespace {
          --weld-color-border: currentColor;
        }
      }
    `;
  }

  /**
   * Create launcher iframe
   */
  private async createLauncherIframe(): Promise<void> {
    // Guard: skip if launcher iframe already exists
    if (this.iframes.has(IframeType.LAUNCHER)) {
      this.logger.debug('Launcher iframe already exists, skipping creation');
      return;
    }

    const { iframes } = this.config;
    const { launcher } = iframes;

    // Create container
    const container = document.createElement('div');
    container.className = 'weld-launcher-frame';
    container.setAttribute('data-state', 'visible');
    // Container is larger than the button to allow hover animations (scale, shadow) without clipping
    const launcherPadding = 10;
    container.style.cssText = `
      position: fixed;
      bottom: calc(${launcher.position.bottom} - ${launcherPadding}px);
      right: calc(${launcher.position.right} - ${launcherPadding}px);
      width: calc(${launcher.size} + ${launcherPadding * 2}px);
      height: calc(${launcher.size} + ${launcherPadding * 2}px);
      z-index: 2147483003;
      pointer-events: none;
      display: block;
    `;

    // Create iframe
    const iframe = document.createElement('iframe');
    iframe.name = launcher.name;
    iframe.title = 'Weld Launcher';
    iframe.src = this.buildIframeUrl(launcher.url);
    iframe.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      background: none;
      color-scheme: none;
      display: block;
      pointer-events: auto;
      border-radius: 50%;
      filter: drop-shadow(rgba(9, 14, 21, 0.54) 0px 1px 6px) drop-shadow(rgba(9, 14, 21, 0.9) 0px 2px 32px);
    `;
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');

    container.appendChild(iframe);
    this.appContainer?.appendChild(container);

    // Store metadata
    this.iframes.set(IframeType.LAUNCHER, {
      type: IframeType.LAUNCHER,
      element: iframe,
      container,
      ready: false,
      visible: true,
      createdAt: Date.now(),
    });

    // When DOM loads, notify MessageBroker to send weld:init
    let launcherRetried = false;
    iframe.onload = () => {
      const metadata = this.iframes.get(IframeType.LAUNCHER);
      if (metadata) {
        this.logger.debug('Launcher iframe DOM loaded');
        this.messageBroker?.setIframeDomLoaded(IframeType.LAUNCHER);
      }
    };

    iframe.onerror = () => {
      this.logger.error('Launcher iframe failed to load');
      if (!launcherRetried) {
        launcherRetried = true;
        this.logger.info('Retrying launcher iframe load...');
        setTimeout(() => { iframe.src = this.buildIframeUrl(launcher.url); }, 3000);
      } else {
        this.config.onError?.(new Error('Failed to load widget launcher'));
      }
    };

    this.logger.debug('Launcher iframe created');
  }

  /**
   * Create widget iframe
   */
  private async createWidgetIframe(): Promise<void> {
    // Guard: skip if widget iframe already exists
    if (this.iframes.has(IframeType.WIDGET)) {
      this.logger.debug('Widget iframe already exists, skipping creation');
      return;
    }

    const { iframes } = this.config;
    const { widget } = iframes;

    // Create container
    const container = document.createElement('div');
    container.className = 'weld-widget-frame';
    container.setAttribute('data-state', 'closed');

    // Apply different styles for mobile vs desktop
    if (this.deviceInfo.isMobile) {
      // Mobile: full-screen with dynamic viewport height to handle URL bar
      container.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        width: 100vw;
        height: 100dvh;
        height: 100vh;
        z-index: 2147483001;
        pointer-events: none;
        display: none;
        border-radius: 0;
        overflow: hidden;
        background: transparent;
      `;
      // Use visualViewport API for accurate height on mobile browsers
      if (window.visualViewport) {
        container.style.height = `${window.visualViewport.height}px`;
      }
    } else {
      // Desktop: positioned widget with border, shadow and animation
      container.style.cssText = `
        position: fixed;
        bottom: ${widget.position.bottom};
        right: ${widget.position.right};
        width: ${widget.width};
        height: ${widget.height};
        max-width: 100vw;
        z-index: 2147483001;
        pointer-events: none;
        display: none;
        border-radius: 24px;
        overflow: hidden;
        background: #ffffff;
        box-shadow: rgba(9, 14, 21, 0.16) 0px 5px 40px 0px;
        border: 1px solid rgba(0, 0, 0, 0.1);
        opacity: 0;
        transform: scale(0.95) translateY(10px);
        transform-origin: bottom right;
        transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1), transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      `;
    }

    // Create iframe
    const iframe = document.createElement('iframe');
    iframe.name = widget.name;
    iframe.title = 'Weld Widget';
    iframe.src = this.buildIframeUrl(widget.url);
    iframe.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      background: transparent;
      display: block;
      border-radius: ${this.deviceInfo.isMobile ? '0' : '24px'};
    `;
    iframe.setAttribute('allow', 'clipboard-write; camera; microphone');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');

    container.appendChild(iframe);
    this.appContainer?.appendChild(container);

    // Store metadata
    this.iframes.set(IframeType.WIDGET, {
      type: IframeType.WIDGET,
      element: iframe,
      container,
      ready: false,
      visible: false,
      createdAt: Date.now(),
    });

    // When DOM loads, notify MessageBroker to send weld:init
    let widgetRetried = false;
    iframe.onload = () => {
      const metadata = this.iframes.get(IframeType.WIDGET);
      if (metadata) {
        this.logger.debug('Widget iframe DOM loaded');
        this.messageBroker?.setIframeDomLoaded(IframeType.WIDGET);
      }
    };

    iframe.onerror = () => {
      this.logger.error('Widget iframe failed to load');
      if (!widgetRetried) {
        widgetRetried = true;
        this.logger.info('Retrying widget iframe load...');
        setTimeout(() => { iframe.src = this.buildIframeUrl(widget.url); }, 3000);
      } else {
        this.config.onError?.(new Error('Failed to load widget'));
      }
    };

    this.logger.debug('Widget iframe created');
  }

  /**
   * Create backdrop iframe — disabled, widget stays non-modal so users can interact with the page
   */
  private async createBackdropIframe(): Promise<void> {
    this.logger.debug('Backdrop disabled, skipping creation');
  }

  /**
   * Build iframe URL with parameters
   */
  private buildIframeUrl(path: string): string {
    const { widgetId, api } = this.config;
    const baseUrl = api.baseUrl;

    // Handle paths that may already have query parameters
    const url = new URL(path, baseUrl);
    url.searchParams.set('widgetId', widgetId);
    url.searchParams.set('device', this.deviceInfo.type);
    url.searchParams.set('mobile', String(this.deviceInfo.isMobile));
    url.searchParams.set('parentOrigin', window.location.origin);

    if (this.config.testMode) {
      url.searchParams.set('testMode', 'true');
    }

    return url.toString();
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Guard: prevent double-binding
    if (this.eventListenersBound) {
      this.logger.debug('Event listeners already bound, skipping');
      return;
    }
    this.eventListenersBound = true;

    // Window resize - use bound handler for proper cleanup
    window.addEventListener('resize', this.boundHandleResize);

    // Orientation change - use bound handler for proper cleanup
    window.addEventListener('orientationchange', this.boundHandleOrientationChange);

    // Visual viewport resize (handles mobile URL bar and keyboard)
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this.boundHandleVisualViewportResize);
      window.visualViewport.addEventListener('scroll', this.boundHandleVisualViewportResize);
    }

    this.logger.debug('Event listeners setup');
  }

  /**
   * Handle window resize
   */
  private handleResize(): void {
    this.deviceInfo = detectDevice();
    this.logger.debug('Window resized', { device: this.deviceInfo.type });
  }

  /**
   * Handle orientation change
   */
  private handleOrientationChange(): void {
    this.deviceInfo = detectDevice();
    this.logger.debug('Orientation changed', { orientation: this.deviceInfo.orientation });
  }

  /**
   * Handle visual viewport resize (mobile URL bar, keyboard)
   */
  private handleVisualViewportResize(): void {
    if (!this.deviceInfo.isMobile || !window.visualViewport) return;

    const widget = this.iframes.get(IframeType.WIDGET);
    if (widget && widget.visible) {
      const vh = window.visualViewport.height;
      const offsetTop = window.visualViewport.offsetTop;

      widget.container.style.height = `${vh}px`;
      widget.container.style.top = `${offsetTop}px`;

      this.logger.debug('Visual viewport resized', { height: vh, offsetTop });
    }
  }

  /**
   * Get iframe by type
   */
  public getIframe(type: IframeType): IframeMetadata | undefined {
    return this.iframes.get(type);
  }

  /**
   * Get iframe element
   */
  public getIframeElement(type: IframeType): HTMLIFrameElement | undefined {
    return this.iframes.get(type)?.element;
  }

  /**
   * Get iframe container
   */
  public getIframeContainer(type: IframeType): HTMLDivElement | undefined {
    return this.iframes.get(type)?.container;
  }

  /**
   * Mark iframe as ready
   */
  public setIframeReady(type: IframeType): void {
    const iframe = this.iframes.get(type);
    if (iframe) {
      iframe.ready = true;
      this.logger.debug(`Iframe ${type} marked as ready`);
    }
  }

  /**
   * Check if all iframes are ready
   */
  public areAllIframesReady(): boolean {
    for (const [type, iframe] of this.iframes) {
      if (type !== IframeType.BACKDROP && !iframe.ready) {
        return false;
      }
    }
    return true;
  }

  /**
   * Show iframe
   */
  public showIframe(type: IframeType): void {
    const iframe = this.iframes.get(type);
    if (!iframe) {
      console.warn(`[Weld SDK] showIframe: iframe ${type} not found`);
      return;
    }

    console.log(`[Weld SDK] Showing iframe ${type}`, { currentDisplay: iframe.container.style.display });

    iframe.visible = true;
    iframe.container.setAttribute('data-state', type === IframeType.BACKDROP ? 'visible' : 'open');
    iframe.container.style.pointerEvents = 'auto';
    iframe.container.style.display = 'block';

    // Trigger open animation for widget on desktop
    if (type === IframeType.WIDGET && !this.deviceInfo.isMobile) {
      // Force reflow to ensure transition works
      iframe.container.offsetHeight;
      // Animate to visible state
      iframe.container.style.opacity = '1';
      iframe.container.style.transform = 'scale(1) translateY(0)';
    }

    // Handle mobile scroll lock
    if (this.deviceInfo.isMobile && type === IframeType.WIDGET) {
      document.body.classList.add('weld-mobile-open');
    }

    // Hide launcher on mobile when widget is open (full-screen mode)
    if (this.deviceInfo.isMobile && type === IframeType.WIDGET) {
      const launcher = this.iframes.get(IframeType.LAUNCHER);
      if (launcher) {
        launcher.container.style.display = 'none';
      }

      // Apply accurate viewport height using visualViewport API
      if (window.visualViewport) {
        iframe.container.style.height = `${window.visualViewport.height}px`;
        iframe.container.style.top = `${window.visualViewport.offsetTop}px`;
      }
    }

    console.log(`[Weld SDK] Iframe ${type} shown`, { newDisplay: iframe.container.style.display });
  }

  /**
   * Hide iframe
   */
  public hideIframe(type: IframeType): void {
    const iframe = this.iframes.get(type);
    if (!iframe) {
      console.warn(`[Weld SDK] hideIframe: iframe ${type} not found`);
      return;
    }

    console.log(`[Weld SDK] Hiding iframe ${type}`, { currentDisplay: iframe.container.style.display });

    iframe.visible = false;
    iframe.container.setAttribute('data-state', type === IframeType.BACKDROP ? 'hidden' : 'closed');
    iframe.container.style.pointerEvents = 'none';

    // Animate close for widget on desktop, then hide after animation
    if (type === IframeType.WIDGET && !this.deviceInfo.isMobile) {
      // Animate to hidden state
      iframe.container.style.opacity = '0';
      iframe.container.style.transform = 'scale(0.95) translateY(10px)';
      // Hide after transition completes
      setTimeout(() => {
        if (!iframe.visible) {
          iframe.container.style.display = 'none';
        }
      }, 200);
    } else {
      iframe.container.style.display = 'none';
    }

    // Remove mobile scroll lock
    if (this.deviceInfo.isMobile && type === IframeType.WIDGET) {
      document.body.classList.remove('weld-mobile-open');
    }

    // Show launcher again on mobile when widget is closed
    if (this.deviceInfo.isMobile && type === IframeType.WIDGET) {
      const launcher = this.iframes.get(IframeType.LAUNCHER);
      if (launcher) {
        launcher.container.style.display = 'block';
      }
    }

    console.log(`[Weld SDK] Iframe ${type} hidden`, { newDisplay: iframe.container.style.display });
  }

  /**
   * Get device info
   */
  public getDeviceInfo(): DeviceInfo {
    return this.deviceInfo;
  }

  /**
   * Get modal container
   */
  public getModalContainer(): HTMLDivElement | null {
    return this.modalContainer;
  }

  /**
   * Destroy all iframes and cleanup
   */
  public destroy(): void {
    this.logger.debug('Destroying iframe manager');

    // Remove event listeners using bound handlers
    window.removeEventListener('resize', this.boundHandleResize);
    window.removeEventListener('orientationchange', this.boundHandleOrientationChange);

    // Remove visual viewport listeners
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this.boundHandleVisualViewportResize);
      window.visualViewport.removeEventListener('scroll', this.boundHandleVisualViewportResize);
    }

    // Remove mobile scroll lock
    document.body.classList.remove('weld-mobile-open');

    // Remove root container
    if (this.rootContainer) {
      this.rootContainer.remove();
      this.rootContainer = null;
    }

    // Remove style element
    if (this.styleElement) {
      this.styleElement.remove();
      this.styleElement = null;
    }

    // Clear iframe references
    this.iframes.clear();

    // Clear messageBroker reference
    this.messageBroker = null;

    // Reset guard flag
    this.eventListenersBound = false;

    this.logger.info('IframeManager destroyed');
  }
}
