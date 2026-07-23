"use client"

import * as React from "react"
import {
  Bell,
  Globe,
  Keyboard,
  Link,
  Paintbrush,
  Users,
  Building2,
  CreditCard,
  Shield,
  Key,
  Database,
  History,
  Wrench,
  Save,
} from "lucide-react"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./breadcrumb"
import { Button } from "./button"
import {
  Dialog,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./dialog"
import { DialogContentWide } from "./dialog-wide"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
} from "./sidebar"
import { ScrollArea } from "./scroll-area"
import { toast } from "sonner"

// Import section components
import {
  AppearanceSection,
  NotificationsSection,
  SecuritySection,
  UsersSection,
  WorkspacesSection,
  ApiKeysSection,
  IntegrationsSection,
} from "./settings-modal/index"

interface SettingsModalProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  trigger?: React.ReactNode
}

const navigationData = {
  general: [
    { name: "Appearance", icon: Paintbrush, id: "appearance" },
    { name: "Notifications", icon: Bell, id: "notifications" },
    { name: "Language & Region", icon: Globe, id: "language" },
    { name: "Accessibility", icon: Keyboard, id: "accessibility" },
  ],
  management: [
    { name: "Users & Teams", icon: Users, id: "users" },
    { name: "Workspaces", icon: Building2, id: "workspaces" },
    { name: "Billing & Plans", icon: CreditCard, id: "billing" },
  ],
  security: [
    { name: "Security", icon: Shield, id: "security" },
    { name: "API Keys", icon: Key, id: "api-keys" },
    { name: "Audit Log", icon: History, id: "audit" },
  ],
  system: [
    { name: "Integrations", icon: Link, id: "integrations" },
    { name: "Data & Storage", icon: Database, id: "data" },
    { name: "Advanced", icon: Wrench, id: "advanced" },
  ],
}

export function SettingsModal({ open = false, onOpenChange, trigger }: SettingsModalProps) {
  const [activeSection, setActiveSection] = React.useState("appearance")
  const [theme, setTheme] = React.useState<"light" | "dark" | "system">("system")
  const [fontSize, setFontSize] = React.useState(100)
  const [notifications, setNotifications] = React.useState({
    email: true,
    push: true,
    desktop: true,
    sound: true,
  })
  const [security, setSecurity] = React.useState({
    twoFactor: false,
    sessionTimeout: 30,
    loginAlerts: true,
  })

  // Find active section details
  const getActiveSection = () => {
    for (const [category, items] of Object.entries(navigationData)) {
      const section = items.find(item => item.id === activeSection)
      if (section) {
        return { ...section, category }
      }
    }
    return null
  }

  const activeSectionData = getActiveSection()

  const handleSave = () => {
    toast.success("Settings saved", {
      description: "Your changes have been applied successfully.",
    })
  }

  const renderContent = () => {
    switch (activeSection) {
      case "appearance":
        return (
          <AppearanceSection
            theme={theme}
            fontSize={fontSize}
            onThemeChange={setTheme}
            onFontSizeChange={setFontSize}
          />
        )

      case "notifications":
        return (
          <NotificationsSection
            notifications={notifications}
            onNotificationsChange={setNotifications}
          />
        )

      case "users":
        return <UsersSection />

      case "workspaces":
        return <WorkspacesSection />

      case "security":
        return (
          <SecuritySection
            security={security}
            onSecurityChange={setSecurity}
          />
        )

      case "api-keys":
        return <ApiKeysSection />

      case "integrations":
        return <IntegrationsSection />

      default:
        return (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p>Select a setting from the sidebar</p>
          </div>
        )
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && (
        <DialogTrigger asChild>
          {trigger}
        </DialogTrigger>
      )}
      <DialogContentWide className="flex flex-col overflow-hidden p-0">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Customize your application settings and preferences
        </DialogDescription>
        <SidebarProvider className="items-start flex overflow-hidden" style={{ height: "100%" }}>
          <Sidebar collapsible="none" className="hidden md:flex h-full">
            <SidebarContent className="overflow-y-auto h-full">
              <SidebarGroup>
                <SidebarGroupLabel>General</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {navigationData.general.map((item) => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={activeSection === item.id}
                        >
                          <button onClick={() => setActiveSection(item.id)}>
                            <item.icon />
                            <span>{item.name}</span>
                          </button>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>

              <SidebarSeparator />

              <SidebarGroup>
                <SidebarGroupLabel>Management</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {navigationData.management.map((item) => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={activeSection === item.id}
                        >
                          <button onClick={() => setActiveSection(item.id)}>
                            <item.icon />
                            <span>{item.name}</span>
                          </button>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>

              <SidebarSeparator />

              <SidebarGroup>
                <SidebarGroupLabel>Security</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {navigationData.security.map((item) => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={activeSection === item.id}
                        >
                          <button onClick={() => setActiveSection(item.id)}>
                            <item.icon />
                            <span>{item.name}</span>
                          </button>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>

              <SidebarSeparator />

              <SidebarGroup>
                <SidebarGroupLabel>System</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {navigationData.system.map((item) => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={activeSection === item.id}
                        >
                          <button onClick={() => setActiveSection(item.id)}>
                            <item.icon />
                            <span>{item.name}</span>
                          </button>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>

          <main className="flex flex-1 flex-col overflow-hidden">
            <header className="flex h-16 shrink-0 items-center gap-2">
              <div className="flex items-center justify-between w-full px-6">
                <Breadcrumb>
                  <BreadcrumbList>
                    <BreadcrumbItem className="hidden md:block">
                      <BreadcrumbLink href="#">Settings</BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator className="hidden md:block" />
                    <BreadcrumbItem>
                      <BreadcrumbPage>{activeSectionData?.name}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>

                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => onOpenChange?.(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleSave}>
                    <Save className="h-4 w-4 mr-2" />
                    Save Changes
                  </Button>
                </div>
              </div>
            </header>

            <ScrollArea className="flex-1">
              <div className="p-6">
                {renderContent()}
              </div>
            </ScrollArea>
          </main>
        </SidebarProvider>
      </DialogContentWide>
    </Dialog>
  )
}
