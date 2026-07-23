/**
 * Angular integration for Helpdesk Widget SDK
 *
 * @example Using the service
 * ```typescript
 * import { Component } from '@angular/core';
 * import { HelpdeskWidgetService } from '@weldsuite/helpdesk-widget-sdk/angular';
 *
 * @Component({
 *   selector: 'app-root',
 *   template: `<button (click)="openSupport()">Show Support</button>`
 * })
 * export class AppComponent {
 *   constructor(private helpdeskService: HelpdeskWidgetService) {
 *     this.helpdeskService.initialize({ widgetId: 'your-widget-id' });
 *   }
 *
 *   openSupport() {
 *     this.helpdeskService.open();
 *   }
 * }
 * ```
 *
 * @example Using the standalone component (Angular 14+)
 * ```typescript
 * import { HelpdeskWidgetComponent } from '@weldsuite/helpdesk-widget-sdk/angular';
 *
 * @Component({
 *   selector: 'app-root',
 *   standalone: true,
 *   imports: [HelpdeskWidgetComponent],
 *   template: `<helpdesk-widget [widgetId]="'your-widget-id'"></helpdesk-widget>`
 * })
 * export class AppComponent {}
 * ```
 *
 * @example Using the module (pre-Angular 14)
 * ```typescript
 * import { HelpdeskWidgetModule } from '@weldsuite/helpdesk-widget-sdk/angular';
 *
 * @NgModule({
 *   imports: [HelpdeskWidgetModule],
 *   // ...
 * })
 * export class AppModule {}
 * ```
 */

export { HelpdeskWidgetComponent } from './helpdesk-widget.component';
export { HelpdeskWidgetService } from './helpdesk-widget.service';
export { HelpdeskWidgetModule } from './helpdesk-widget.module';

// Re-export core types and configs for convenience
export type {
  WeldConfig,
  HelpdeskWidgetConfig,
  WidgetEventType,
  WidgetEvent,
  WidgetEventHandler,
} from '../../src/index';

export {
  DEFAULT_CONFIG,
  WeldSDK,
  HelpdeskWidget,
} from '../../src/index';
