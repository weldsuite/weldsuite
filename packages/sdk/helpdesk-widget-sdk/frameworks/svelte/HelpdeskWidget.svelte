<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { HelpdeskWidget, type HelpdeskWidgetConfig, type WidgetEventHandler } from '../../src/index';

  /**
   * Svelte component for the Helpdesk Widget
   *
   * This component provides a declarative way to add the widget to your app.
   * The widget loads in an iframe and doesn't render any visible children.
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
   * @example With event handlers
   * ```svelte
   * <script>
   *   import { HelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/svelte';
   *
   *   const handleReady = (event) => {
   *     console.log('Widget ready', event);
   *   };
   * </script>
   *
   * <HelpdeskWidget
   *   widgetId="your-widget-id"
   *   onReady={handleReady}
   * />
   * ```
   */

  export let widgetId: string;
  export let baseUrl: string | undefined = undefined;
  export let onReady: WidgetEventHandler | undefined = undefined;
  export let onOpened: WidgetEventHandler | undefined = undefined;
  export let onClosed: WidgetEventHandler | undefined = undefined;
  export let onError: WidgetEventHandler | undefined = undefined;

  let widget: HelpdeskWidget | null = null;

  onMount(() => {
    const config: HelpdeskWidgetConfig = {
      widgetId,
      baseUrl,
      onReady,
      onOpened,
      onClosed,
      onError,
    };

    try {
      widget = new HelpdeskWidget(config);
      widget.init();
    } catch (error) {
      console.error('Failed to initialize Helpdesk Widget:', error);
    }
  });

  onDestroy(() => {
    if (widget) {
      widget.destroy();
      widget = null;
    }
  });

  /**
   * Show the widget programmatically
   */
  export function show() {
    widget?.show();
  }

  /**
   * Hide the widget programmatically
   */
  export function hide() {
    widget?.hide();
  }

  /**
   * Toggle widget visibility programmatically
   */
  export function toggle() {
    widget?.toggle();
  }

  /**
   * Send a message to the widget
   */
  export function sendMessage(message: any) {
    widget?.sendMessage(message);
  }
</script>

<!-- Widget loads in iframe, no visible component needed -->
