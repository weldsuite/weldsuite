# Reusable Sidebar Components

This document describes the reusable sidebar components available in the UI package for creating consistent app navigation across all WeldSuite applications.

## Components

### 1. AppSidebarLayout

The main sidebar layout component that provides a consistent structure for all app sidebars.

```typescript
import { AppSidebarLayout } from "@weldsuite/ui/components/app-sidebar-layout"
```

#### Props

- `appName: string` - The name of your application (e.g., "Accounting", "CRM")
- `appIcon: LucideIcon` - The icon to display for your app
- `menuItems: MenuGroupProps[]` - Array of menu groups and items
- `workspaceSwitcher?: React.ReactNode` - Optional workspace switcher component
- `footer?: React.ReactNode` - Optional footer content

#### Menu Structure

```typescript
interface MenuItemProps {
  title: string;
  href: string;
  icon: LucideIcon;
}

interface MenuGroupProps {
  group: string;
  items: MenuItemProps[];
}
```

### 2. WorkspaceSwitcher

A basic workspace switcher component for selecting between workspaces.

```typescript
import { WorkspaceSwitcher } from "@weldsuite/ui/components/workspace-switcher"
```

#### Props

- `currentWorkspace: Workspace | null` - Currently selected workspace
- `workspaces: Workspace[]` - List of available workspaces
- `loading?: boolean` - Loading state
- `onSwitch: (workspaceId: string) => void` - Callback when switching workspaces
- `onCreateClick?: () => void` - Callback when create button is clicked
- `createDialog?: React.ReactNode` - Optional create dialog component

### 3. WorkspaceSwitcherWithDialog

A complete workspace switcher with built-in create dialog.

```typescript
import { WorkspaceSwitcherWithDialog } from "@weldsuite/ui/components/workspace-switcher-with-dialog"
```

#### Props

- `currentWorkspace: Workspace | null` - Currently selected workspace
- `workspaces: Workspace[]` - List of available workspaces
- `loading?: boolean` - Loading state
- `onSwitch: (workspaceId: string) => void` - Callback when switching workspaces
- `onCreate: (data: { name: string; slug: string; description?: string }) => Promise<void>` - Callback to create workspace
- `appName?: string` - Name of the app for the dialog description

## Usage Example

### 1. Create Your App Sidebar Component

```typescript
"use client"

import * as React from "react"
import {
  Home,
  Settings,
  Users,
  // ... other icons
} from "lucide-react"
import { AppSidebarLayout, MenuGroupProps } from "@weldsuite/ui/components/app-sidebar-layout"
import { WorkspaceSwitcherWithDialog } from "@weldsuite/ui/components/workspace-switcher-with-dialog"
import { useWorkspace } from "@/contexts/workspace-context"

const menuItems: MenuGroupProps[] = [
  {
    group: "Dashboard",
    items: [
      { title: "Overview", href: "/", icon: Home },
    ],
  },
  {
    group: "Management",
    items: [
      { title: "Users", href: "/users", icon: Users },
      { title: "Settings", href: "/settings", icon: Settings },
    ],
  },
]

export function MyAppSidebar(props: React.ComponentProps<typeof AppSidebarLayout>) {
  const { 
    currentWorkspace, 
    workspaces, 
    loading, 
    switchWorkspace,
    createWorkspace 
  } = useWorkspace();

  return (
    <AppSidebarLayout
      appName="My App"
      appIcon={Home}
      menuItems={menuItems}
      workspaceSwitcher={
        <WorkspaceSwitcherWithDialog
          currentWorkspace={currentWorkspace}
          workspaces={workspaces}
          loading={loading}
          onSwitch={switchWorkspace}
          onCreate={createWorkspace}
          appName="my app"
        />
      }
      {...props}
    />
  )
}
```

### 2. Use in Your Layout

```typescript
import { SidebarProvider, SidebarInset } from "@weldsuite/ui/components/sidebar"
import { MyAppSidebar } from "@/components/my-app-sidebar"
import { WorkspaceProvider } from "@/contexts/workspace-context"

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <WorkspaceProvider>
      <SidebarProvider>
        <MyAppSidebar />
        <SidebarInset>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </WorkspaceProvider>
  )
}
```

### 3. Implement Workspace Context

Create a workspace context that provides the necessary functions:

```typescript
// contexts/workspace-context.tsx
export function useWorkspace() {
  return {
    currentWorkspace: { id: "1", name: "My Workspace" },
    workspaces: [
      { id: "1", name: "My Workspace" },
      { id: "2", name: "Another Workspace" },
    ],
    loading: false,
    switchWorkspace: async (id: string) => {
      // Implementation
    },
    createWorkspace: async (data) => {
      // Implementation
    },
  }
}
```

## Benefits

1. **Consistency** - All apps have the same sidebar structure and behavior
2. **Reusability** - No need to duplicate sidebar code across apps
3. **Maintainability** - Updates to the sidebar component affect all apps
4. **Flexibility** - Each app can customize menu items and workspace behavior
5. **Type Safety** - Full TypeScript support with proper interfaces

## Migration Guide

To migrate from an existing sidebar to the new components:

1. Import the shared components from `@weldsuite/ui`
2. Define your menu structure as `MenuGroupProps[]`
3. Implement or reuse your workspace context
4. Replace your existing sidebar with `AppSidebarLayout`
5. Add the `WorkspaceSwitcherWithDialog` component
6. Remove old sidebar code

## Customization

You can customize the appearance and behavior by:

- Passing different icons for menu items
- Organizing menu items into logical groups
- Adding footer content for additional controls
- Implementing custom workspace creation logic
- Styling with Tailwind CSS classes via props