/**
 * Vue 3 integration for Helpdesk Widget SDK
 *
 * @example
 * ```vue
 * // Using the component
 * <script setup>
 * import { HelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/vue';
 * </script>
 *
 * <template>
 *   <HelpdeskWidget widget-id="your-widget-id" />
 * </template>
 * ```
 *
 * @example
 * ```vue
 * // Using the composable
 * <script setup lang="ts">
 * import { useHelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/vue';
 *
 * const widget = useHelpdeskWidget({ widgetId: 'your-widget-id' });
 * </script>
 *
 * <template>
 *   <button @click="widget?.open()">Show Support</button>
 * </template>
 * ```
 */

export { default as HelpdeskWidget } from './HelpdeskWidget.vue';
export { useHelpdeskWidget, useHelpdeskWidgetControls } from './useHelpdeskWidget';

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
