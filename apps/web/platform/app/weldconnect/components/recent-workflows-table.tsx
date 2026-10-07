
import * as React from "react"
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { EllipsisVertical } from "lucide-react"

import { Button } from "@weldsuite/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@weldsuite/ui/components/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@weldsuite/ui/components/table"
import { Avatar, AvatarFallback } from "@weldsuite/ui/components/avatar"
import { cn } from "@/lib/utils"
import { Link, useRouter } from "@/lib/router"
import { useI18n } from "@/lib/i18n/provider"
import { useTranslations } from "@weldsuite/i18n/client"
import { ExecutionStatusBadge } from "../executions/components/execution-status-badge"

export interface ActivityItem {
  id: string
  workflowId: string
  /** Run status (`completed`, `running`, `failed`, ...), shown as the same badge as the executions list. */
  status: string
  customerName: string
  customerInitial: string
  avatarColor: string
  description: string
  /** Duration of the run, or its error message when it failed. */
  detail?: string
  timestamp: Date
  href: string
}

function formatRelativeTime(
  date: Date | string,
  justNowLabel: string,
  translate: (path: string, params?: Record<string, unknown>) => string,
): string {
  const now = new Date()
  const then = new Date(date)
  const diffMs = now.getTime() - then.getTime()
  const diffMinutes = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffMinutes < 1) return justNowLabel
  if (diffMinutes < 60) {
    return diffMinutes === 1
      ? translate('sweep.weldconnect.recentActivityTable.minuteAgo', { count: diffMinutes })
      : translate('sweep.weldconnect.recentActivityTable.minutesAgo', { count: diffMinutes })
  }
  if (diffHours < 24) {
    return diffHours === 1
      ? translate('sweep.weldconnect.recentActivityTable.hourAgo', { count: diffHours })
      : translate('sweep.weldconnect.recentActivityTable.hoursAgo', { count: diffHours })
  }
  if (diffDays < 7) {
    return diffDays === 1
      ? translate('sweep.weldconnect.recentActivityTable.dayAgo', { count: diffDays })
      : translate('sweep.weldconnect.recentActivityTable.daysAgo', { count: diffDays })
  }
  return then.toLocaleDateString()
}

type ActivityRow = {
  id: string
  workflowId: string
  status: string
  customerName: string
  customerInitial: string
  avatarColor: string
  description: string
  detail: string
  date: string
  href: string
}

type RecentActivityT = ReturnType<typeof useI18n>['t']

// Secondary columns drop out below md; their content moves under the workflow name instead.
const MOBILE_HIDDEN_COLUMNS = new Set(["status", "detail", "date"])

function buildColumns(
  t: RecentActivityT,
  onNavigate: (href: string) => void,
): ColumnDef<ActivityRow>[] {
  return [
    {
      accessorKey: "customerName",
      header: () => <div>{t.weldconnect.components.recentActivity.recentActivity}</div>,
      cell: ({ row }) => {
        return (
          <div className="flex items-center gap-3 min-w-0">
            <Avatar className="h-7 w-7 flex-shrink-0 rounded-md">
              <AvatarFallback className={cn('text-[11px] text-white font-medium rounded-md', row.original.avatarColor)}>
                {row.original.customerInitial}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 -space-y-0.5">
              <div className="font-medium text-sm truncate">{row.original.customerName}</div>
              <div className="text-muted-foreground text-xs truncate">{row.original.description}</div>
              <div className="md:hidden flex items-center gap-2 pt-1.5 text-xs text-muted-foreground">
                <ExecutionStatusBadge status={row.original.status} />
                <span>{row.original.date}</span>
              </div>
            </div>
          </div>
        )
      },
    },
    {
      accessorKey: "status",
      header: t.weldconnect.components.recentActivity.status,
      cell: ({ row }) => <ExecutionStatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "detail",
      header: t.weldconnect.components.recentActivity.detail,
      cell: ({ row }) => (
        <div
          className="text-sm text-muted-foreground max-w-[250px] line-clamp-2 break-words"
          title={row.original.detail || undefined}
        >
          {row.original.detail || '—'}
        </div>
      ),
    },
    {
      accessorKey: "date",
      header: () => <div className="text-right">{t.weldconnect.components.recentActivity.time}</div>,
      cell: ({ row }) => (
        <div className="text-right text-sm text-muted-foreground whitespace-nowrap">{row.original.date}</div>
      ),
    },
    {
      id: "actions",
      enableHiding: false,
      header: () => <div className="text-right"></div>,
      cell: ({ row }) => {
        const activity = row.original

        return (
          <div className="text-right">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-8 w-8 p-0"
                  aria-label={t.weldconnect.components.recentActivity.actions}
                >
                  <EllipsisVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{t.weldconnect.components.recentActivity.actions}</DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => navigator.clipboard.writeText(activity.id)}
                >
                  {t.weldconnect.recentActivityTable.copyId}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onNavigate(`/weldconnect/workflows/${activity.workflowId}`)}>
                  {t.weldconnect.components.recentActivity.viewWorkflow}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onNavigate(activity.href)}>
                  {t.weldconnect.components.recentActivity.viewDetails}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      },
    },
  ]
}

interface ActivityTableProps {
  activities: ActivityItem[]
}

export function RecentActivityTable({ activities }: Readonly<ActivityTableProps>) {
  const router = useRouter()
  const { t } = useI18n()
  const st = useTranslations()

  const columns: ColumnDef<ActivityRow>[] = React.useMemo(
    () => buildColumns(t, (href) => router.push(href)),
    [t, router],
  )

  const data: ActivityRow[] = React.useMemo(() =>
    activities.map(activity => ({
      id: activity.id,
      workflowId: activity.workflowId,
      status: activity.status,
      customerName: activity.customerName,
      customerInitial: activity.customerInitial,
      avatarColor: activity.avatarColor,
      description: activity.description,
      detail: activity.detail || '',
      date: formatRelativeTime(activity.timestamp, t.weldconnect.executions.justNow, st),
      href: activity.href,
    })),
    [activities, t, st]
  )

  // Every row passed in is shown: the dashboard fetches exactly one page of recent runs.
  // No pagination, so no page-index auto-reset: the rows change every second while a
  // run is active, and each reset is a state update that renders the table again.
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    autoResetPageIndex: false,
  })

  return (
    <div className="w-full">
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead
                      key={header.id}
                      className={cn(MOBILE_HIDDEN_COLUMNS.has(header.column.id) && 'hidden md:table-cell')}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  className="cursor-pointer"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('button, [role="menuitem"]')) return
                    router.push(row.original.href)
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn(MOBILE_HIDDEN_COLUMNS.has(cell.column.id) && 'hidden md:table-cell')}
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  {t.weldconnect.components.recentActivity.noActivity}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-end py-4">
        <Button asChild variant="outline" size="sm">
          <Link href="/weldconnect/executions">{t.weldconnect.components.recentActivity.viewAll}</Link>
        </Button>
      </div>
    </div>
  )
}
