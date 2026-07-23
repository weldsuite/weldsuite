/**
 * Event types for the Helpdesk Widget SDK
 * Provides type-safe event handling
 */

/**
 * Widget event types sent from the iframe
 */
export type WidgetEventType =
  | 'widget:ready'
  | 'widget:close'
  | 'widget:opened'
  | 'widget:closed'
  | 'widget:error';

/**
 * Base widget event structure
 */
export interface WidgetEvent<T = any> {
  type: WidgetEventType | string;
  data?: T;
  timestamp?: number;
}

/**
 * Widget ready event
 * Fired when the widget iframe has loaded and is ready for interaction
 */
export interface WidgetReadyEvent extends WidgetEvent {
  type: 'widget:ready';
}

/**
 * Widget close event
 * Fired when the user requests to close the widget
 */
export interface WidgetCloseEvent extends WidgetEvent {
  type: 'widget:close';
}

/**
 * Widget opened event
 * Fired when the widget panel is opened
 */
export interface WidgetOpenedEvent extends WidgetEvent {
  type: 'widget:opened';
}

/**
 * Widget closed event
 * Fired when the widget panel is closed
 */
export interface WidgetClosedEvent extends WidgetEvent {
  type: 'widget:closed';
}

/**
 * Widget error event
 * Fired when an error occurs in the widget
 */
export interface WidgetErrorEvent extends WidgetEvent<{ message: string; code?: string }> {
  type: 'widget:error';
  data: {
    message: string;
    code?: string;
  };
}

/**
 * Union of all widget events
 */
export type AnyWidgetEvent =
  | WidgetReadyEvent
  | WidgetCloseEvent
  | WidgetOpenedEvent
  | WidgetClosedEvent
  | WidgetErrorEvent
  | WidgetEvent;

/**
 * Event handler callback type
 */
export type WidgetEventHandler<T extends WidgetEvent = AnyWidgetEvent> = (
  event: T
) => void;

/**
 * Event listener options
 */
export interface WidgetEventListenerOptions {
  /**
   * Event type to listen for
   */
  type: WidgetEventType | string;

  /**
   * Callback function
   */
  handler: WidgetEventHandler;

  /**
   * Listen only once
   */
  once?: boolean;
}
