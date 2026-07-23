/**
 * Svelte integration for Helpdesk Widget SDK
 *
 * @example
 * ```svelte
 * <script>
 *   import { HelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/svelte';
 * </script>
 *
 * <h1>My App</h1>
 * <HelpdeskWidget widgetId="your-widget-id" />
 * ```
 *
 * @example With programmatic control
 * ```svelte
 * <script>
 *   import { HelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/svelte';
 *
 *   let widgetComponent;
 *
 *   const openSupport = () => {
 *     widgetComponent?.open();
 *   };
 * </script>
 *
 * <button on:click={openSupport}>Show Support</button>
 * <HelpdeskWidget bind:this={widgetComponent} widgetId="your-widget-id" />
 * ```
 */

export { default as HelpdeskWidget } from './HelpdeskWidget.svelte';

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
  HelpdeskWidget as HelpdeskWidgetClass,
} from '../../src/index';
