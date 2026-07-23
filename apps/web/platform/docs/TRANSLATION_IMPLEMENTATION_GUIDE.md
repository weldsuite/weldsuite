# Translation Implementation Guide

This guide explains how to implement translations in the WeldSuite Platform app.

## Overview

The platform now supports multi-language functionality with English (EN) and Dutch (NL) translations. All user-facing text should use the translation system to ensure a consistent multilingual experience.

## Translation Structure

### Available Namespaces

- **`common`** - Shared UI elements, actions, statuses, messages
- **`accounting`** - Accounting module (invoices, bills, reports, etc.)
- **`commerce`** - E-commerce functionality (products, orders, cart)
- **`wms`** - Warehouse Management System (warehouses, inventory, orders, picklists)
- **`crm`** - Customer Relationship Management (contacts, deals, activities)

### Translation Files Location

- English: `apps/web/platform/lib/i18n/locales/en.ts`
- Dutch: `apps/web/platform/lib/i18n/locales/nl.ts`
- Types: `apps/web/platform/lib/i18n/types.ts`

## Implementation Patterns

### Server Components (Async Pages)

For server components, use the `getTranslations()` function:

```typescript
import { getTranslations } from '@/lib/i18n';

export default async function MyPage() {
  // Get translations for specific namespace
  const t = await getTranslations('wms');
  const common = await getTranslations('common');

  return (
    <div>
      <h1>{t.warehouses.title}</h1>
      <p>{t.warehouses.description}</p>
      <button>{common.actions.save}</button>
    </div>
  );
}
```

### Client Components

For client components, use the `useI18n()` hook:

```typescript
'use client';

import { useI18n } from '@/lib/i18n/provider';

export function MyClientComponent() {
  const { t, language, setLanguage } = useI18n();

  return (
    <div>
      <h1>{t.wms.warehouses.title}</h1>
      <button onClick={() => setLanguage('nl')}>
        Switch to Dutch
      </button>
    </div>
  );
}
```

## Real-World Example: WMS Warehouses Page

### Before (Hardcoded Strings)

```typescript
export default async function WarehousesPage({ searchParams }: WarehousesPageProps) {
  const headerStats: StatItem[] = [
    { icon: Building, label: "Active", count: activeWarehouses, color: "text-green-600" },
    { icon: Package, label: "Total SKUs", count: totalItems, color: "text-blue-600" },
  ];

  const actions: ActionButton[] = [
    { label: "Add Warehouse", icon: Plus, variant: "default", href: "/wms/warehouses/new" },
  ];

  return (
    <EntityPageHeader title="Warehouse Management" stats={headerStats} actions={actions}>
      <ServerWarehousesDataTable warehouses={warehouses} />
    </EntityPageHeader>
  );
}
```

### After (With Translations)

```typescript
import { getTranslations } from '@/lib/i18n';

export default async function WarehousesPage({ searchParams }: WarehousesPageProps) {
  // Get translations
  const t = await getTranslations('wms');
  const common = await getTranslations('common');

  const headerStats: StatItem[] = [
    { icon: Building, label: t.warehouses.status.active, count: activeWarehouses, color: "text-green-600" },
    { icon: Package, label: t.warehouses.totalLocations, count: totalItems, color: "text-blue-600" },
  ];

  const actions: ActionButton[] = [
    { label: t.warehouses.actions.newWarehouse, icon: Plus, variant: "default", href: "/wms/warehouses/new" },
  ];

  return (
    <EntityPageHeader title={t.warehouses.title} stats={headerStats} actions={actions}>
      <ServerWarehousesDataTable warehouses={warehouses} />
    </EntityPageHeader>
  );
}
```

## Translation Key Structure

### WMS Translations

```typescript
wms: {
  title: "Warehouse Management"
  warehouses: {
    title: "Warehouses"
    actions: {
      newWarehouse: "New Warehouse"
      editWarehouse: "Edit Warehouse"
      deleteWarehouse: "Delete Warehouse"
    }
    status: {
      active: "Active"
      inactive: "Inactive"
    }
    messages: {
      warehouseCreated: "Warehouse created successfully"
    }
  }
  inventory: { ... }
  orders: { ... }
  // ... more sections
}
```

### CRM Translations

```typescript
crm: {
  title: "Customer Relationship Management"
  contacts: {
    title: "Contacts"
    actions: {
      newContact: "New Contact"
      editContact: "Edit Contact"
    }
    messages: {
      contactCreated: "Contact created successfully"
    }
  }
  deals: { ... }
  // ... more sections
}
```

### Common Translations

```typescript
common: {
  actions: {
    save: "Save"
    cancel: "Cancel"
    delete: "Delete"
    edit: "Edit"
  }
  status: {
    loading: "Loading..."
    success: "Success"
    error: "Error"
  }
  messages: {
    confirmDelete: "Are you sure you want to delete this item?"
  }
}
```

## Best Practices

### 1. Use Appropriate Namespace

Choose the namespace that best fits your context:

```typescript
// For WMS-specific content
const t = await getTranslations('wms');

// For general UI elements
const common = await getTranslations('common');

// For accounting features
const accounting = await getTranslations('accounting');
```

### 2. Organize by Feature

Group translations by feature/module:

```typescript
// Good
t.warehouses.actions.newWarehouse
t.inventory.actions.adjustStock
t.orders.status.pending

// Avoid
t.newWarehouse
t.adjustStock
t.pending
```

### 3. Consistent Naming

Follow these naming conventions:

- **Actions**: `actions.{verb}{Noun}` (e.g., `actions.newWarehouse`, `actions.editContact`)
- **Status**: `status.{statusName}` (e.g., `status.active`, `status.pending`)
- **Messages**: `messages.{action}{Result}` (e.g., `messages.warehouseCreated`, `messages.deleteFailed`)
- **Labels**: Direct property names (e.g., `warehouseName`, `orderNumber`)

### 4. Fallback for Missing Keys

Always provide fallback text for keys that might not exist:

```typescript
const label = t.warehouses.totalValue || "Total Value";
```

### 5. Parameterized Translations

For dynamic content, use parameterized translations:

```typescript
// In translation file
lowStockAlert: "Low stock alert for {productName}"

// In component
const message = t.inventory.messages.lowStockAlert.replace('{productName}', product.name);
```

## Migration Checklist

When converting a page to use translations:

- [ ] Import `getTranslations` from `@/lib/i18n`
- [ ] Load required translation namespaces
- [ ] Replace all hardcoded strings with translation keys
- [ ] Update button labels
- [ ] Update status labels
- [ ] Update form labels and placeholders
- [ ] Update success/error messages
- [ ] Update page titles and descriptions
- [ ] Test language switching
- [ ] Verify all translations exist in both EN and NL

## Adding New Translations

### 1. Add to English File (`en.ts`)

```typescript
wms: {
  // ... existing translations
  shipping: {
    title: "Shipping",
    actions: {
      createShipment: "Create Shipment",
      trackShipment: "Track Shipment"
    }
  }
}
```

### 2. Add to Dutch File (`nl.ts`)

```typescript
wms: {
  // ... existing translations
  shipping: {
    title: "Verzending",
    actions: {
      createShipment: "Zending Aanmaken",
      trackShipment: "Zending Volgen"
    }
  }
}
```

### 3. Use in Component

```typescript
const t = await getTranslations('wms');
<h1>{t.shipping.title}</h1>
<button>{t.shipping.actions.createShipment}</button>
```

## Language Switching

Users can switch languages using the language selector in the UI. The selected language is stored in cookies and persists across sessions.

### Programmatic Language Change

```typescript
'use client';

import { useI18n } from '@/lib/i18n/provider';

export function LanguageSwitcher() {
  const { language, setLanguage } = useI18n();

  return (
    <select value={language} onChange={(e) => setLanguage(e.target.value as 'en' | 'nl')}>
      <option value="en">English</option>
      <option value="nl">Nederlands</option>
    </select>
  );
}
```

## Common Translation Keys Reference

### Actions (common.actions)

- `save`, `cancel`, `delete`, `edit`, `create`, `update`
- `search`, `filter`, `export`, `import`, `print`
- `view`, `back`, `next`, `previous`, `confirm`, `close`

### Status (common.status)

- `active`, `inactive`, `pending`, `completed`
- `draft`, `sent`, `paid`, `overdue`, `cancelled`
- `loading`, `saving`, `deleting`, `success`, `error`

### Messages (common.messages)

- `confirmDelete`, `saveSuccess`, `deleteSuccess`
- `createSuccess`, `updateSuccess`, `errorOccurred`
- `noResults`, `noData`, `required`, `invalid`

## Testing Translations

### Manual Testing

1. Start the development server: `pnpm dev`
2. Navigate to a translated page
3. Switch language using the language selector
4. Verify all text changes appropriately
5. Check for missing translations (untranslated keys will show as the key path)

### Checking Coverage

Search for hardcoded strings:

```bash
# Find potential hardcoded strings in pages
grep -r "\"[A-Z][a-z]" apps/web/platform/app/wms --include="*.tsx"
```

## Troubleshooting

### Translation not showing

**Problem**: Translation key shows instead of translated text

**Solution**:
1. Check if the translation key exists in both `en.ts` and `nl.ts`
2. Verify the namespace is loaded: `const t = await getTranslations('wms')`
3. Check the key path is correct: `t.warehouses.title` not `t.warehouse.title`

### TypeScript errors

**Problem**: TypeScript complains about translation types

**Solution**:
1. Regenerate types if needed (though currently manual)
2. Use the flexible interface with `[key: string]: any` for complex nested structures
3. Add type assertions where necessary: `(t as any).newKey`

### Language not persisting

**Problem**: Language resets after page refresh

**Solution**:
1. Check cookie settings in `lib/i18n/index.ts`
2. Verify `setLocale()` is being called correctly
3. Check browser cookie storage

## Next Steps

This implementation provides the foundation for translations. The team should now:

1. Continue converting remaining pages (Accounting, Commerce, CRM)
2. Add translations for data tables and forms
3. Add translations for error messages and toasts
4. Consider adding more languages (FR, DE, ES)
5. Implement translation management tooling if needed

## Resources

- Translation Files: `apps/web/platform/lib/i18n/locales/`
- Type Definitions: `apps/web/platform/lib/i18n/types.ts`
- Provider Component: `apps/web/platform/lib/i18n/provider.tsx`
- Example Implementation: `apps/web/platform/app/wms/warehouses/page.tsx`
