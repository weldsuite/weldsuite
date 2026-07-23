/**
 * Notification Router
 * Maps notification types to screen routes for deep linking
 */

import type { Router } from 'expo-router';
import type { StoredNotification } from './storage';

/**
 * Route configuration for notification types
 */
const NOTIFICATION_ROUTES: Record<string, (notification: StoredNotification) => string | null> = {
  // Commerce notifications
  'order.created': (n) => n.entityId ? `/orders/${n.entityId}` : '/orders',
  'order.shipped': (n) => n.entityId ? `/orders/${n.entityId}` : '/orders',
  'order.delivered': (n) => n.entityId ? `/orders/${n.entityId}` : '/orders',
  'order.cancelled': (n) => n.entityId ? `/orders/${n.entityId}` : '/orders',
  'order.payment_failed': (n) => n.entityId ? `/orders/${n.entityId}` : '/orders',

  // Accounting notifications
  'invoice.created': (n) => n.entityId ? `/accounting/invoices/${n.entityId}` : '/accounting',
  'invoice.paid': (n) => n.entityId ? `/accounting/invoices/${n.entityId}` : '/accounting',
  'invoice.overdue': (n) => n.entityId ? `/accounting/invoices/${n.entityId}` : '/accounting',
  'invoice.payment_failed': (n) => n.entityId ? `/accounting/invoices/${n.entityId}` : '/accounting',

  // Project notifications
  'task.assigned': (n) => n.entityId ? `/projects/tasks/${n.entityId}` : '/projects',
  'task.completed': (n) => n.entityId ? `/projects/tasks/${n.entityId}` : '/projects',
  'task.due_soon': (n) => n.entityId ? `/projects/tasks/${n.entityId}` : '/projects',
  'task.overdue': (n) => n.entityId ? `/projects/tasks/${n.entityId}` : '/projects',
  'task.comment': (n) => n.entityId ? `/projects/tasks/${n.entityId}` : '/projects',
  'task.mention': (n) => n.entityId ? `/projects/tasks/${n.entityId}` : '/projects',
  'project.milestone': (n) => n.entityId ? `/projects/${n.entityId}` : '/projects',

  // Communication notifications
  'email.received': (n) => n.entityId ? `/mail/${n.entityId}` : '/mail',
  'new_email': (n) => n.entityId ? `/mail/${n.entityId}` : '/mail',
  'meeting.starting_soon': (n) => n.entityId ? `/calendar/${n.entityId}` : '/calendar',
  'meeting.invitation': (n) => n.entityId ? `/calendar/${n.entityId}` : '/calendar',
  'call.missed': (n) => '/calls',

  // System notifications
  'system.announcement': () => '/notifications',
  'system.maintenance': () => '/notifications',
  'system.new_feature': () => '/notifications',
  'workspace.invite': () => '/settings',
  'workspace.role_changed': () => '/settings',
  'security.alert': () => '/settings/security',

  // Helpdesk notifications
  'ticket.created': (n) => n.entityId ? `/helpdesk/tickets/${n.entityId}` : '/helpdesk',
  'ticket.assigned': (n) => n.entityId ? `/helpdesk/tickets/${n.entityId}` : '/helpdesk',
  'ticket.updated': (n) => n.entityId ? `/helpdesk/tickets/${n.entityId}` : '/helpdesk',
  'ticket.resolved': (n) => n.entityId ? `/helpdesk/tickets/${n.entityId}` : '/helpdesk',

  // WMS notifications
  'shipment.created': (n) => n.entityId ? `/wms/shipments/${n.entityId}` : '/wms/shipments',
  'shipment.shipped': (n) => n.entityId ? `/wms/shipments/${n.entityId}` : '/wms/shipments',
  'inventory.low_stock': (n) => n.entityId ? `/wms/products/${n.entityId}` : '/wms/inventory',
  'inventory.out_of_stock': (n) => n.entityId ? `/wms/products/${n.entityId}` : '/wms/inventory',
};

/**
 * Get the route for a notification
 */
export function getNotificationRoute(notification: StoredNotification): string | null {
  // First check for actionUrl
  if (notification.actionUrl) {
    return notification.actionUrl;
  }

  // Then check for specific notification type route
  const routeGetter = NOTIFICATION_ROUTES[notification.notificationType];
  if (routeGetter) {
    return routeGetter(notification);
  }

  // Fallback: route based on entity type
  if (notification.entityType && notification.entityId) {
    return getRouteFromEntityType(notification.entityType, notification.entityId);
  }

  // Default to notifications list
  return '/notifications';
}

/**
 * Get route from entity type
 */
function getRouteFromEntityType(entityType: string, entityId: string): string | null {
  const entityRoutes: Record<string, string> = {
    Order: `/orders/${entityId}`,
    Invoice: `/accounting/invoices/${entityId}`,
    Project: `/projects/${entityId}`,
    ProjectTask: `/projects/tasks/${entityId}`,
    Task: `/projects/tasks/${entityId}`,
    EmailMessage: `/mail/${entityId}`,
    Meeting: `/calendar/${entityId}`,
    Ticket: `/helpdesk/tickets/${entityId}`,
    Shipment: `/wms/shipments/${entityId}`,
    Product: `/wms/products/${entityId}`,
    Contact: `/crm/contacts/${entityId}`,
    Lead: `/crm/leads/${entityId}`,
    Opportunity: `/crm/opportunities/${entityId}`,
  };

  return entityRoutes[entityType] || null;
}

/**
 * Navigate to a notification's target screen
 */
export function navigateToNotification(
  router: Router,
  notification: StoredNotification,
  onNavigate?: (notification: StoredNotification) => void
): void {
  const route = getNotificationRoute(notification);

  if (route) {
    onNavigate?.(notification);
    router.push(route as any);
  }
}

/**
 * Get icon name for notification category
 */
export function getNotificationIcon(category: string): string {
  const icons: Record<string, string> = {
    commerce: 'shopping-cart',
    accounting: 'file-text',
    projects: 'check-square',
    communication: 'mail',
    security: 'shield',
    system: 'info',
    helpdesk: 'headphones',
    wms: 'package',
    crm: 'users',
  };

  return icons[category] || 'bell';
}

/**
 * Get color for notification category
 */
export function getNotificationColor(category: string): string {
  const colors: Record<string, string> = {
    commerce: '#3b82f6', // blue
    accounting: '#22c55e', // green
    projects: '#8b5cf6', // purple
    communication: '#06b6d4', // cyan
    security: '#ef4444', // red
    system: '#f59e0b', // amber
    helpdesk: '#ec4899', // pink
    wms: '#f97316', // orange
    crm: '#14b8a6', // teal
  };

  return colors[category] || '#6b7280'; // gray
}

/**
 * Parse push notification data and create a StoredNotification
 */
export function parsePushNotificationData(data: Record<string, any>): Partial<StoredNotification> {
  return {
    id: data.notificationId || data.id,
    notificationType: data.notificationType || data.type,
    category: data.category || 'system',
    title: data.title || '',
    body: data.body || data.message || '',
    entityType: data.entityType,
    entityId: data.entityId,
    actionUrl: data.actionUrl,
    isRead: false,
    createdAt: data.createdAt || new Date().toISOString(),
  };
}
