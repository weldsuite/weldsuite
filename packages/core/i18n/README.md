# WeldSuite i18n System - Developer Guide

Complete guide to using the auto-inferred, type-safe translation system in WeldSuite platform.

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Server-Side Pattern (Recommended)](#server-side-pattern-recommended)
4. [Client-Side Pattern](#client-side-pattern)
5. [Adding New Translations](#adding-new-translations)
6. [Common Patterns](#common-patterns)
7. [Best Practices](#best-practices)
8. [Migration Tools](#migration-tools)
9. [Troubleshooting](#troubleshooting)

---

## Overview

WeldSuite uses an **auto-inferred translation system** that provides:

- ✅ **Full TypeScript type safety** - No manual type definitions needed
- ✅ **Auto-complete everywhere** - IntelliSense for all translation keys
- ✅ **Zero build step** - Types inferred directly from source files
- ✅ **EN/NL parity enforcement** - Validation scripts ensure completeness
- ✅ **Server-first architecture** - Optimized for Next.js 15 Server Components

### Supported Languages

- `en` - English (primary/reference)
- `nl` - Dutch (Nederlandse)

---

## Quick Start

### 1. Server Component Example

```typescript
// app/wms/warehouses/page.tsx
import { getTranslations } from '@/lib/i18n';
import { WarehouseList } from './warehouse-list-client';

export default async function WarehousesPage() {
  const t = await getTranslations('wms');

  return (
    <div>
      <h1>{t.warehouses.title}</h1>
      <p>{t.warehouses.description}</p>
      <WarehouseList t={t} />
    </div>
  );
}
```

### 2. Client Component Example

```typescript
'use client';

// app/wms/warehouses/warehouse-list-client.tsx
import { type TranslationProp } from '@/lib/i18n/types';

interface WarehouseListProps {
  t: TranslationProp<'wms'>;
}

export function WarehouseList({ t }: WarehouseListProps) {
  return (
    <div>
      <button>{t.warehouses.actions.add}</button>
      <table>
        <thead>
          <tr>
            <th>{t.warehouses.columns.name}</th>
            <th>{t.warehouses.columns.location}</th>
            <th>{t.warehouses.columns.status}</th>
          </tr>
        </thead>
      </table>
    </div>
  );
}
```

---

## Server-Side Pattern (Recommended)

The **server-side pattern** is recommended for WeldSuite because it:
- Works with Next.js Server Components
- Reduces client-side bundle size
- Enables better SEO
- Simplifies data loading with translations

### Basic Server-Side Pattern

```typescript
// Server Component (page.tsx)
import { getTranslations } from '@/lib/i18n';

export default async function ProductsPage() {
  const t = await getTranslations('commerce');

  return (
    <div>
      <h1>{t.products.title}</h1>
      <ProductTable t={t} />
    </div>
  );
}
```

```typescript
'use client';

// Client Component (product-table.tsx)
import { type TranslationProp } from '@/lib/i18n/types';

interface ProductTableProps {
  t: TranslationProp<'commerce'>;
}

export function ProductTable({ t }: ProductTableProps) {
  return (
    <table>
      <thead>
        <tr>
          <th>{t.products.columns.name}</th>
          <th>{t.products.columns.price}</th>
          <th>{t.products.columns.stock}</th>
        </tr>
      </thead>
    </table>
  );
}
```

### Multiple Namespaces

When you need translations from multiple namespaces:

```typescript
// Server Component
import { getTranslations } from '@/lib/i18n';

export default async function InvoicePage() {
  const accountingT = await getTranslations('accounting');
  const commonT = await getTranslations('common');

  return (
    <InvoiceForm
      accountingT={accountingT}
      commonT={commonT}
    />
  );
}
```

```typescript
'use client';

import { type TranslationProp } from '@/lib/i18n/types';

interface InvoiceFormProps {
  accountingT: TranslationProp<'accounting'>;
  commonT: TranslationProp<'common'>;
}

export function InvoiceForm({ accountingT, commonT }: InvoiceFormProps) {
  return (
    <form>
      <label>{accountingT.invoices.fields.number}</label>
      <button>{commonT.actions.save}</button>
      <button>{commonT.actions.cancel}</button>
    </form>
  );
}
```

### Deep Nesting - Passing Sections

For large components, pass only the needed section:

```typescript
// Server Component
import { getTranslations } from '@/lib/i18n';

export default async function OrderDetailsPage() {
  const t = await getTranslations('wms');

  // Pass only the orders section
  return <OrderDetails orders={t.orders} />;
}
```

```typescript
'use client';

import { type TranslationSection } from '@/lib/i18n/types';

interface OrderDetailsProps {
  orders: TranslationSection<'wms', 'orders'>;
}

export function OrderDetails({ orders }: OrderDetailsProps) {
  return (
    <div>
      <h2>{orders.title}</h2>
      <p>{orders.description}</p>
      <span>{orders.status.pending}</span>
    </div>
  );
}
```

---

## Client-Side Pattern

Use client-side pattern only when:
- Language switching without page reload is required
- Component is always client-side
- No server rendering needed

```typescript
'use client';

import { useI18n } from '@/lib/i18n/provider';

export function LanguageSwitcher() {
  const { t, language, setLanguage } = useI18n();

  return (
    <div>
      <span>{t.common.language.current}: {language}</span>
      <button onClick={() => setLanguage('en')}>English</button>
      <button onClick={() => setLanguage('nl')}>Nederlands</button>
    </div>
  );
}
```

**Note:** The client-side pattern uses the hook directly but requires the component to be wrapped in `I18nProvider` (already done in root layout).

---

## Adding New Translations

### Step 1: Add to English (en.ts)

```typescript
// lib/i18n/locales/en.ts
export const en = {
  // ... existing translations

  myModule: {
    title: 'My Module',
    description: 'Module description',

    actions: {
      create: 'Create New',
      edit: 'Edit',
      delete: 'Delete',
    },

    fields: {
      name: 'Name',
      description: 'Description',
      status: 'Status',
    },

    status: {
      active: 'Active',
      inactive: 'Inactive',
      pending: 'Pending',
    },

    messages: {
      created: 'Item created successfully',
      updated: 'Item updated successfully',
      deleted: 'Item deleted successfully',
      error: 'An error occurred',
    },

    validation: {
      nameRequired: 'Name is required',
      descriptionTooLong: 'Description is too long',
    },
  },
} as const;
```

### Step 2: Add to Dutch (nl.ts)

```typescript
// lib/i18n/locales/nl.ts
export const nl = {
  // ... existing translations

  myModule: {
    title: 'Mijn Module',
    description: 'Module beschrijving',

    actions: {
      create: 'Nieuwe aanmaken',
      edit: 'Bewerken',
      delete: 'Verwijderen',
    },

    fields: {
      name: 'Naam',
      description: 'Beschrijving',
      status: 'Status',
    },

    status: {
      active: 'Actief',
      inactive: 'Inactief',
      pending: 'In behandeling',
    },

    messages: {
      created: 'Item succesvol aangemaakt',
      updated: 'Item succesvol bijgewerkt',
      deleted: 'Item succesvol verwijderd',
      error: 'Er is een fout opgetreden',
    },

    validation: {
      nameRequired: 'Naam is verplicht',
      descriptionTooLong: 'Beschrijving is te lang',
    },
  },
} as const;
```

### Step 3: Validate

```bash
# Ensure EN and NL are in sync
pnpm tsx scripts/validate-translations.ts

# Auto-fix missing keys with [TRANSLATE] markers
pnpm tsx scripts/validate-translations.ts --fix
```

### Step 4: Use in Code

```typescript
const t = await getTranslations('myModule');

console.log(t.title); // "My Module" or "Mijn Module"
console.log(t.actions.create); // "Create New" or "Nieuwe aanmaken"
console.log(t.validation.nameRequired); // "Name is required" or "Naam is verplicht"
```

**TypeScript automatically knows all keys** - you get autocomplete and type checking!

---

## Common Patterns

### 1. Data Table with Translations

```typescript
// Server Component
const t = await getTranslations('wms');

<DataTable
  columns={[
    { key: 'name', label: t.inventory.columns.name },
    { key: 'sku', label: t.inventory.columns.sku },
    { key: 'quantity', label: t.inventory.columns.quantity },
    { key: 'status', label: t.inventory.columns.status },
  ]}
  t={t}
/>
```

### 2. Form with Validation

```typescript
'use client';

interface FormProps {
  t: TranslationProp<'accounting'>;
}

export function InvoiceForm({ t }: FormProps) {
  const form = useForm({
    resolver: zodResolver(
      z.object({
        invoiceNumber: z.string().min(1, t.invoices.validation.numberRequired),
        amount: z.number().positive(t.invoices.validation.amountPositive),
      })
    ),
  });

  return (
    <Form {...form}>
      <FormField
        name="invoiceNumber"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t.invoices.fields.number}</FormLabel>
            <FormControl>
              <Input placeholder={t.invoices.placeholders.number} {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </Form>
  );
}
```

### 3. Toast Notifications

```typescript
import { toast } from '@weldsuite/ui/hooks/use-toast';

interface Props {
  t: TranslationProp<'wms'>;
}

export function WarehouseActions({ t }: Props) {
  const handleCreate = () => {
    // ... create logic

    toast({
      title: t.warehouses.messages.created,
      description: t.warehouses.messages.createdDescription,
    });
  };

  return <button onClick={handleCreate}>{t.warehouses.actions.create}</button>;
}
```

### 4. Status Badges

```typescript
interface StatusBadgeProps {
  status: 'active' | 'inactive' | 'pending';
  t: TranslationProp<'common'>;
}

export function StatusBadge({ status, t }: StatusBadgeProps) {
  return (
    <Badge variant={status === 'active' ? 'success' : 'default'}>
      {t.status[status]}
    </Badge>
  );
}
```

### 5. Dynamic Keys

```typescript
interface Props {
  t: TranslationProp<'wms'>;
  orderType: 'purchase' | 'sales' | 'transfer';
}

export function OrderTypeBadge({ t, orderType }: Props) {
  return <span>{t.orders.types[orderType]}</span>;
}
```

### 6. Date/Number Formatting

```typescript
import { formatDate, formatCurrency, formatNumber } from '@/lib/i18n';

const locale = await getLocale();

// Format date
const formattedDate = formatDate(new Date(), locale, {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

// Format currency
const price = formatCurrency(1234.56, locale, 'EUR');

// Format number
const quantity = formatNumber(1234.567, locale, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
```

---

## Best Practices

### ✅ DO

1. **Always use translations for user-facing text**
   ```typescript
   // ✅ Good
   <button>{t.actions.save}</button>

   // ❌ Bad
   <button>Save</button>
   ```

2. **Use server-side pattern for most components**
   ```typescript
   // ✅ Good - Server Component
   const t = await getTranslations('wms');
   <ClientComponent t={t} />

   // ⚠️ OK but less optimal - Client hook
   const { t } = useI18n();
   ```

3. **Pass only needed sections to reduce prop size**
   ```typescript
   // ✅ Good
   <OrderForm orders={t.orders} />

   // ⚠️ Verbose
   <OrderForm t={t} />
   ```

4. **Use proper TypeScript types**
   ```typescript
   // ✅ Good
   interface Props {
     t: TranslationProp<'wms'>;
   }

   // ❌ Bad
   interface Props {
     t: any;
   }
   ```

5. **Group related translations logically**
   ```typescript
   // ✅ Good structure
   myModule: {
     title: '...',
     actions: { ... },
     fields: { ... },
     validation: { ... },
     messages: { ... },
   }
   ```

### ❌ DON'T

1. **Don't hardcode English strings**
   ```typescript
   // ❌ Bad
   <label>Customer Name</label>

   // ✅ Good
   <label>{t.customers.fields.name}</label>
   ```

2. **Don't use template strings for translation keys**
   ```typescript
   // ❌ Bad - loses type safety
   const key = `${module}.${field}`;
   t[key]

   // ✅ Good - type-safe
   t.module.field
   ```

3. **Don't duplicate translations**
   ```typescript
   // ❌ Bad
   wms: { save: 'Save' }
   accounting: { save: 'Save' }

   // ✅ Good - use common
   common: { actions: { save: 'Save' } }
   ```

4. **Don't forget Dutch translations**
   ```typescript
   // ❌ Bad - missing NL
   en: { title: 'Orders' }
   nl: { }

   // ✅ Good
   en: { title: 'Orders' }
   nl: { title: 'Bestellingen' }
   ```

---

## Migration Tools

### Find Hardcoded Strings

Scan your codebase for hardcoded English strings:

```bash
# Scan all modules
pnpm tsx scripts/find-hardcoded-strings.ts --verbose

# Scan specific module
pnpm tsx scripts/find-hardcoded-strings.ts --module wms

# Save results
pnpm tsx scripts/find-hardcoded-strings.ts --output results.json
```

### Generate Translation Keys

Auto-generate translation keys from hardcoded strings:

```bash
# Generate keys with auto-translation
pnpm tsx scripts/generate-translation-keys.ts results.json --dutch --output keys.json

# Review keys.json and merge into en.ts and nl.ts
```

### Validate Translations

Check EN/NL parity and find issues:

```bash
# Validate translations
pnpm tsx scripts/validate-translations.ts

# Auto-fix missing keys
pnpm tsx scripts/validate-translations.ts --fix

# Save report
pnpm tsx scripts/validate-translations.ts --report validation-report.json
```

---

## Troubleshooting

### TypeScript Not Finding Translation Keys

**Problem:** TypeScript doesn't autocomplete translation keys

**Solution:**
1. Ensure both `en.ts` and `nl.ts` have `as const` at the end
2. Restart TypeScript server: `Cmd+Shift+P` → "Restart TypeScript Server"
3. Check that `lib/i18n/types.ts` imports from `'./locales/en'`

### Translation Key Not Found at Runtime

**Problem:** Console shows "Translation key not found: x.y.z"

**Solution:**
1. Check that key exists in `lib/i18n/locales/en.ts`
2. Run validation: `pnpm tsx scripts/validate-translations.ts`
3. Ensure spelling matches exactly (case-sensitive)

### Dutch Translation Missing

**Problem:** Shows English even when locale is NL

**Solution:**
1. Check that key exists in `lib/i18n/locales/nl.ts`
2. Run `pnpm tsx scripts/validate-translations.ts --fix`
3. Add proper Dutch translation (remove [TRANSLATE] markers)

### Language Not Switching

**Problem:** Language doesn't change when calling `setLanguage()`

**Solution:**
1. Verify component is wrapped in `<I18nProvider>`
2. For server components, language change requires page refresh
3. Use client-side hook: `const { setLanguage } = useI18n()`

### Type Errors When Passing Translations

**Problem:** TypeScript error when passing `t` as prop

**Solution:**
```typescript
// ✅ Use proper type
import { type TranslationProp } from '@/lib/i18n/types';

interface Props {
  t: TranslationProp<'wms'>; // Not 'any' or 'typeof t'
}
```

---

## Additional Resources

- **Translation Files:** `lib/i18n/locales/`
- **Type Definitions:** `lib/i18n/types.ts`
- **Server API:** `lib/i18n/index.ts`
- **Client Provider:** `lib/i18n/provider.tsx`
- **Migration Scripts:** `scripts/`

For questions or issues, see the WeldSuite documentation or ask the development team.
