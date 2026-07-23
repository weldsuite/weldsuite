import * as React from "react"
import { cn } from "../lib/utils"
import { Home, ShoppingCart, Mail, Calculator, Headphones, Users, Package, Warehouse, FolderOpen, Globe, Workflow, Plus } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip"

export interface AppRoute {
  name: string
  path: string
  icon: React.ReactNode
}

const defaultRoutes: AppRoute[] = [
  {
    name: "Home",
    path: "/",
    icon: <Home className="h-5 w-5" />
  },
  {
    name: "Commerce",
    path: "/commerce",
    icon: <ShoppingCart className="h-5 w-5" />
  },
  {
    name: "Task",
    path: "/task",
    icon: <Workflow className="h-5 w-5" />
  },
  {
    name: "WMS",
    path: "/wms",
    icon: <Warehouse className="h-5 w-5" />
  },
  {
    name: "CRM",
    path: "/crm",
    icon: <Users className="h-5 w-5" />
  },
  {
    name: "Projects",
    path: "/projects",
    icon: <FolderOpen className="h-5 w-5" />
  },
  {
    name: "Accounting",
    path: "/accounting",
    icon: <Calculator className="h-5 w-5" />
  },
  {
    name: "WeldDesk",
    path: "/helpdesk",
    icon: <Headphones className="h-5 w-5" />
  },
  {
    name: "Mail",
    path: "/mail",
    icon: <Mail className="h-5 w-5" />
  },
  {
    name: "Parcel",
    path: "/parcel",
    icon: <Package className="h-5 w-5" />
  },
  {
    name: "Host",
    path: "/host",
    icon: <Globe className="h-5 w-5" />
  }
]

export interface AppSidebarProps {
  routes?: AppRoute[]
  currentPath?: string
  className?: string
}

export function AppSidebar({ routes = defaultRoutes, currentPath = "/", className }: AppSidebarProps) {
  const isActive = (path: string) => {
    if (path === '/') {
      return currentPath === '/'
    }
    return currentPath.startsWith(path)
  }

  return (
    <TooltipProvider>
      <div className={cn(
        "fixed left-0 top-0 h-full w-16 bg-background border-r flex flex-col items-center py-4 gap-2 z-40",
        className
      )}>
        {routes.map((route) => (
          <Tooltip key={route.path}>
            <TooltipTrigger asChild>
              <a
                href={route.path}
                className={cn(
                  "h-12 w-12 flex items-center justify-center rounded-lg transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                  isActive(route.path) && "bg-primary text-primary-foreground"
                )}
              >
                {route.icon}
              </a>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>{route.name}</p>
            </TooltipContent>
          </Tooltip>
        ))}

        <div className="flex-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href="/appstore"
              className={cn(
                "h-12 w-12 flex items-center justify-center rounded-lg transition-colors",
                "hover:bg-accent hover:text-accent-foreground border-2 border-dashed border-muted-foreground/30",
                isActive("/appstore") && "bg-primary text-primary-foreground"
              )}
            >
              <Plus className="h-5 w-5" />
            </a>
          </TooltipTrigger>
          <TooltipContent side="right">
            <p>App Store</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}