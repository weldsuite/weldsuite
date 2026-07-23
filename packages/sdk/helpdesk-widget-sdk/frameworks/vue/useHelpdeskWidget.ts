import { onMounted, onUnmounted, ref } from 'vue';
import { WeldSDK, type WeldConfig } from '../../src/index';

/**
 * Vue 3 composable for the Helpdesk Widget
 *
 * @example
 * ```vue
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
export function useHelpdeskWidget(config: WeldConfig) {
  const widget = ref<WeldSDK | null>(null);

  onMounted(() => {
    try {
      widget.value = new WeldSDK(config);
      widget.value.init();
    } catch (error) {
      console.error('Failed to initialize Helpdesk Widget:', error);
    }
  });

  onUnmounted(() => {
    if (widget.value) {
      widget.value.destroy();
      widget.value = null;
    }
  });

  return widget;
}

/**
 * Composable that provides widget control methods
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { useHelpdeskWidgetControls } from '@weldsuite/helpdesk-widget-sdk/vue';
 *
 * const { open, close, toggle } = useHelpdeskWidgetControls({
 *   widgetId: 'your-widget-id'
 * });
 * </script>
 *
 * <template>
 *   <div>
 *     <button @click="open">Show Support</button>
 *     <button @click="close">Hide Support</button>
 *     <button @click="toggle">Toggle Support</button>
 *   </div>
 * </template>
 * ```
 */
export function useHelpdeskWidgetControls(config: WeldConfig) {
  const widget = useHelpdeskWidget(config);

  const open = () => {
    widget.value?.open();
  };

  const close = () => {
    widget.value?.close();
  };

  const toggle = () => {
    widget.value?.toggle();
  };

  const sendMessage = (message: string) => {
    widget.value?.sendMessage(message);
  };

  return {
    widget,
    open,
    close,
    toggle,
    sendMessage,
  };
}
