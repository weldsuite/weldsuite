/**
 * WMS Utility Functions and Helpers
 * Provides status colors, priority icons, formatting, and other utilities for WMS
 */

import type {
  OrderStatus,
  OrderPriority,
  FulfillmentStatus,
  PickListStatus,
  ShipmentStatus,
  PurchaseOrderStatus,
  ReturnStatus,
  CycleCountStatus,
  InventoryStatus,
  LocationStatus,
  PackingStatus,
  PutawayStatus,
} from '../types/wms';

// ============================================================================
// STATUS BADGE COLORS
// ============================================================================

export function getOrderStatusColor(status: OrderStatus): string {
  switch (status) {
    case 'pending':
      return '#FFA500'; // Orange
    case 'processing':
      return '#2196F3'; // Blue
    case 'picking':
      return '#9C27B0'; // Purple
    case 'shipped':
      return '#00BCD4'; // Cyan
    case 'delivered':
      return '#4CAF50'; // Green
    case 'cancelled':
      return '#F44336'; // Red
    default:
      return '#757575'; // Gray
  }
}

export function getFulfillmentStatusColor(status: FulfillmentStatus): string {
  switch (status) {
    case 'unfulfilled':
      return '#F44336'; // Red
    case 'allocated':
      return '#FFC107'; // Amber
    case 'picking':
      return '#9C27B0'; // Purple
    case 'picking-complete':
      return '#673AB7'; // Deep Purple
    case 'packed':
      return '#3F51B5'; // Indigo
    case 'shipped':
      return '#00BCD4'; // Cyan
    case 'fulfilled':
      return '#4CAF50'; // Green
    case 'cancelled':
      return '#757575'; // Gray
    default:
      return '#757575';
  }
}

export function getPickListStatusColor(status: PickListStatus): string {
  switch (status) {
    case 'pending':
      return '#FFA500'; // Orange
    case 'assigned':
      return '#2196F3'; // Blue
    case 'in_progress':
      return '#9C27B0'; // Purple
    case 'paused':
      return '#FF9800'; // Deep Orange
    case 'completed':
      return '#4CAF50'; // Green
    case 'cancelled':
      return '#757575'; // Gray
    default:
      return '#757575';
  }
}

export function getShipmentStatusColor(status: ShipmentStatus): string {
  switch (status) {
    case 'pending':
      return '#FFA500'; // Orange
    case 'label_generated':
      return '#2196F3'; // Blue
    case 'picked_up':
      return '#9C27B0'; // Purple
    case 'in_transit':
      return '#00BCD4'; // Cyan
    case 'delivered':
      return '#4CAF50'; // Green
    case 'cancelled':
      return '#F44336'; // Red
    default:
      return '#757575';
  }
}

export function getPurchaseOrderStatusColor(status: PurchaseOrderStatus): string {
  switch (status) {
    case 'draft':
      return '#9E9E9E'; // Gray
    case 'pending':
      return '#FFA500'; // Orange
    case 'approved':
      return '#2196F3'; // Blue
    case 'ordered':
      return '#9C27B0'; // Purple
    case 'partially_received':
      return '#FF9800'; // Deep Orange
    case 'received':
      return '#4CAF50'; // Green
    case 'cancelled':
      return '#F44336'; // Red
    default:
      return '#757575';
  }
}

export function getReturnStatusColor(status: ReturnStatus): string {
  switch (status) {
    case 'requested':
      return '#FFA500'; // Orange
    case 'approved':
      return '#2196F3'; // Blue
    case 'received':
      return '#9C27B0'; // Purple
    case 'processed':
      return '#00BCD4'; // Cyan
    case 'shipped':
      return '#673AB7'; // Deep Purple
    case 'completed':
      return '#4CAF50'; // Green
    case 'cancelled':
      return '#F44336'; // Red
    default:
      return '#757575';
  }
}

export function getCycleCountStatusColor(status: CycleCountStatus): string {
  switch (status) {
    case 'pending':
      return '#FFA500'; // Orange
    case 'in_progress':
      return '#2196F3'; // Blue
    case 'completed':
      return '#4CAF50'; // Green
    default:
      return '#757575';
  }
}

export function getInventoryStatusColor(status: InventoryStatus): string {
  switch (status) {
    case 'active':
      return '#4CAF50'; // Green
    case 'inactive':
      return '#757575'; // Gray
    default:
      return '#757575';
  }
}

export function getLocationStatusColor(status: LocationStatus): string {
  switch (status) {
    case 'available':
      return '#4CAF50'; // Green
    case 'occupied':
      return '#2196F3'; // Blue
    case 'reserved':
      return '#FFC107'; // Amber
    case 'blocked':
      return '#F44336'; // Red
    default:
      return '#757575';
  }
}

export function getPriorityColor(priority: OrderPriority): string {
  switch (priority) {
    case 'normal':
      return '#4CAF50'; // Green
    case 'high':
      return '#FFA500'; // Orange
    case 'urgent':
      return '#F44336'; // Red
    default:
      return '#757575';
  }
}

// ============================================================================
// STATUS LABELS
// ============================================================================

export function getOrderStatusLabel(status: OrderStatus): string {
  const labels: Record<OrderStatus, string> = {
    pending: 'Pending',
    processing: 'Processing',
    picking: 'Picking',
    shipped: 'Shipped',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
  };
  return labels[status] || status;
}

export function getFulfillmentStatusLabel(status: FulfillmentStatus): string {
  const labels: Record<FulfillmentStatus, string> = {
    unfulfilled: 'Unfulfilled',
    allocated: 'Allocated',
    picking: 'Picking',
    'picking-complete': 'Picking Complete',
    packed: 'Packed',
    shipped: 'Shipped',
    fulfilled: 'Fulfilled',
    cancelled: 'Cancelled',
  };
  return labels[status] || status;
}

export function getPickListStatusLabel(status: PickListStatus): string {
  const labels: Record<PickListStatus, string> = {
    pending: 'Pending',
    assigned: 'Assigned',
    in_progress: 'In Progress',
    paused: 'Paused',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };
  return labels[status] || status;
}

export function getPriorityLabel(priority: OrderPriority): string {
  const labels: Record<OrderPriority, string> = {
    normal: 'Normal',
    high: 'High',
    urgent: 'Urgent',
  };
  return labels[priority] || priority;
}

// ============================================================================
// STOCK LEVEL CALCULATIONS
// ============================================================================

export interface StockStatus {
  status: 'in_stock' | 'low_stock' | 'out_of_stock';
  label: string;
  color: string;
  percentage: number;
}

export function calculateStockStatus(
  quantityAvailable: number,
  reorderPoint?: number,
  maxStockLevel?: number
): StockStatus {
  if (quantityAvailable === 0) {
    return {
      status: 'out_of_stock',
      label: 'Out of Stock',
      color: '#F44336', // Red
      percentage: 0,
    };
  }

  if (reorderPoint && quantityAvailable <= reorderPoint) {
    return {
      status: 'low_stock',
      label: 'Low Stock',
      color: '#FFA500', // Orange
      percentage: maxStockLevel ? (quantityAvailable / maxStockLevel) * 100 : 0,
    };
  }

  return {
    status: 'in_stock',
    label: 'In Stock',
    color: '#4CAF50', // Green
    percentage: maxStockLevel ? (quantityAvailable / maxStockLevel) * 100 : 100,
  };
}

// ============================================================================
// CURRENCY FORMATTING
// ============================================================================

export function formatMoney(amount: number, currency: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatMoneyCompact(amount: number, currency: string = 'USD'): string {
  if (amount >= 1000000) {
    return `${currency} ${(amount / 1000000).toFixed(1)}M`;
  } else if (amount >= 1000) {
    return `${currency} ${(amount / 1000).toFixed(1)}K`;
  }
  return formatMoney(amount, currency);
}

// ============================================================================
// NUMBER FORMATTING
// ============================================================================

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatPercentage(value: number, decimals: number = 1): string {
  return `${value.toFixed(decimals)}%`;
}

export function formatWeight(weight: number, unit: string = 'kg'): string {
  return `${formatNumber(weight)} ${unit}`;
}

// ============================================================================
// DATE/TIME FORMATTING
// ============================================================================

export function formatDate(dateString: string | undefined): string {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(dateString: string | undefined): string {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTime(dateString: string | undefined): string {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelativeTime(dateString: string | undefined): string {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(dateString);
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

// ============================================================================
// BARCODE UTILITIES
// ============================================================================

export function formatBarcode(barcode: string): string {
  // Format barcode with dashes for readability
  // Example: 123456789012 -> 12-3456-7890-12
  if (barcode.length === 12) {
    return `${barcode.slice(0, 2)}-${barcode.slice(2, 6)}-${barcode.slice(6, 10)}-${barcode.slice(10)}`;
  }
  return barcode;
}

export function validateBarcode(barcode: string): boolean {
  // Basic barcode validation (length and numeric)
  return /^\d{8,14}$/.test(barcode.replace(/-/g, ''));
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

export function validateQuantity(quantity: number): { valid: boolean; message?: string } {
  if (quantity < 0) {
    return { valid: false, message: 'Quantity cannot be negative' };
  }
  if (!Number.isInteger(quantity)) {
    return { valid: false, message: 'Quantity must be a whole number' };
  }
  return { valid: true };
}

export function validateSKU(sku: string): { valid: boolean; message?: string } {
  if (!sku || sku.trim().length === 0) {
    return { valid: false, message: 'SKU is required' };
  }
  if (sku.length > 50) {
    return { valid: false, message: 'SKU must be 50 characters or less' };
  }
  if (!/^[A-Za-z0-9-_]+$/.test(sku)) {
    return { valid: false, message: 'SKU can only contain letters, numbers, hyphens, and underscores' };
  }
  return { valid: true };
}

// ============================================================================
// PICKING HELPERS
// ============================================================================

export function calculatePickingProgress(pickedItems: number, totalItems: number): {
  percentage: number;
  completed: number;
  total: number;
} {
  const percentage = totalItems === 0 ? 0 : Math.round((pickedItems / totalItems) * 100);
  return {
    percentage,
    completed: pickedItems,
    total: totalItems,
  };
}

export function estimatePickingTime(totalItems: number, itemsPerMinute: number = 6): number {
  // Estimate picking time in minutes
  return Math.ceil(totalItems / itemsPerMinute);
}

// ============================================================================
// SORTING UTILITIES
// ============================================================================

export function sortByPriority<T extends { priority: OrderPriority }>(items: T[]): T[] {
  const priorityOrder = { urgent: 0, high: 1, normal: 2 };
  return [...items].sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
}

export function sortByDate<T extends { createdAt: string }>(items: T[], ascending: boolean = false): T[] {
  return [...items].sort((a, b) => {
    const dateA = new Date(a.createdAt).getTime();
    const dateB = new Date(b.createdAt).getTime();
    return ascending ? dateA - dateB : dateB - dateA;
  });
}

// ============================================================================
// FILTER HELPERS
// ============================================================================

export function filterBySearchTerm<T>(items: T[], searchTerm: string, fields: (keyof T)[]): T[] {
  if (!searchTerm) return items;
  const term = searchTerm.toLowerCase();
  return items.filter((item) =>
    fields.some((field) => {
      const value = item[field];
      return value && String(value).toLowerCase().includes(term);
    })
  );
}

// ============================================================================
// ADDRESS FORMATTING
// ============================================================================

export function formatAddress(address: {
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}): string {
  const parts: string[] = [];
  if (address.address1) parts.push(address.address1);
  if (address.address2) parts.push(address.address2);
  const cityStateZip = [address.city, address.state, address.postalCode].filter(Boolean).join(', ');
  if (cityStateZip) parts.push(cityStateZip);
  if (address.country) parts.push(address.country);
  return parts.join('\n');
}

export function formatAddressInline(address: {
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}): string {
  const parts: string[] = [];
  if (address.address1) parts.push(address.address1);
  const cityState = [address.city, address.state].filter(Boolean).join(', ');
  if (cityState) parts.push(cityState);
  if (address.postalCode) parts.push(address.postalCode);
  return parts.join(', ');
}

// ============================================================================
// ANALYTICS HELPERS
// ============================================================================

export function calculateFulfillmentRate(fulfilled: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((fulfilled / total) * 100);
}

export function calculateAveragePickTime(totalTime: number, totalPicks: number): number {
  if (totalPicks === 0) return 0;
  return Math.round(totalTime / totalPicks);
}

export function calculateInventoryTurnover(soldQuantity: number, averageInventory: number): number {
  if (averageInventory === 0) return 0;
  return parseFloat((soldQuantity / averageInventory).toFixed(2));
}

// ============================================================================
// EXPORT ALL UTILITIES
// ============================================================================

export default {
  // Status colors
  getOrderStatusColor,
  getFulfillmentStatusColor,
  getPickListStatusColor,
  getShipmentStatusColor,
  getPurchaseOrderStatusColor,
  getReturnStatusColor,
  getCycleCountStatusColor,
  getInventoryStatusColor,
  getLocationStatusColor,
  getPriorityColor,

  // Status labels
  getOrderStatusLabel,
  getFulfillmentStatusLabel,
  getPickListStatusLabel,
  getPriorityLabel,

  // Stock calculations
  calculateStockStatus,

  // Formatting
  formatMoney,
  formatMoneyCompact,
  formatNumber,
  formatPercentage,
  formatWeight,
  formatDate,
  formatDateTime,
  formatTime,
  formatRelativeTime,
  formatDuration,
  formatBarcode,
  formatAddress,
  formatAddressInline,

  // Validation
  validateBarcode,
  validateQuantity,
  validateSKU,

  // Picking
  calculatePickingProgress,
  estimatePickingTime,

  // Sorting
  sortByPriority,
  sortByDate,

  // Filtering
  filterBySearchTerm,

  // Analytics
  calculateFulfillmentRate,
  calculateAveragePickTime,
  calculateInventoryTurnover,
};
