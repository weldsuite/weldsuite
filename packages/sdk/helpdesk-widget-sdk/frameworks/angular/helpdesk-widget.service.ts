import { Injectable, OnDestroy } from '@angular/core';
import { WeldSDK, type WeldConfig } from '../../src/index';

/**
 * Angular service for managing the Helpdesk Widget
 *
 * @example
 * ```typescript
 * import { Component } from '@angular/core';
 * import { HelpdeskWidgetService } from '@weldsuite/helpdesk-widget-sdk/angular';
 *
 * @Component({
 *   selector: 'app-root',
 *   template: `
 *     <button (click)="openWidget()">Show Support</button>
 *   `
 * })
 * export class AppComponent {
 *   constructor(private helpdeskService: HelpdeskWidgetService) {
 *     this.helpdeskService.initialize({ widgetId: 'your-widget-id' });
 *   }
 *
 *   openWidget() {
 *     this.helpdeskService.open();
 *   }
 * }
 * ```
 */
@Injectable({
  providedIn: 'root',
})
export class HelpdeskWidgetService implements OnDestroy {
  private widget: WeldSDK | null = null;

  /**
   * Initialize the widget with configuration
   */
  initialize(config: WeldConfig): void {
    if (this.widget) {
      console.warn('Helpdesk widget is already initialized. Destroying previous instance.');
      this.destroy();
    }

    try {
      this.widget = new WeldSDK(config);
      this.widget.init();
    } catch (error) {
      console.error('Failed to initialize Helpdesk Widget:', error);
      throw error;
    }
  }

  /**
   * Open the widget
   */
  open(): void {
    if (!this.widget) {
      console.warn('Widget not initialized. Call initialize() first.');
      return;
    }
    this.widget.open();
  }

  /**
   * Close the widget
   */
  close(): void {
    if (!this.widget) {
      console.warn('Widget not initialized. Call initialize() first.');
      return;
    }
    this.widget.close();
  }

  /**
   * Toggle widget visibility
   */
  toggle(): void {
    if (!this.widget) {
      console.warn('Widget not initialized. Call initialize() first.');
      return;
    }
    this.widget.toggle();
  }

  /**
   * Send a message to the widget
   */
  sendMessage(message: string): void {
    if (!this.widget) {
      console.warn('Widget not initialized. Call initialize() first.');
      return;
    }
    this.widget.sendMessage(message);
  }

  /**
   * Subscribe to state changes
   * @returns Unsubscribe function
   */
  onStateChange<T = any>(path: string, listener: (newValue: T, oldValue: T) => void): () => void {
    if (!this.widget) {
      console.warn('Widget not initialized. Call initialize() first.');
      return () => {};
    }
    return this.widget.onStateChange(path, listener);
  }

  /**
   * Destroy the widget and clean up resources
   */
  destroy(): void {
    if (this.widget) {
      this.widget.destroy();
      this.widget = null;
    }
  }

  /**
   * Get the widget instance
   */
  getWidget(): WeldSDK | null {
    return this.widget;
  }

  /**
   * Check if SDK is ready
   */
  isReady(): boolean {
    return this.widget?.isReady() ?? false;
  }

  ngOnDestroy(): void {
    this.destroy();
  }
}
