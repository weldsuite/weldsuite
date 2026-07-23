# WeldSuite UI, how to build with this design system

`@weldsuite/ui` is a shadcn/ui-style React 19 library (Radix primitives + Tailwind CSS v4 + class-variance-authority). 74 components are exposed on `window.WeldSuiteUI` (e.g. `window.WeldSuiteUI.Button`). Groups: **primitives** (Button, Input, Badge, Label, Avatar, Switch, Slider, Progress, Separator, Skeleton, Textarea, Toggle, ToggleGroup, Kbd), **form** (FormField, Select, Checkbox, RadioGroup, DatePicker, Autocomplete, Dropzone, InputOTP, …), **layout** (Card, Accordion, Tabs, Table, ScrollArea, ResizablePanelGroup, Collapsible, …), **overlay** (Dialog, AlertDialog, Sheet, Drawer, Popover, Tooltip, DropdownMenu, ContextMenu, HoverCard, Command), **navigation** (Breadcrumb, Pagination, PageTabs), **feedback** (Alert, InfoBanner, Toaster, ConfirmDialog, PageLoader, …), **data-display** (ListTable, KanbanBoard, Calendar, Carousel, TreeView, AuditTimeline, StatusDot, …).

## Setup, no provider needed

Components read **no React context** for theming. Do **not** wrap the app in a theme/context provider, just render components and ensure the design system's `styles.css` is loaded (it carries the design tokens *and* all Tailwind utilities). Compound components export their parts as named exports you compose yourself, e.g. `Card` + `CardHeader`/`CardTitle`/`CardContent`/`CardFooter`, `Select` + `SelectTrigger`/`SelectContent`/`SelectItem`, `Dialog` + `DialogTrigger`/`DialogContent`. Overlays (Dialog, Popover, Tooltip, Sheet, DropdownMenu, …) render a **trigger** in the closed state and open on interaction, compose `<Trigger>` + `<Content>`, don't force them open.

**Dark mode** is class-based: add the `dark` class to an ancestor element (e.g. `<html class="dark">`). There is no theme prop. Default is light.

## Styling idiom, Tailwind v4 utilities + semantic token classes

Style with **Tailwind utility classes**, and reach for **semantic token classes** (NOT raw hex / `gray-500`) so components stay on-theme in light and dark. The tokens resolve to oklch values defined in `styles.css`. The vocabulary (all verified present in the bundle CSS):

| Concern | Classes |
|---|---|
| Surfaces | `bg-background` `bg-card` `bg-popover` `bg-muted` `bg-accent` `bg-secondary` |
| Brand / danger | `bg-primary` `text-primary-foreground` · `bg-destructive` `text-destructive` |
| Text | `text-foreground` `text-muted-foreground` `text-card-foreground` `text-secondary-foreground` `text-accent-foreground` |
| Borders / focus | `border` `border-border` `border-input` `ring-ring` `outline-ring` |
| Radius / elevation | `rounded-md` `rounded-lg` `rounded-xl` · `shadow-sm` |
| Layout (standard Tailwind) | `flex` `grid` `items-center` `justify-between` `gap-2` `gap-4` `px-4` `h-9` `size-9` |

Component variants are props, not classes, e.g. `<Button variant="destructive" size="sm">`, `<Badge variant="secondary">`. The per-component `<Name>.d.ts` (`<Name>Props`) is the authoritative API; `<Name>.prompt.md` shows usage. Read those plus `styles.css` (and its `@import "./_ds_bundle.css"`) before styling, they are the source of truth for the exact token and class names.

## Idiomatic example

```jsx
// library components from window.WeldSuiteUI; layout glue uses the DS idiom
<Card>
  <CardHeader>
    <CardTitle>Invoices</CardTitle>
  </CardHeader>
  <CardContent className="flex items-center justify-between gap-4">
    <p className="text-sm text-muted-foreground">3 unpaid</p>
    <Button variant="default" size="sm">New invoice</Button>
  </CardContent>
</Card>
```
