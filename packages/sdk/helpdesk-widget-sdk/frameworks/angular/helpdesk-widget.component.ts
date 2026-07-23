import { Component, Input, OnInit, OnDestroy } from '@angular/core';
import { WeldSDK, type WeldConfig, type WidgetEventHandler } from '../../src/index';

/**
 * Angular component for the Helpdesk Widget
 *
 * This component provides a declarative way to add the widget to your app.
 * The widget loads in an iframe and doesn't render any visible children.
 *
 * @example
 * ```typescript
 * // app.component.ts
 * import { Component } from '@angular/core';
 *
 * @Component({
 *   selector: 'app-root',
 *   template: `
 *     <h1>My App</h1>
 *     <helpdesk-widget [widgetId]="'your-widget-id'"></helpdesk-widget>
 *   `
 * })
 * export class AppComponent {}
 * ```
 *
 * @example With event handlers
 * ```typescript
 * @Component({
 *   selector: 'app-root',
 *   template: `
 *     <helpdesk-widget
 *       [widgetId]="'your-widget-id'"
 *       [onReady]="handleReady"
 *       [onOpen]="handleOpened">
 *     </helpdesk-widget>
 *   `
 * })
 * export class AppComponent {
 *   handleReady = () => {
 *     console.log('Widget ready');
 *   }
 *
 *   handleOpened = () => {
 *     console.log('Widget opened');
 *   }
 * }
 * ```
 */
@Component({
  selector: 'helpdesk-widget',
  template: '',
  standalone: true,
})
export class HelpdeskWidgetComponent implements OnInit, OnDestroy {
  @Input() widgetId!: string;
  @Input() onReady?: WidgetEventHandler;
  @Input() onOpen?: WidgetEventHandler;
  @Input() onClose?: WidgetEventHandler;
  @Input() onError?: WidgetEventHandler;

  private widget: WeldSDK | null = null;

  ngOnInit(): void {
    if (!this.widgetId) {
      throw new Error('widgetId is required for HelpdeskWidgetComponent');
    }

    const config: WeldConfig = {
      widgetId: this.widgetId,
      onReady: this.onReady,
      onOpen: this.onOpen,
      onClose: this.onClose,
      onError: this.onError as ((error: Error) => void) | undefined,
    };

    try {
      this.widget = new WeldSDK(config);
      this.widget.init();
    } catch (error) {
      console.error('Failed to initialize Helpdesk Widget:', error);
    }
  }

  ngOnDestroy(): void {
    if (this.widget) {
      this.widget.destroy();
      this.widget = null;
    }
  }

  /**
   * Open the widget programmatically
   */
  open(): void {
    this.widget?.open();
  }

  /**
   * Close the widget programmatically
   */
  close(): void {
    this.widget?.close();
  }

  /**
   * Toggle widget visibility programmatically
   */
  toggle(): void {
    this.widget?.toggle();
  }

  /**
   * Send a message to the widget
   */
  sendMessage(message: string): void {
    this.widget?.sendMessage(message);
  }
}
