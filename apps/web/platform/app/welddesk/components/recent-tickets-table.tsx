
import * as React from "react"
import {
  ColumnDef,
  ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
  VisibilityState,
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
import { useRouter } from "@/lib/router"
import { useI18n } from "@/lib/i18n/provider"

export type ActivityType = 'customer_created' | 'conversation_started' | 'ticket_created' | 'ticket_resolved' | 'review_left'

export interface ActivityItem {
  id: string
  type: ActivityType
  customerName: string
  customerInitial: string
  avatarColor: string
  description: string
  detail?: string
  timestamp: Date
  href: string
}

type ActivityRow = {
  id: string
  type: ActivityType
  customerName: string
  customerInitial: string
  avatarColor: string
  description: string
  detail: string
  date: string
  href: string
}

interface ActivityTableProps {
  activities: ActivityItem[]
}

export function RecentActivityTable({ activities }: ActivityTableProps) {
  const router = useRouter()
  const { t } = useI18n()
  const td = t.helpdesk.dashboard
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({})

  const activityTypeLabels: Record<ActivityType, string> = React.useMemo(() => ({
    conversation_started: td.activityConversation,
    ticket_created: td.activityTicketCreated,
    ticket_resolved: td.activityTicketResolved,
    customer_created: td.activityNewCustomer,
    review_left: td.activityReview,
  }), [td])

  const formatRelativeTime = React.useCallback((date: Date | string): string => {
    const now = new Date()
    const then = new Date(date)
    const diffMs = now.getTime() - then.getTime()
    const diffMinutes = Math.floor(diffMs / (1000 * 60))
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffMinutes < 1) return td.justNow
    if (diffMinutes < 60) return diffMinutes === 1 ? td.minuteAgo.replace('{count}', '1') : td.minutesAgo.replace('{count}', String(diffMinutes))
    if (diffHours < 24) return diffHours === 1 ? td.hourAgo.replace('{count}', '1') : td.hoursAgo.replace('{count}', String(diffHours))
    if (diffDays < 7) return diffDays === 1 ? td.dayAgo.replace('{count}', '1') : td.daysAgo.replace('{count}', String(diffDays))
    return then.toLocaleDateString()
  }, [td])

  const columns: ColumnDef<ActivityRow>[] = React.useMemo(() => [
    {
      accessorKey: "customerName",
      header: () => <div>{td.recentActivity}</div>,
      cell: ({ row }) => {
        return (
          <div className="flex items-center gap-3">
            <Avatar className="h-7 w-7 flex-shrink-0 rounded-md">
              <AvatarFallback className={cn('text-[11px] text-white font-medium rounded-md', row.original.avatarColor)}>
                {row.original.customerInitial}
              </AvatarFallback>
            </Avatar>
            <div className="-space-y-0.5">
              <div className="font-medium text-sm">{row.original.customerName}</div>
              <div className="text-muted-foreground text-xs">{row.original.description}</div>
            </div>
          </div>
        )
      },
    },
    {
      accessorKey: "type",
      header: td.type,
      cell: ({ row }) => (
        <div className="text-sm">{activityTypeLabels[row.original.type]}</div>
      ),
    },
    {
      accessorKey: "detail",
      header: td.detail,
      cell: ({ row }) => (
        <div className="text-sm text-muted-foreground max-w-[250px] truncate">
          {row.original.detail || '—'}
        </div>
      ),
    },
    {
      accessorKey: "date",
      header: () => <div className="text-right">{td.time}</div>,
      cell: ({ row }) => (
        <div className="text-right text-sm text-muted-foreground">{row.original.date}</div>
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
                <Button variant="ghost" className="h-8 w-8 p-0">
                  <span className="sr-only">{td.openMenu}</span>
                  <EllipsisVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{td.actions}</DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => navigator.clipboard.writeText(activity.id)}
                >
                  {td.copyId}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>{td.viewCustomer}</DropdownMenuItem>
                <DropdownMenuItem>{td.viewDetails}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      },
    },
  ], [td, activityTypeLabels])

  const data: ActivityRow[] = React.useMemo(() =>
    activities.map(activity => ({
      id: activity.id,
      type: activity.type,
      customerName: activity.customerName,
      customerInitial: activity.customerInitial,
      avatarColor: activity.avatarColor,
      description: activity.description,
      detail: activity.detail || '',
      date: formatRelativeTime(activity.timestamp),
      href: activity.href,
    })),
    [activities, formatRelativeTime]
  )

  const table = useReactTable({
    data,
    columns,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
    },
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
                    <TableHead key={header.id}>
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
                    <TableCell key={cell.id}>
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
                  No activity found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-end space-x-2 py-4">
        <div className="space-x-2 ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}
