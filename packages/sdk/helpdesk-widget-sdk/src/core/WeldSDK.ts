/**
 * Weld SDK - Main Entry Point
 * Public API for the Weld helpdesk widget
 */

import type { WeldConfig, ResolvedConfig } from '../types/config';
import { resolveConfig } from '../types/config';
import type { WeldState } from '../types/state';
import type { MessageType } from '../types/messages';
import { Logger } from '../utils/logger';
import { IframeManager, IframeType } from './IframeManager';
import { MessageBroker } from './MessageBroker';
import { StateCoordinator } from './StateCoordinator';
import packageJson from '../../package.json';

/**
 * Module-level singleton registry keyed by widgetId
 */
const sdkRegistry = new Map<string, WeldSDK>();

/**
 * SessionStorage key helpers
 */
function openStateKey(widgetId: string): string {
  return `weld-widget-open-${widgetId}`;
}

/**
 * SDK initialization status
 */
enum SDKStatus {
  UNINITIALIZED = 'uninitialized',
  INITIALIZING = 'initializing',
  READY = 'ready',
  ERROR = 'error',
  DESTROYED = 'destroyed',
}

/**
 * User identification data
 */
export interface UserIdentity {
  userId: string;
  email?: string;
  name?: string;
  avatar?: string;
  metadata?: Record<string, any>;
}

/**
 * WeldSDK class
 * Main SDK interface for embedding the widget
 */
export class WeldSDK {
  private config: ResolvedConfig;
  private logger: Logger;
  private iframeManager: IframeManager;
  private messageBroker: MessageBroker;
  private stateCoordinator: StateCoordinator;
  private status: SDKStatus = SDKStatus.UNINITIALIZED;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;

  // Bound event handlers for proper cleanup
  private boundHandleLauncherClick: (event: MessageEvent) => void;

  // Subscription IDs for cleanup
  private subscriptionIds: string[] = [];

  // Page tracking cleanup
  private pageTrackingCleanup: (() => void) | null = null;

  constructor(config: WeldConfig) {
    // Resolve configuration
    this.config = resolveConfig(config);

    // Initialize logger
    this.logger = new Logger(this.config.logging);
    this.logger.info('WeldSDK created', {
      widgetId: this.config.widgetId,
    });

    // Create ready promise
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    // Bind handlers once for proper cleanup
    this.boundHandleLauncherClick = this.handleLauncherClickMessage.bind(this);

    // Initialize managers
    this.iframeManager = new IframeManager(this.config);
    this.messageBroker = new MessageBroker(
      this.config,
      this.iframeManager,
      this.logger
    );
    this.stateCoordinator = new StateCoordinator(
      this.messageBroker,
      this.logger
    );
  }

  /**
   * Handle launcher click messages from iframe
   */
  private handleLauncherClickMessage(event: MessageEvent): void {
    // Log all messages from iframes for debugging
    if (event.data?.type) {
      console.log('[Weld SDK] Received message:', event.data.type);
    }

    if (event.data?.type === 'launcher:clicked') {
      if (this.status !== SDKStatus.READY) {
        console.log('[Weld SDK] Launcher clicked but SDK not ready yet — waiting...');
        this.readyPromise?.then(() => {
          this.handleLauncherClickMessage(event);
        });
        return;
      }
      // Toggle behavior - if widget is open, close it; if closed, open it
      const state = this.stateCoordinator.getState();
      if (state.widget.isOpen) {
        console.log('[Weld SDK] Launcher clicked - closing widget (toggle)');
        this.close();
      } else {
        console.log('[Weld SDK] Launcher clicked - opening widget');
        this.open();
      }
    }
    if (event.data?.type === 'weld:close') {
      if (this.status !== SDKStatus.READY) return;
      console.log('[Weld SDK] Widget close requested');
      this.close();
    }
    if (event.data?.type === 'weld:unread-count') {
      const count = event.data.count ?? 0;
      // Forward to launcher iframe
      const launcherIframe = this.iframeManager.getIframe(IframeType.LAUNCHER);
      if (launcherIframe?.element?.contentWindow) {
        launcherIframe.element.contentWindow.postMessage({
          type: 'weld:unread-count',
          count
        }, '*');
      }
      // Update state coordinator for external API consumers
      this.stateCoordinator.setBadgeCount(count);
    }
    if (event.data?.type === 'weld:image:open' && event.data?.url) {
      this.showImageLightbox(event.data.url);
    }
  }

  /**
   * Show fullscreen image lightbox on the parent page
   */
  private showImageLightbox(url: string): void {
    // Remove existing lightbox if any
    const existing = document.getElementById('weld-image-lightbox');
    if (existing) existing.remove();

    // Zoom / pan state
    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let lastTranslateX = 0;
    let lastTranslateY = 0;

    const applyTransform = () => {
      img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    };

    const resetTransform = () => {
      scale = 1;
      translateX = 0;
      translateY = 0;
      applyTransform();
      img.style.cursor = 'zoom-in';
    };

    const overlay = document.createElement('div');
    overlay.id = 'weld-image-lightbox';
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(0, 0, 0, 0.92);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      cursor: pointer;
      overflow: hidden;
    `;

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    closeBtn.style.cssText = `
      position: absolute;
      top: 16px;
      right: 16px;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: none;
      background: rgba(255, 255, 255, 0.1);
      color: white;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
    `;
    closeBtn.onmouseenter = () => { closeBtn.style.background = 'rgba(255, 255, 255, 0.2)'; };
    closeBtn.onmouseleave = () => { closeBtn.style.background = 'rgba(255, 255, 255, 0.1)'; };

    // Download button
    const downloadBtn = document.createElement('a');
    downloadBtn.href = url;
    downloadBtn.download = '';
    downloadBtn.target = '_blank';
    downloadBtn.rel = 'noopener noreferrer';
    downloadBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
    downloadBtn.style.cssText = `
      position: absolute;
      top: 16px;
      right: 64px;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: none;
      background: rgba(255, 255, 255, 0.1);
      color: white;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
      text-decoration: none;
    `;
    downloadBtn.onmouseenter = () => { downloadBtn.style.background = 'rgba(255, 255, 255, 0.2)'; };
    downloadBtn.onmouseleave = () => { downloadBtn.style.background = 'rgba(255, 255, 255, 0.1)'; };

    // Image
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'Full size';
    img.draggable = false;
    img.style.cssText = `
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      border-radius: 8px;
      cursor: zoom-in;
      transition: transform 0.2s ease;
      user-select: none;
    `;

    // Click to toggle zoom
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      if (scale === 1) {
        // Zoom in to 2.5x centered on click position
        const rect = img.getBoundingClientRect();
        const clickX = e.clientX - rect.left - rect.width / 2;
        const clickY = e.clientY - rect.top - rect.height / 2;
        scale = 2.5;
        translateX = -clickX * 1.5;
        translateY = -clickY * 1.5;
        applyTransform();
        img.style.cursor = 'zoom-out';
      } else {
        // Zoom out - reset
        resetTransform();
      }
    });

    // Mouse wheel zoom
    overlay.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.25 : 0.25;
      const newScale = Math.min(Math.max(scale + delta, 1), 5);
      if (newScale === 1) {
        resetTransform();
      } else {
        scale = newScale;
        applyTransform();
        img.style.cursor = 'zoom-out';
      }
    }, { passive: false });

    // Drag to pan when zoomed
    img.addEventListener('mousedown', (e) => {
      if (scale <= 1) return;
      e.preventDefault();
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      lastTranslateX = translateX;
      lastTranslateY = translateY;
      img.style.cursor = 'grabbing';
      img.style.transition = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      translateX = lastTranslateX + (e.clientX - dragStartX);
      translateY = lastTranslateY + (e.clientY - dragStartY);
      applyTransform();
    });

    window.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      img.style.cursor = scale > 1 ? 'zoom-out' : 'zoom-in';
      img.style.transition = 'transform 0.2s ease';
    });

    // Touch: pinch to zoom + drag to pan
    let lastTouchDist = 0;
    let lastTouchScale = 1;

    overlay.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastTouchDist = Math.hypot(dx, dy);
        lastTouchScale = scale;
      } else if (e.touches.length === 1 && scale > 1) {
        isDragging = true;
        dragStartX = e.touches[0].clientX;
        dragStartY = e.touches[0].clientY;
        lastTranslateX = translateX;
        lastTranslateY = translateY;
        img.style.transition = 'none';
      }
    }, { passive: false });

    overlay.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        scale = Math.min(Math.max(lastTouchScale * (dist / lastTouchDist), 1), 5);
        if (scale === 1) {
          translateX = 0;
          translateY = 0;
        }
        applyTransform();
      } else if (e.touches.length === 1 && isDragging) {
        e.preventDefault();
        translateX = lastTranslateX + (e.touches[0].clientX - dragStartX);
        translateY = lastTranslateY + (e.touches[0].clientY - dragStartY);
        applyTransform();
      }
    }, { passive: false });

    overlay.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) {
        lastTouchDist = 0;
      }
      if (e.touches.length === 0) {
        isDragging = false;
        img.style.transition = 'transform 0.2s ease';
      }
    });

    const close = () => {
      document.removeEventListener('keydown', handleKeyDown);
      overlay.remove();
    };

    // Only close on backdrop click when not zoomed (prevent accidental close while panning)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && scale <= 1) close();
    });
    downloadBtn.addEventListener('click', (e) => e.stopPropagation());
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });

    // Close on Escape
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', handleKeyDown);

    overlay.appendChild(closeBtn);
    overlay.appendChild(downloadBtn);
    overlay.appendChild(img);
    document.body.appendChild(overlay);
  }

  /**
   * Initialize the SDK and render widget
   */
  public async init(): Promise<void> {
    if (this.status !== SDKStatus.UNINITIALIZED) {
      this.logger.warn('SDK already initialized');
      return this.readyPromise!;
    }

    this.status = SDKStatus.INITIALIZING;
    this.logger.info('Initializing WeldSDK');

    try {
      // Setup ready handlers BEFORE initializing iframes
      // This ensures we catch the weld:ready messages
      this.setupReadyHandlers();

      // Initialize iframe manager (creates iframes, triggers onload -> weld:init)
      await this.iframeManager.init(this.messageBroker);

      // Wait for all iframes JS to be ready (weld:ready messages received)
      await this.waitForIframesReady();

      // Mark as ready
      this.status = SDKStatus.READY;
      this.readyResolve?.();
      this.logger.info('WeldSDK ready');

      // Call onReady callback
      this.config.onReady?.();

      // Start tracking page URL changes
      this.startPageTracking();

      // Auto-open if widget was previously open (persisted in sessionStorage)
      if (this.wasOpen()) {
        this.logger.info('Restoring previously open widget from sessionStorage');
        this.open();
      }
    } catch (error) {
      this.status = SDKStatus.ERROR;
      this.logger.error('Failed to initialize WeldSDK', error);
      this.config.onError?.(error as Error);
      throw error;
    }

    return this.readyPromise!;
  }

  /**
   * Setup ready message handlers
   */
  private setupReadyHandlers(): void {
    // Subscribe to weld:ready messages from iframes
    const readySubId = this.messageBroker.subscribe('weld:ready' as MessageType, (payload) => {
      const { iframe } = payload;
      this.logger.debug('Iframe JS ready signal received', { iframe });

      // Map iframe name to type
      const iframeType = this.mapIframeNameToType(iframe);
      if (iframeType) {
        this.messageBroker.setIframeReady(iframeType);
      }
    });
    this.subscriptionIds.push(readySubId);

    // Listen for launcher click events from the iframe using bound handler
    window.addEventListener('message', this.boundHandleLauncherClick);
  }

  /**
   * Map iframe name to type
   */
  private mapIframeNameToType(name: string): IframeType | null {
    if (name.includes('launcher')) return IframeType.LAUNCHER;
    if (name.includes('widget')) return IframeType.WIDGET;
    return null;
  }

  /**
   * Wait for all iframes JS to be ready (weld:ready messages received)
   */
  private async waitForIframesReady(timeout = 10000): Promise<void> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const checkReady = () => {
        // Check for actual JS ready state (weld:ready received), not just DOM loaded
        if (this.messageBroker.areAllIframesJsReady()) {
          this.logger.debug('All iframes JS ready - initialization complete');
          resolve();
          return;
        }

        if (Date.now() - startTime > timeout) {
          // Log which iframes are not ready for debugging
          const launcherReady = this.messageBroker.isIframeJsReady(IframeType.LAUNCHER);
          const widgetReady = this.messageBroker.isIframeJsReady(IframeType.WIDGET);
          this.logger.error('Timeout waiting for iframes JS ready', {
            launcherReady,
            widgetReady,
          });
          reject(new Error(`Timeout waiting for iframes JS ready. Launcher: ${launcherReady}, Widget: ${widgetReady}`));
          return;
        }

        setTimeout(checkReady, 100);
      };

      checkReady();
    });
  }

  /**
   * Wait for SDK to be ready
   */
  public async ready(): Promise<void> {
    return this.readyPromise!;
  }

  /**
   * Check if SDK is ready
   */
  public isReady(): boolean {
    return this.status === SDKStatus.READY;
  }

  /**
   * Update callbacks on an existing instance (used by singleton reuse)
   */
  public updateCallbacks(config: Partial<WeldConfig>): void {
    if (config.onReady !== undefined) this.config.onReady = config.onReady;
    if (config.onOpen !== undefined) this.config.onOpen = config.onOpen;
    if (config.onClose !== undefined) this.config.onClose = config.onClose;
    if (config.onError !== undefined) this.config.onError = config.onError;
    if (config.onDestroy !== undefined) this.config.onDestroy = config.onDestroy;
    if (config.onMinimize !== undefined) this.config.onMinimize = config.onMinimize;
    if (config.onMaximize !== undefined) this.config.onMaximize = config.onMaximize;
  }

  /**
   * Persist open/closed state to sessionStorage
   */
  private persistOpenState(isOpen: boolean): void {
    try {
      sessionStorage.setItem(openStateKey(this.config.widgetId), isOpen ? 'true' : 'false');
    } catch {
      // sessionStorage might not be available
    }
  }

  /**
   * Clear persisted state from sessionStorage
   */
  private clearPersistedState(): void {
    try {
      sessionStorage.removeItem(openStateKey(this.config.widgetId));
    } catch {
      // sessionStorage might not be available
    }
  }

  /**
   * Check if widget was previously open (from sessionStorage)
   */
  private wasOpen(): boolean {
    try {
      return sessionStorage.getItem(openStateKey(this.config.widgetId)) === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Open the widget
   */
  public open(): void {
    this.ensureReady();
    console.log('[Weld SDK] Opening widget...');

    this.stateCoordinator.openWidget();
    this.iframeManager.showIframe(IframeType.WIDGET);

    // Send open message to the widget iframe
    const widgetIframe = this.iframeManager.getIframe(IframeType.WIDGET);
    if (widgetIframe?.element?.contentWindow) {
      widgetIframe.element.contentWindow.postMessage({ type: 'weld:open' }, '*');
    }

    // Notify launcher that widget is now open (so it can show X icon)
    const launcherIframe = this.iframeManager.getIframe(IframeType.LAUNCHER);
    if (launcherIframe?.element?.contentWindow) {
      launcherIframe.element.contentWindow.postMessage({ type: 'weld:widget-opened' }, '*');
    }

    this.persistOpenState(true);
    this.config.onOpen?.();
  }

  /**
   * Close the widget
   */
  public close(): void {
    this.ensureReady();
    console.log('[Weld SDK] Closing widget...');

    this.stateCoordinator.closeWidget();
    this.iframeManager.hideIframe(IframeType.WIDGET);

    // Send close message to the widget iframe
    const widgetIframe = this.iframeManager.getIframe(IframeType.WIDGET);
    if (widgetIframe?.element?.contentWindow) {
      widgetIframe.element.contentWindow.postMessage({ type: 'weld:close' }, '*');
    }

    // Notify launcher that widget is now closed (so it can show chat icon)
    const launcherIframe = this.iframeManager.getIframe(IframeType.LAUNCHER);
    if (launcherIframe?.element?.contentWindow) {
      launcherIframe.element.contentWindow.postMessage({ type: 'weld:widget-closed' }, '*');
    }

    this.persistOpenState(false);
    this.config.onClose?.();
  }

  /**
   * Toggle widget open/close
   */
  public toggle(): void {
    const state = this.stateCoordinator.getState();
    if (state.widget.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Minimize the widget
   */
  public minimize(): void {
    this.ensureReady();
    this.logger.debug('Minimizing widget');

    this.stateCoordinator.minimizeWidget();
    this.config.onMinimize?.();
  }

  /**
   * Maximize the widget
   */
  public maximize(): void {
    this.ensureReady();
    this.logger.debug('Maximizing widget');

    this.stateCoordinator.maximizeWidget();
    this.config.onMaximize?.();
  }

  /**
   * Show the launcher
   */
  public showLauncher(): void {
    this.ensureReady();
    this.logger.debug('Showing launcher');

    this.iframeManager.showIframe(IframeType.LAUNCHER);
    this.stateCoordinator.updateState('launcher.isVisible', true);
  }

  /**
   * Hide the launcher
   */
  public hideLauncher(): void {
    this.ensureReady();
    this.logger.debug('Hiding launcher');

    this.iframeManager.hideIframe(IframeType.LAUNCHER);
    this.stateCoordinator.updateState('launcher.isVisible', false);
  }

  /**
   * Set badge count
   */
  public setBadgeCount(count: number): void {
    this.ensureReady();
    this.logger.debug('Setting badge count', { count });

    this.stateCoordinator.setBadgeCount(count);
  }

  /**
   * Clear badge
   */
  public clearBadge(): void {
    this.setBadgeCount(0);
  }

  /**
   * Send a message
   */
  public sendMessage(text: string, metadata?: Record<string, any>): void {
    this.ensureReady();
    this.logger.debug('Sending message', { text });

    this.messageBroker.sendToIframe(IframeType.WIDGET, 'weld:message:send' as MessageType, {
      text,
      metadata,
      timestamp: Date.now(),
    });
  }

  /**
   * Identify user
   */
  public identify(identity: UserIdentity): void {
    this.ensureReady();
    this.logger.debug('Identifying user', { userId: identity.userId });

    this.stateCoordinator.setUserAuth(
      identity.userId,
      identity.email,
      identity.name
    );

    this.messageBroker.broadcast('weld:auth:login' as MessageType, identity);
  }

  /**
   * Logout user
   */
  public logout(): void {
    this.ensureReady();
    this.logger.debug('Logging out user');

    this.stateCoordinator.updateState('user', {
      isAuthenticated: false,
      isAnonymous: true,
    });

    this.messageBroker.broadcast('weld:auth:logout' as MessageType, {});
  }

  /**
   * Update configuration
   */
  public updateConfig(updates: Partial<WeldConfig>): void {
    this.ensureReady();
    this.logger.debug('Updating configuration');

    // Merge config
    this.config = resolveConfig({ ...this.config, ...updates });

    // Broadcast config update
    this.messageBroker.broadcast('weld:config:update' as MessageType, updates);
  }

  /**
   * Update theme
   */
  public setTheme(theme: 'light' | 'dark' | 'auto'): void {
    this.ensureReady();
    this.logger.debug('Setting theme', { theme });

    this.stateCoordinator.updateState('ui.theme', theme);
    this.messageBroker.broadcast('weld:theme:update' as MessageType, { mode: theme });
  }

  /**
   * Update locale
   */
  public setLocale(locale: string): void {
    this.ensureReady();
    this.logger.debug('Setting locale', { locale });

    this.stateCoordinator.updateState('ui.locale', locale);
    this.messageBroker.broadcast('weld:locale:update' as MessageType, { locale });
  }

  /**
   * Track custom event
   */
  public track(eventName: string, properties?: Record<string, any>): void {
    this.ensureReady();
    this.logger.debug('Tracking event', { eventName });

    this.messageBroker.broadcast('weld:event:track' as MessageType, {
      name: eventName,
      properties,
      timestamp: Date.now(),
    });
  }

  // ============================================================================
  // Intercom-style API Methods
  // ============================================================================

  /**
   * Boot the widget with user context (Intercom-style)
   * Use this after authentication to pass user information
   *
   * @example
   * ```typescript
   * weld.boot({
   *   userId: 'user_123',
   *   email: 'user@example.com',
   *   name: 'John Doe',
   *   createdAt: new Date('2024-01-01'),
   *   customAttributes: { plan: 'pro', company: 'Acme Inc' }
   * });
   * ```
   */
  public boot(settings: {
    userId?: string;
    email?: string;
    name?: string;
    avatar?: string;
    createdAt?: Date;
    customAttributes?: Record<string, any>;
  }): void {
    this.ensureReady();
    this.logger.info('Booting widget with user context', { userId: settings.userId });

    // Update user state
    if (settings.userId || settings.email) {
      this.stateCoordinator.setUserAuth(
        settings.userId || '',
        settings.email,
        settings.name
      );
    }

    // Broadcast to iframes
    this.messageBroker.broadcast('weld:auth:login' as MessageType, {
      userId: settings.userId,
      email: settings.email,
      name: settings.name,
      avatar: settings.avatar,
      metadata: {
        createdAt: settings.createdAt?.toISOString(),
        ...settings.customAttributes,
      },
    });
  }

  /**
   * Shutdown the widget and clear session (Intercom-style)
   * Use this on logout to clear user data and session cookies
   */
  public shutdown(): void {
    this.logger.info('Shutting down widget');

    // Clear user state
    this.stateCoordinator.updateState('user', {
      isAuthenticated: false,
      isAnonymous: true,
    });

    // Broadcast logout to iframes
    this.messageBroker.broadcast('weld:auth:logout' as MessageType, {});

    // Clear persisted widget state
    this.clearPersistedState();

    // Clear any stored session data
    try {
      const prefix = 'weld-';
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(prefix)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(key => localStorage.removeItem(key));
    } catch (e) {
      // localStorage might not be available
      this.logger.debug('Could not clear localStorage', e);
    }

    this.logger.info('Widget shutdown complete');
  }

  /**
   * Update user attributes (Intercom-style, with rate limiting)
   * Limited to 20 calls per page load to prevent abuse
   *
   * @example
   * ```typescript
   * weld.update({ lastOrderDate: new Date(), orderCount: 5 });
   * ```
   */
  private updateCallCount = 0;
  private readonly updateRateLimit = 20;

  public update(data: Record<string, any>): void {
    this.ensureReady();

    // Rate limiting check
    if (this.updateCallCount >= this.updateRateLimit) {
      this.logger.warn('Update rate limit exceeded (max 20 per page load)');
      return;
    }
    this.updateCallCount++;

    this.logger.debug('Updating user attributes', data);

    // Broadcast update to iframes
    this.messageBroker.broadcast('weld:state:update' as MessageType, {
      path: 'user.metadata',
      value: data,
      merge: true,
    });
  }

  /**
   * Register callback for when widget is shown (Intercom-style)
   * @returns Unsubscribe function
   */
  public onShow(callback: () => void): () => void {
    this.ensureReady();

    const subscriptionId = this.stateCoordinator.subscribe('widget.isOpen', (isOpen: boolean) => {
      if (isOpen) {
        callback();
      }
    });

    return () => {
      this.stateCoordinator.unsubscribe(subscriptionId);
    };
  }

  /**
   * Register callback for when widget is hidden (Intercom-style)
   * @returns Unsubscribe function
   */
  public onHide(callback: () => void): () => void {
    this.ensureReady();

    const subscriptionId = this.stateCoordinator.subscribe('widget.isOpen', (isOpen: boolean) => {
      if (!isOpen) {
        callback();
      }
    });

    return () => {
      this.stateCoordinator.unsubscribe(subscriptionId);
    };
  }

  /**
   * Register callback for unread message count changes (Intercom-style)
   * @returns Unsubscribe function
   */
  public onUnreadCountChange(callback: (count: number) => void): () => void {
    this.ensureReady();

    const subscriptionId = this.stateCoordinator.subscribe('launcher.badgeCount', (count: number) => {
      callback(count || 0);
    });

    return () => {
      this.stateCoordinator.unsubscribe(subscriptionId);
    };
  }

  /**
   * Show the widget (alias for open, Intercom-style)
   */
  public show(): void {
    this.open();
  }

  /**
   * Hide the widget (alias for close, Intercom-style)
   */
  public hide(): void {
    this.close();
  }

  // ============================================================================
  // End Intercom-style API Methods
  // ============================================================================

  /**
   * Get current state
   */
  public getState(): WeldState {
    return this.stateCoordinator.getState();
  }

  /**
   * Subscribe to state changes
   */
  public onStateChange<T = any>(
    path: string,
    listener: (newValue: T, oldValue: T) => void
  ): () => void {
    this.ensureReady();

    const subscriptionId = this.stateCoordinator.subscribe(path, listener);

    // Return unsubscribe function
    return () => {
      this.stateCoordinator.unsubscribe(subscriptionId);
    };
  }

  /**
   * Get device info
   */
  public getDeviceInfo() {
    return this.iframeManager.getDeviceInfo();
  }

  /**
   * Get SDK status
   */
  public getStatus(): string {
    return this.status;
  }

  /**
   * Get SDK version
   */
  public getVersion(): string {
    return packageJson.version;
  }

  /**
   * Enable debug mode
   */
  public enableDebug(): void {
    this.logger.setLevel('debug');
    this.logger.info('Debug mode enabled');
  }

  /**
   * Disable debug mode
   */
  public disableDebug(): void {
    this.logger.setLevel('warn');
    this.logger.info('Debug mode disabled');
  }

  /**
   * Send a page change message to the widget iframe
   */
  private sendPageChange(url: string, title: string): void {
    const widgetIframe = this.iframeManager.getIframe(IframeType.WIDGET);
    if (widgetIframe?.element?.contentWindow) {
      widgetIframe.element.contentWindow.postMessage({
        type: 'weld:page:change',
        url,
        title,
        timestamp: Date.now(),
      }, '*');
    }
  }

  /**
   * Start tracking page URL changes (SPA navigations + popstate)
   */
  private startPageTracking(): void {
    let lastUrl = window.location.href;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const notifyChange = () => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        this.sendPageChange(currentUrl, document.title);
      }
    };

    const debouncedNotify = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(notifyChange, 300);
    };

    // Send initial page
    this.sendPageChange(window.location.href, document.title);

    // Monkey-patch history.pushState and history.replaceState
    const origPushState = history.pushState.bind(history);
    const origReplaceState = history.replaceState.bind(history);

    history.pushState = function (...args) {
      origPushState(...args);
      debouncedNotify();
    };

    history.replaceState = function (...args) {
      origReplaceState(...args);
      debouncedNotify();
    };

    // Listen for popstate (browser back/forward)
    const handlePopstate = () => debouncedNotify();
    window.addEventListener('popstate', handlePopstate);

    // Store cleanup
    this.pageTrackingCleanup = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      window.removeEventListener('popstate', handlePopstate);
      history.pushState = origPushState;
      history.replaceState = origReplaceState;
    };
  }

  /**
   * Ensure SDK is ready before operation
   */
  private ensureReady(): void {
    if (this.status !== SDKStatus.READY) {
      throw new Error('SDK not ready. Call init() first.');
    }
  }

  /**
   * Detach from the current component lifecycle without destroying the widget.
   * Use this as a React useEffect cleanup — the widget stays alive across navigations.
   */
  public detach(): void {
    // No-op: widget stays alive in the singleton registry
    this.logger.debug('WeldSDK detached (no-op, widget stays alive)');
  }

  /**
   * Destroy SDK and cleanup
   */
  public destroy(): void {
    this.logger.info('Destroying WeldSDK');

    // Remove from singleton registry
    sdkRegistry.delete(this.config.widgetId);

    // Clear persisted state
    this.clearPersistedState();

    // Stop page tracking
    this.pageTrackingCleanup?.();
    this.pageTrackingCleanup = null;

    // Remove event listener using bound handler
    window.removeEventListener('message', this.boundHandleLauncherClick);

    // Unsubscribe from all message broker subscriptions
    for (const subId of this.subscriptionIds) {
      this.messageBroker.unsubscribe(subId);
    }
    this.subscriptionIds = [];

    // Destroy modules
    this.stateCoordinator.destroy();
    this.messageBroker.destroy();
    this.iframeManager.destroy();

    // Reset status
    this.status = SDKStatus.DESTROYED;

    // Call onDestroy callback
    this.config.onDestroy?.();

    this.logger.info('WeldSDK destroyed');
  }
}

/**
 * Create and initialize WeldSDK instance.
 * Uses singleton pattern — if an instance for the same widgetId already exists
 * and is not destroyed, updates callbacks and returns the existing instance.
 */
export async function createWeldSDK(config: WeldConfig): Promise<WeldSDK> {
  const widgetId = config.widgetId;

  // Check for existing, non-destroyed instance
  const existing = sdkRegistry.get(widgetId);
  if (existing && existing.getStatus() !== 'destroyed') {
    existing.updateCallbacks(config);
    return existing;
  }

  const sdk = new WeldSDK(config);
  sdkRegistry.set(widgetId, sdk);
  await sdk.init();
  return sdk;
}

/**
 * Explicitly destroy a WeldSDK instance by widgetId.
 * Use this for logout or when you need to fully remove the widget.
 */
export function destroyWeldSDK(widgetId: string): void {
  const sdk = sdkRegistry.get(widgetId);
  if (sdk) {
    sdk.destroy();
  }
}
