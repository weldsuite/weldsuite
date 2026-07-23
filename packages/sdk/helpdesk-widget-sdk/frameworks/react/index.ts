/**
 * React integration for Helpdesk Widget SDK
 *
 * @example
 * ```tsx
 * // Using the component
 * import { HelpdeskWidgetReact } from '@weldsuite/helpdesk-widget-sdk/react';
 *
 * function App() {
 *   return <HelpdeskWidgetReact widgetId="your-widget-id" />;
 * }
 * ```
 *
 * @example
 * ```tsx
 * // Using the hook
 * import { useHelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/react';
 *
 * function App() {
 *   const widget = useHelpdeskWidget({ widgetId: 'your-widget-id' });
 *
 *   return <button onClick={() => widget?.open()}>Show Support</button>;
 * }
 * ```
 */

export { HelpdeskWidgetReact, HelpdeskWidgetReact as default } from './HelpdeskWidgetReact';
export {
  useHelpdeskWidget,
  useHelpdeskWidgetControls,
  useHelpdeskWidgetLegacy,
  type UseHelpdeskWidgetResult,
} from './useHelpdeskWidget';

// Re-export core types and configs for convenience
export type {
  WeldConfig,
  HelpdeskWidgetConfig,
  WidgetEventType,
  WidgetEvent,
  WidgetEventHandler,
} from '../../src/index';

export { DEFAULT_CONFIG, WeldSDK, HelpdeskWidget } from '../../src/index';
