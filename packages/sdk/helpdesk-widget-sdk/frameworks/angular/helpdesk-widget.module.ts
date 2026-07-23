import { NgModule } from '@angular/core';
import { HelpdeskWidgetComponent } from './helpdesk-widget.component';
import { HelpdeskWidgetService } from './helpdesk-widget.service';

/**
 * Angular module for the Helpdesk Widget
 *
 * This module is for backwards compatibility with Angular apps not using standalone components.
 * For modern Angular apps (v14+), prefer importing the standalone component directly.
 *
 * @example
 * ```typescript
 * // app.module.ts
 * import { HelpdeskWidgetModule } from '@weldsuite/helpdesk-widget-sdk/angular';
 *
 * @NgModule({
 *   declarations: [AppComponent],
 *   imports: [
 *     BrowserModule,
 *     HelpdeskWidgetModule
 *   ],
 *   providers: [],
 *   bootstrap: [AppComponent]
 * })
 * export class AppModule { }
 * ```
 *
 * @example For standalone components (Angular 14+), import directly:
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
 */
@NgModule({
  imports: [HelpdeskWidgetComponent],
  exports: [HelpdeskWidgetComponent],
  providers: [HelpdeskWidgetService],
})
export class HelpdeskWidgetModule {}
