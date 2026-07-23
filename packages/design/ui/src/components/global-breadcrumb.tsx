"use client"

import * as React from "react"
import {
  PanelLeftClose,
  PanelLeft,
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
import { Separator } from "./separator"
import { useSidebar } from "./sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip"
import { AiChatDropdown } from "./ai-chat-dropdown"

/**
 * Props for a link component compatible with both `next/link` and the
 * platform's TanStack-Router compat `Link` (both accept `href`).
 */
export interface BreadcrumbLinkComponentProps {
  href: string
  children: React.ReactNode
}

export type BreadcrumbLinkComponent = React.ComponentType<BreadcrumbLinkComponentProps>

/**
 * Default link renderer. Framework-agnostic: a plain anchor. Consumers that
 * want client-side navigation pass their framework's `<Link>` via
 * `linkComponent` (e.g. `next/link` or the platform's `@/lib/router` Link),
 * both of which accept an `href` prop and are therefore drop-in compatible.
 */
function DefaultLink({ href, children }: BreadcrumbLinkComponentProps) {
  return <a href={href}>{children}</a>
}

export interface GlobalBreadcrumbProps {
  /**
   * Current pathname. REQUIRED — the package is framework-agnostic and does
   * not read routing state itself. Callers pass their framework's pathname
   * (e.g. `usePathname()` from next/navigation or from `@/lib/router`).
   * Ignored when `customSegments` is provided.
   */
  pathname: string
  /**
   * Link component used to render navigable breadcrumb links. Must accept an
   * `href` prop. Defaults to a plain `<a href>`. Pass `next/link` (Next apps)
   * or the platform router `Link` (TanStack) for client-side navigation.
   */
  linkComponent?: BreadcrumbLinkComponent
  appName?: string
  basePath?: string
  customSegments?: Array<{
    title: string
    href?: string
  }>
  onAiAction?: (action: any) => void
  onAiSendMessage?: (message: string) => Promise<string>
  onStartStream?: (message: string) => Promise<{ streamId: string }>
  onGetChunks?: (streamId: string, lastIndex: number) => Promise<{
    chunks: any[]
    isComplete: boolean
    error?: string
  }>
  showAiAgent?: boolean
}

export function GlobalBreadcrumb({
  pathname,
  linkComponent,
  appName = "Dashboard",
  basePath = "/",
  customSegments,
  onAiAction,
  onAiSendMessage,
  onStartStream,
  onGetChunks,
  showAiAgent = true,
}: GlobalBreadcrumbProps) {
  const LinkComp: BreadcrumbLinkComponent = linkComponent ?? DefaultLink
  const { toggleSidebar, state } = useSidebar()

  // Generate breadcrumb segments from pathname
  const pathSegments = React.useMemo(() => {
    if (customSegments) {
      return customSegments
    }

    const segments = (pathname ?? "").split("/").filter(Boolean)
    return segments.map((segment, index) => {
      const href = `/${segments.slice(0, index + 1).join("/")}`
      const title = segment
        .split("-")
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ")

      return { title, href }
    })
  }, [pathname, customSegments])

  return (
    <div className="flex items-center justify-between w-full">
      <div className="flex items-center gap-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={toggleSidebar}
              >
                {state === "expanded" ? (
                  <PanelLeftClose className="h-4 w-4" />
                ) : (
                  <PanelLeft className="h-4 w-4" />
                )}
                <span className="sr-only">Toggle Sidebar</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {state === "expanded" ? "Collapse sidebar" : "Expand sidebar"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <Separator orientation="vertical" className="h-4" />

        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <LinkComp href={basePath}>{appName}</LinkComp>
              </BreadcrumbLink>
            </BreadcrumbItem>

            {pathSegments.map((segment, index) => {
              const isLast = index === pathSegments.length - 1

              return (
                <React.Fragment key={segment.href || index}>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    {isLast || !segment.href ? (
                      <BreadcrumbPage>{segment.title}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>
                        <LinkComp href={segment.href}>{segment.title}</LinkComp>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </React.Fragment>
              )
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      {showAiAgent && (
        <AiChatDropdown
          onSendMessage={onAiSendMessage}
          onStartStream={onStartStream}
          onGetChunks={onGetChunks}
          onAction={onAiAction}
        />
      )}
    </div>
  )
}
