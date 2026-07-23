
import * as React from "react"
import { useTranslations } from '@weldsuite/i18n/client'
import {
  Search,
  Plus,
  Crown,
  MoreVertical,
  Mail,
  Trash2,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  ArrowUpRight,
} from "lucide-react"
import { Button } from "@weldsuite/ui/components/button"
import { Input } from "@weldsuite/ui/components/input"
import { Avatar, AvatarFallback, AvatarImage } from "@weldsuite/ui/components/avatar"
import { StatusDot } from "@weldsuite/ui/components/status-dot"
import { usePresence } from "@/contexts/presence-context"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@weldsuite/ui/components/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@weldsuite/ui/components/dropdown-menu"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useAppApiClient } from '@/lib/api/use-app-api'
import { InviteMemberDialog } from "@/components/invite-member-dialog"
import { Alert, AlertDescription } from "@weldsuite/ui/components/alert"
import { Progress } from "@weldsuite/ui/components/progress"
import { Link } from '@/lib/router';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import { useWorkspaceRoles } from '@/hooks/queries/use-settings-queries';

export interface TeamMember {
  id: string
  auth0Id?: string | null
  userId?: string | null
  email: string
  name?: string | null
  picture?: string | null
  role: "USER" | "ADMIN" | "MERCHANT" | "SUPER_ADMIN"
  workspaceRole?: string
  workspaceRoleId?: string | null
  status?: "ACTIVE" | "PENDING" | "INACTIVE" | "SUSPENDED" | "DELETED"
  memberType?: "INTERNAL" | "EXTERNAL_GUEST"
  hoursPerWeek?: string | null
  createdAt: Date
  workspaces?: Array<{
    id: string
    name: string
    slug: string
  }>
}

function MemberAvatarWithPresence({ user }: { user: TeamMember }) {
  const { getStatus } = usePresence();
  const presence = user.userId ? getStatus(user.userId) : undefined;
  return (
    <div className="relative inline-flex">
      <Avatar className="h-[22px] w-[22px] rounded-md">
        {user.picture && (
          <AvatarImage
            src={user.picture}
            alt={user.name || user.email}
            className="rounded-md"
          />
        )}
        <AvatarFallback className="rounded-md text-xs">
          {(user.name?.[0] || user.email?.[0] || '?').toUpperCase()}
        </AvatarFallback>
      </Avatar>
      {user.userId ? (
        <span className="absolute -bottom-0.5 -right-0.5">
          <StatusDot status={presence?.status ?? 'offline'} size="sm" showTooltip />
        </span>
      ) : null}
    </div>
  );
}

interface TeamSectionProps {
  users: TeamMember[]
  currentPage: number
  totalPages: number
  totalCount: number
  pageSize: number
  searchQuery: string
  canManageMembers?: boolean
  currentUserId?: string | null
  onSearchChange: (query: string) => void
  onPageChange: (page: number) => void
  onViewMember: (memberId: string) => void
  onDeleteMember: (memberId: string) => void
  onMemberInvited?: () => void
  memberLimit?: number | null // null = unlimited
  planName?: string
}

export function TeamSection({
  users,
  currentPage,
  totalPages,
  totalCount,
  pageSize,
  searchQuery,
  canManageMembers = true,
  currentUserId,
  onSearchChange,
  onPageChange,
  onViewMember,
  onDeleteMember,
  onMemberInvited,
  memberLimit,
  planName,
}: TeamSectionProps) {
  const t = useTranslations()
  const [inviteDialogOpen, setInviteDialogOpen] = React.useState(false)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [activeFilters, setActiveFilters] = React.useState<ActiveFilter[]>([])
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const { getClient } = useAppApiClient()

  // Resolve custom role display: when a member has a `workspaceRoleId` set,
  // show the role's actual name instead of the underlying system tier.
  const { data: rolesData } = useWorkspaceRoles(canManageMembers)
  const customRoleNameById = React.useMemo(() => {
    const map: Record<string, string> = {}
    for (const role of rolesData?.data ?? []) {
      if (!role.isSystemRole) map[role.id] = role.name
    }
    return map
  }, [rolesData])

  const filterConfigs: FilterConfig[] = React.useMemo(() => [
    {
      field: 'role',
      label: t('sweep.settings.team.filters.role'),
      options: [
        { value: 'OWNER', label: t('sweep.settings.team.roles.owner') },
        { value: 'ADMIN', label: t('sweep.settings.team.roles.admin') },
        { value: 'MEMBER', label: t('sweep.settings.team.roles.member') },
        { value: 'VIEWER', label: t('sweep.settings.team.roles.viewer') },
      ],
    },
    {
      field: 'status',
      label: t('sweep.settings.team.filters.status'),
      options: [
        { value: 'ACTIVE', label: t('sweep.settings.team.status.active') },
        { value: 'PENDING', label: t('sweep.settings.team.status.pending') },
        { value: 'INACTIVE', label: t('sweep.settings.team.status.inactive') },
      ],
    },
  ], [t])

  // Calculate member limit status
  const isAtLimit = memberLimit !== null && memberLimit !== undefined && totalCount >= memberLimit
  const isNearLimit = memberLimit !== null && memberLimit !== undefined && totalCount >= memberLimit * 0.8 && !isAtLimit
  const usagePercentage = memberLimit ? Math.min(100, (totalCount / memberLimit) * 100) : 0
  const filteredUsers = React.useMemo(() => {
    let result = users

    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      result = result.filter(
        (user) =>
          user.name?.toLowerCase().includes(query) ||
          user.email.toLowerCase().includes(query)
      )
    }

    if (activeFilters.length > 0) {
      result = result.filter((user) =>
        activeFilters.every((filter) => {
          if (!filter.value) return true
          switch (filter.field) {
            case 'role': {
              const role = user.workspaceRole || (user.role === 'ADMIN' ? 'ADMIN' : 'MEMBER')
              const match = role === filter.value
              return filter.operator === 'is not' ? !match : match
            }
            case 'status': {
              const status = (user.status === 'PENDING' || (!user.auth0Id && user.status !== 'ACTIVE')) ? 'PENDING' : (user.status || 'ACTIVE')
              const match = status === filter.value
              return filter.operator === 'is not' ? !match : match
            }
            default:
              return true
          }
        })
      )
    }

    return result
  }, [users, searchQuery, activeFilters])

  const handleResendInvite = async (user: TeamMember) => {
    try {
      const client = await getClient()
      // app-api POST /api/team-members/:id/resend-invite (was api-worker
      // /settings/members/:id/resend-invite). Failures throw rather than
      // resolving with `success: false`.
      await client.post<{ data: { success: boolean } }>(`/team-members/${user.id}/resend-invite`, {})
      toast.success(t('sweep.settings.team.inviteResent', { email: user.email }))
    } catch (error) {
      toast.error(t('settings.team.messages.inviteResendFailed'))
      console.error("Error resending invite:", error)
    }
  }

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('sweep.settings.team.title')}</h1>
        <p className="text-muted-foreground">{t('sweep.settings.team.description')}</p>
      </div>

      {/* Member Limit Warning */}
      {isAtLimit && (
        <Alert variant="destructive" className="border-destructive/50 bg-destructive/5">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between">
            <span>
              {t('sweep.settings.team.limitReached', { count: memberLimit })}
              {planName && ` (${t('sweep.settings.team.planSuffix', { plan: planName })})`}
            </span>
            <Button variant="outline" size="sm" asChild className="ml-4">
              <Link href="/settings/plans">
                {t('sweep.settings.team.upgradePlan')}
                <ArrowUpRight className="h-3 w-3 ml-1" />
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {isNearLimit && (
        <Alert className="border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/30">
          <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
          <AlertDescription className="flex items-center justify-between text-yellow-700 dark:text-yellow-400">
            <span>
              {t('sweep.settings.team.nearLimit', { count: totalCount, max: memberLimit, percent: Math.round(usagePercentage) })}
            </span>
            <Button variant="outline" size="sm" asChild className="ml-4 border-yellow-300 hover:bg-yellow-100 dark:border-yellow-700 dark:hover:bg-yellow-900">
              <Link href="/settings/plans">
                {t('sweep.settings.team.viewPlans')}
                <ArrowUpRight className="h-3 w-3 ml-1" />
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Member Usage Progress (when there's a limit) */}
      {memberLimit !== null && memberLimit !== undefined && !isAtLimit && !isNearLimit && (
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span>{t('sweep.settings.team.usageOfLimit', { count: totalCount, max: memberLimit })}</span>
          <Progress value={usagePercentage} className="w-32 h-2" />
        </div>
      )}

      <div>
      <div className="flex items-center justify-end mb-4 gap-2">
        {/* Filter Pills */}
        <FilterPills
          filters={activeFilters}
          filterConfigs={filterConfigs}
          maxFilters={3}
          onFiltersChange={setActiveFilters}
        />
        <div className="flex-1" />
        {/* Expandable Search */}
        <div className="relative flex items-center">
          <div
            className={cn(
              "flex items-center transition-all duration-200 ease-out",
              searchOpen ? "w-48" : "w-8"
            )}
          >
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "h-8 w-8 p-0 flex-shrink-0 shadow-none transition-opacity duration-200",
                searchOpen && "opacity-0 pointer-events-none absolute"
              )}
              onClick={() => {
                setSearchOpen(true)
                setTimeout(() => searchInputRef.current?.focus(), 50)
              }}
            >
              <Search className="h-4 w-4" />
            </Button>
            <div className={cn(
              "relative transition-all duration-200 ease-out",
              searchOpen ? "opacity-100 w-48" : "opacity-0 w-0 pointer-events-none"
            )}>
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder={t('sweep.settings.team.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                onBlur={() => {
                  if (!searchQuery) setSearchOpen(false)
                }}
                className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
              />
            </div>
          </div>
        </div>
        {canManageMembers && (
          <>
            {isAtLimit && (
              <Button variant="outline" size="sm" asChild>
                <Link href="/settings/plans">
                  <ArrowUpRight className="h-3 w-3 mr-1" />
                  {t('sweep.settings.team.upgrade')}
                </Link>
              </Button>
            )}
            <Button
              onClick={() => setInviteDialogOpen(true)}
              className="h-8 text-sm px-3 flex items-center gap-2 shadow-none"
              disabled={isAtLimit}
              title={isAtLimit ? t('sweep.settings.team.limitReachedTooltip', { count: memberLimit }) : undefined}
            >
              <Plus className="h-4 w-4" />
              {t('sweep.settings.team.inviteMember')}
            </Button>
          </>
        )}
        <InviteMemberDialog
          open={inviteDialogOpen}
          onOpenChange={(open) => {
            setInviteDialogOpen(open)
            if (!open && onMemberInvited) {
              onMemberInvited()
            }
          }}
        />
      </div>

      <div className="rounded-md border border-border/70 overflow-hidden">
        <Table>
          <TableHeader className="[&_tr]:border-border/70">
            <TableRow>
              <TableHead className="text-[13.5px]">{t('sweep.settings.team.table.member')}</TableHead>
              <TableHead className="text-[13.5px]">{t('sweep.settings.team.table.email')}</TableHead>
              <TableHead className="text-[13.5px]">{t('sweep.settings.team.table.role')}</TableHead>
              <TableHead className="text-[13.5px]">{t('sweep.settings.team.table.teams')}</TableHead>
              <TableHead className="w-12 text-[13.5px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr]:border-border/70">
            {filteredUsers.map((user) => (
              <TableRow
                key={user.id}
                className="group h-10 cursor-pointer hover:bg-muted/50"
                onClick={() => onViewMember(user.id)}
              >
                <TableCell className="py-2">
                  <div className="flex items-center gap-2">
                    <MemberAvatarWithPresence user={user} />
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{user.name || t('sweep.settings.team.unknown')}</span>
                      {user.workspaceRole === "OWNER" && (
                        <Crown className="h-3.5 w-3.5 text-amber-500" />
                      )}
                      {(user.status === "PENDING" || (!user.auth0Id && user.status !== "ACTIVE")) && (
                        <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-yellow-50 text-yellow-700 dark:bg-yellow-950/30 dark:text-yellow-400">
                          {t('sweep.settings.team.status.pending')}
                        </span>
                      )}
                      {user.memberType === "EXTERNAL_GUEST" && (
                        <span
                          className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                          title={t('sweep.settings.team.guestTooltip')}
                        >
                          {t('sweep.settings.team.guest')}
                        </span>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="py-2 text-sm text-muted-foreground">
                  {user.email}
                </TableCell>
                <TableCell className="py-2">
                  {(() => {
                    // Custom role wins if assigned (workspaceRoleId is the
                    // source of truth — `workspaceRole` is just the system
                    // tier we keep around for Clerk sync + fallback).
                    const customRoleName = user.workspaceRoleId
                      ? customRoleNameById[user.workspaceRoleId]
                      : undefined
                    if (customRoleName) {
                      return (
                        <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
                          {customRoleName}
                        </span>
                      )
                    }
                    return (
                      <span
                        className={cn(
                          "inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none",
                          user.workspaceRole === "OWNER"
                            ? "bg-purple-50 text-purple-700 dark:bg-purple-950/30 dark:text-purple-400"
                            : user.workspaceRole === "ADMIN"
                            ? "bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400"
                            : user.workspaceRole === "MEMBER"
                            ? "bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400"
                            : user.workspaceRole === "VIEWER"
                            ? "bg-gray-50 text-gray-700 dark:bg-background/30 dark:text-muted-foreground"
                            : "bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400"
                        )}
                      >
                        {user.workspaceRole === "OWNER"
                          ? t('sweep.settings.team.roles.owner')
                          : user.workspaceRole === "ADMIN"
                          ? t('sweep.settings.team.roles.admin')
                          : user.workspaceRole === "MEMBER"
                          ? t('sweep.settings.team.roles.member')
                          : user.workspaceRole === "VIEWER"
                          ? t('sweep.settings.team.roles.viewer')
                          : user.role === "ADMIN"
                          ? t('sweep.settings.team.roles.admin')
                          : t('sweep.settings.team.roles.member')}
                      </span>
                    )
                  })()}
                </TableCell>
                <TableCell className="py-2">
                  <div className="flex flex-wrap gap-1">
                    {user.workspaces && user.workspaces.length > 0 ? (
                      user.workspaces.map((workspace) => (
                        <span
                          key={workspace.id}
                          className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-secondary text-secondary-foreground"
                        >
                          {workspace.name}
                        </span>
                      ))
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        {t('sweep.settings.team.noTeams')}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="py-2" onClick={(e) => e.stopPropagation()}>
                  <div className="h-8 w-8 flex items-center justify-center">
                    {canManageMembers && user.workspaceRole !== "OWNER" && user.userId !== currentUserId && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 rounded-lg opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        {(user.status === "PENDING" || (!user.auth0Id && user.status !== "ACTIVE")) && (
                          <>
                            <DropdownMenuItem
                              onClick={() => handleResendInvite(user)}
                            >
                              <Mail className="h-4 w-4 mr-0.5" />
                              {t('sweep.settings.team.resendInvite')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                          </>
                        )}
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => onDeleteMember(user.id)}
                        >
                          <Trash2 className="h-4 w-4 mr-0.5" />
                          {user.status === "PENDING" || (!user.auth0Id && user.status !== "ACTIVE") ? t('sweep.settings.team.cancelInvite') : t('sweep.settings.team.removeMember')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {filteredUsers.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center py-12 text-muted-foreground"
                >
                  {t('sweep.settings.team.noMembersFound')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <div className="text-sm text-muted-foreground">
            {t('sweep.settings.team.paginationShowing', {
              from: (currentPage - 1) * pageSize + 1,
              to: Math.min(currentPage * pageSize, totalCount),
              total: totalCount,
            })}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(Math.max(1, currentPage - 1))}
              disabled={currentPage === 1}
            >
              <ChevronLeft className="h-4 w-4" />
              {t('sweep.settings.team.previous')}
            </Button>
            <div className="text-sm">
              {t('sweep.settings.team.pageOf', { page: currentPage, total: totalPages })}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage === totalPages}
            >
              {t('sweep.settings.team.next')}
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
