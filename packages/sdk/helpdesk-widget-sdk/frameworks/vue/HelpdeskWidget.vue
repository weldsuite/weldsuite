<script setup lang="ts">
import { useHelpdeskWidget } from './useHelpdeskWidget';
import type { HelpdeskWidgetConfig } from '../../src/index';

/**
 * Vue 3 component for the Helpdesk Widget
 *
 * This component provides a declarative way to add the widget to your app.
 * The widget loads in an iframe and doesn't render any visible children.
 *
 * @example
 * ```vue
 * <script setup>
 * import { HelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/vue';
 * </script>
 *
 * <template>
 *   <div>
 *     <h1>My App</h1>
 *     <HelpdeskWidget widget-id="your-widget-id" />
 *   </div>
 * </template>
 * ```
 *
 * @example With event handlers
 * ```vue
 * <HelpdeskWidget
 *   widget-id="your-widget-id"
 *   :on-ready="(event) => console.log('Ready', event)"
 *   :on-opened="(event) => console.log('Opened', event)"
 * />
 * ```
 */

interface Props extends HelpdeskWidgetConfig {
  widgetId: string;
}

const props = defineProps<Props>();

useHelpdeskWidget(props);
</script>

<template>
  <!-- Widget loads in iframe, no visible component needed -->
</template>
