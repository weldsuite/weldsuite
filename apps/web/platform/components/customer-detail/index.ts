/**
 * Customer Detail Component
 *
 * A shared component for displaying customer details across CRM, Commerce, WMS, and Mail.
 * Supports three display modes: page, panel, and embedded.
 *
 * @example Page mode (CRM customer detail page)
 * ```tsx
 * <CustomerDetailView
 *   customerId={id}
 *   mode="page"
 *   initialData={prefetchedData}
 *   listId={listId}
 *   returnUrl={returnUrl}
 * />
 * ```
 *
 * @example Panel mode (Mail app, Order view)
 * ```tsx
 * <CustomerDetailView
 *   customerId={customerId}
 *   mode="panel"
 *   isOpen={isOpen}
 *   onClose={onClose}
 *   width="500px"
 * />
 * ```
 *
 * @example Embedded mode (in another page)
 * ```tsx
 * <CustomerDetailView
 *   customerId={customerId}
 *   mode="embedded"
 *   showHeader={false}
 *   showSidebar={false}
 * />
 * ```
 */

// Main component
export { CustomerDetailView } from './customer-detail-view';

// Context and hooks
;
;

// Sub-components (for advanced customization)
;
;
;
;

// Section components
;
;
;
;
;
;
;
;
;
;
;

// Types
;
