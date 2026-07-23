import React from 'react';
import { useHelpdeskWidget } from './useHelpdeskWidget';
import type { WeldConfig } from '../../src/index';

export interface HelpdeskWidgetReactProps extends WeldConfig {
  /**
   * Children are not rendered (widget loads in iframe)
   * This component exists for declarative usage
   */
  children?: never;
}

/**
 * React component for the Helpdesk Widget
 *
 * This component provides a declarative way to add the widget to your app.
 * The widget loads in an iframe and doesn't render any visible children.
 *
 * @example
 * ```tsx
 * import { HelpdeskWidgetReact } from '@weldsuite/helpdesk-widget-sdk/react';
 *
 * function App() {
 *   return (
 *     <div>
 *       <h1>My App</h1>
 *       <HelpdeskWidgetReact widgetId="your-widget-id" />
 *     </div>
 *   );
 * }
 * ```
 *
 * @example With event handlers
 * ```tsx
 * <HelpdeskWidgetReact
 *   widgetId="your-widget-id"
 *   onReady={() => console.log('Widget ready')}
 *   onOpen={() => console.log('Widget opened')}
 * />
 * ```
 */
export const HelpdeskWidgetReact: React.FC<HelpdeskWidgetReactProps> = (
  config
) => {
  useHelpdeskWidget(config);

  // Widget loads in iframe, no visible component needed
  return null;
};

HelpdeskWidgetReact.displayName = 'HelpdeskWidget';

export default HelpdeskWidgetReact;
