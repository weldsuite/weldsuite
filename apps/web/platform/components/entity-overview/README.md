# Entity Overview Components

Reusable components for creating consistent entity listing pages (orders, products, customers, etc.) across the platform app.

## Components

### EntityPageHeader

Wrapper component that includes the page title, statistics badges, action buttons, and the main content area.

### EntityDataTable

A fully-featured data table with:
- Status filtering
- Advanced filters (dropdowns, inputs, number fields)
- Search functionality with debouncing
- Column sorting
- Column visibility toggles
- Pagination
- Export functionality
- Loading states with skeleton UI
- Empty states
- Responsive design

## Usage Example

```tsx
import {
  EntityPageHeader,
  EntityDataTable,
  type ColumnDefinition,
  type StatItem,
  type ActionButton,
  type StatusFilter,
} from "@/components/entity-overview";
import { Clock, Package, Truck, CheckCircle, Plus, Download, Eye, Edit } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";

// Define your column structure
const columns: ColumnDefinition<Order>[] = [
  {
    key: "orderNumber",
    label: "Order Number",
    sortable: true,
    render: (order) => (
      <Link href={`/commerce/orders/${order.id}`} className="text-sm font-medium hover:text-primary transition-colors hover:underline underline-offset-4">
        #{order.orderNumber}
      </Link>
    ),
  },
  {
    key: "customer",
    label: "Customer",
    render: (order) => (
      <span className="text-sm text-muted-foreground">{order.customerName || "Guest"}</span>
    ),
  },
  {
    key: "total",
    label: "Total",
    sortable: true,
    className: "text-right",
    render: (order) => (
      <span className="font-mono text-sm">${order.total.toFixed(2)}</span>
    ),
  },
  {
    key: "status",
    label: "Status",
    sortable: true,
    render: (order) => (
      <Badge variant={order.status === "delivered" ? "outline" : "secondary"}>
        {order.status}
      </Badge>
    ),
  },
  {
    key: "actions",
    label: "",
    className: "text-right",
    render: (order) => (
      <div className="flex items-center justify-end gap-2">
        <Link href={`/commerce/orders/${order.id}`}>
          <Button variant="ghost" size="sm">
            <Eye className="h-4 w-4" />
          </Button>
        </Link>
        <Link href={`/commerce/orders/${order.id}/edit`}>
          <Button variant="ghost" size="sm">
            <Edit className="h-4 w-4" />
          </Button>
        </Link>
      </div>
    ),
  },
];

// Define statistics
const stats: StatItem[] = [
  { icon: Clock, label: "Pending", count: counts.pending, color: "text-yellow-600" },
  { icon: Package, label: "Processing", count: counts.processing, color: "text-blue-600" },
  { icon: Truck, label: "Shipped", count: counts.shipped, color: "text-purple-600" },
  { icon: CheckCircle, label: "Delivered", count: counts.delivered, color: "text-green-600" },
];

// Define action buttons
const actions: ActionButton[] = [
  { label: "Export Orders", icon: Download, variant: "outline", onClick: handleExport },
  { label: "New Order", icon: Plus, variant: "default", href: "/commerce/orders/add" },
];

// Define status filters
const statusFilters: StatusFilter[] = [
  { key: "pending", label: "Pending", value: "pending" },
  { key: "processing", label: "Processing", value: "processing" },
  { key: "shipped", label: "Shipped", value: "shipped" },
  { key: "delivered", label: "Delivered", value: "delivered" },
];

// Define additional filters
const additionalFilters: FilterOption[] = [
  {
    key: "minTotal",
    label: "Min Total",
    type: "number",
    placeholder: "≥",
  },
  {
    key: "priority",
    label: "Priority",
    type: "select",
    options: [
      { label: "High", value: "high" },
      { label: "Normal", value: "normal" },
      { label: "Low", value: "low" },
    ],
  },
];

// In your page component
export default async function OrdersPage({ searchParams }: OrdersPageProps) {
  const params = await searchParams;

  // Fetch your data
  const { orders, pagination, counts } = await fetchOrders(params);

  return (
    <EntityPageHeader
      title="Orders"
      stats={stats}
      actions={actions}
    >
      <EntityDataTable
        data={orders}
        columns={columns}
        pagination={pagination}
        searchParams={params}
        statusFilters={statusFilters}
        additionalFilters={additionalFilters}
        counts={counts}
        onFetchData={async (filters) => {
          "use server";
          return await fetchOrders(filters);
        }}
        onExport={async (filters) => {
          "use server";
          await exportOrders(filters);
        }}
        emptyMessage="No orders found"
      />
    </EntityPageHeader>
  );
}
```

## Props

### EntityPageHeader

| Prop | Type | Description |
|------|------|-------------|
| `title` | `string` | Page title |
| `stats` | `StatItem[]` | Array of statistics to display |
| `actions` | `ActionButton[]` | Array of action buttons |
| `children` | `ReactNode` | Content to render (typically EntityDataTable) |

### EntityDataTable

| Prop | Type | Description |
|------|------|-------------|
| `data` | `T[]` | Array of items to display |
| `columns` | `ColumnDefinition<T>[]` | Column definitions |
| `pagination` | `PaginationData` | Pagination information |
| `searchParams` | `any` | Initial search params from URL |
| `statusFilters` | `StatusFilter[]` | Status filter buttons |
| `additionalFilters` | `FilterOption[]` | Additional filter inputs |
| `counts` | `Record<string, number>` | Count data for status filters |
| `onFetchData` | `(filters) => Promise<{data, pagination, counts}>` | Function to fetch data |
| `onExport` | `(filters) => Promise<void>` | Function to export data |
| `emptyMessage` | `string` | Message when no data |
| `emptyIcon` | `React.ComponentType` | Icon for empty state |

## Types

### ColumnDefinition

```typescript
interface ColumnDefinition<T> {
  key: string;
  label: string;
  sortable?: boolean;
  render: (item: T) => React.ReactNode;
  width?: string;
  className?: string;
}
```

### StatItem

```typescript
interface StatItem {
  icon: LucideIcon;
  label: string;
  count: number;
  color?: string;
  show?: boolean;
}
```

### ActionButton

```typescript
interface ActionButton {
  label: string;
  icon: LucideIcon;
  href?: string;
  onClick?: () => void;
  variant?: "default" | "outline" | "ghost";
}
```

### StatusFilter

```typescript
interface StatusFilter {
  key: string;
  label: string;
  value: string;
}
```

### FilterOption

```typescript
interface FilterOption {
  key: string;
  label: string;
  type: "select" | "input" | "number";
  options?: { label: string; value: string }[];
  placeholder?: string;
}
```

### PaginationData

```typescript
interface PaginationData {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasMore: boolean;
}
```

## Features

- **Server-side rendering** - Initial data is fetched on the server
- **Client-side filtering** - Filters update via server actions without full page reload
- **Debounced search** - Search input is debounced to reduce API calls
- **Column management** - Users can show/hide columns
- **Sorting** - Click column headers to sort (if enabled)
- **Status filters** - Quick filter buttons with counts
- **Advanced filters** - Dropdown and input filters
- **Export** - Export filtered data
- **Responsive** - Works on all screen sizes
- **Loading states** - Skeleton UI during data fetch
- **Empty states** - Friendly message when no data
- **Pagination** - Navigate through pages of data
- **URL sync** - Filter state is synced with URL params
