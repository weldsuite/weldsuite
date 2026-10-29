
import * as React from 'react';
import { useState, useEffect } from 'react';
import { Loader2, Trash2, Plus, AlertTriangle, Users } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { useI18n } from '@/lib/i18n/provider';
import { useAppApiClient, useAppApi } from '@/lib/api/use-app-api';
import type { Role } from '@/lib/api/types/rbac.types';
import { useRouter } from '@/lib/router';
import { isFeatureAvailable } from '@/lib/edition';
import { useInstalledApps } from '@/hooks/use-installed-apps';

interface PrepaidSeatsInfo {
  prepaidSeats: number;
  usedSeats: number;
  availableSeats: number;
  canAddMore: boolean;
}

interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface InviteEntry {
  id: string;
  email: string;
  name: string;
  roleId: string;
}

interface MemberLimitsInfo {
  limit: number | null;
  current: number;
  atLimit: boolean;
  planName: string;
}

/**
 * Pseudo role value for an EMPLOYEE member (WeldHR): no role, a fixed My HR +
 * WeldChat permission set, and still a paid seat. Sent as memberType, never
 * as a roleId.
 */
const EMPLOYEE_ROLE_VALUE = '__employee';

const newBlankInvite = (roleId = ''): InviteEntry => ({
  id: crypto.randomUUID(),
  email: '',
  name: '',
  roleId,
});

const findRoleByName = (roles: Role[], target: string) =>
  roles.find((r) => r.name.toUpperCase() === target);

/** Prefer Member, then Viewer, otherwise the first available role. */
const pickDefaultRole = (roles: Role[]): Role | undefined =>
  findRoleByName(roles, 'MEMBER') ?? findRoleByName(roles, 'VIEWER') ?? roles[0];

/** Give every invite whose role is no longer available the default role. */
function applyDefaultRole(invites: InviteEntry[], availableRoles: Role[], defaultRole: Role): InviteEntry[] {
  const roleIsAvailable = (roleId: string) => availableRoles.some((r) => r.id === roleId);
  return invites.map((inv) => (roleIsAvailable(inv.roleId) ? inv : { ...inv, roleId: defaultRole.id }));
}

const getRoleLabel = (roleName: string, labels: { owner: string; admin: string; member: string; viewer: string }) => {
  const upper = roleName.toUpperCase();
  switch (upper) {
    case 'OWNER': return labels.owner;
    case 'ADMIN': return labels.admin;
    case 'MEMBER': return labels.member;
    case 'VIEWER': return labels.viewer;
    default:
      return roleName
        .split(/[\s_-]+/)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
        .join(' ');
  }
};

interface MemberLimitNoticesProps {
  memberLimits: MemberLimitsInfo | null;
  prepaidSeats: PrepaidSeatsInfo | null;
  isPaidPlan: boolean;
}

function MemberLimitNotices({ memberLimits, prepaidSeats, isPaidPlan }: Readonly<MemberLimitNoticesProps>) {
  const { t, plural, format } = useI18n();
  const ti = t.common.inviteMember;
  const memberCount = (n: number) => plural(n, ti.memberCount);
  const seatCount = (n: number) => plural(n, ti.seatCount);
  return (
    <>
      {/* Show member limit warning when at limit */}
      {memberLimits?.atLimit && (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{ti.memberLimitReached}</AlertTitle>
          <AlertDescription>
            {format(ti.planAllowsUpTo, { plan: memberLimits.planName, limit: memberCount(memberLimits.limit ?? 0) })}{' '}
            {format(ti.currentlyHave, { current: memberCount(memberLimits.current) })}{' '}
            {ti.upgradeToAddMore}
          </AlertDescription>
        </Alert>
      )}

      {/* Show current member count info when not at limit but has a limit (free plan) */}
      {memberLimits && !memberLimits.atLimit && memberLimits.limit !== null && (
        <p className="text-sm text-muted-foreground mb-4">
          {format(ti.membersUsed, { current: memberLimits.current, limit: memberLimits.limit, plan: memberLimits.planName })}
        </p>
      )}

      {/* Show prepaid seats info for paid plans */}
      {isPaidPlan && prepaidSeats && (
        <div className="mb-4">
          {prepaidSeats.availableSeats > 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="h-4 w-4" />
              <span>
                {format(ti.seatsAvailable, { seats: seatCount(prepaidSeats.availableSeats) })}
                <span className="text-muted-foreground/70"> {format(ti.seatsUsed, { used: prepaidSeats.usedSeats, total: prepaidSeats.prepaidSeats })}</span>
              </span>
            </div>
          ) : (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>{ti.noSeatsAvailable}</AlertTitle>
              <AlertDescription>
                {format(ti.allSeatsInUse, { seats: seatCount(prepaidSeats.prepaidSeats) })}{' '}
                {ti.purchaseMoreSeats}
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </>
  );
}

interface InviteRowProps {
  invite: InviteEntry;
  roles: Role[];
  /** Label for the Employee option; omitted when WeldHR is not installed. */
  employeeLabel?: string;
  isLoading: boolean;
  canRemove: boolean;
  onUpdate: (id: string, field: 'email' | 'name' | 'roleId', value: string) => void;
  onRemove: (id: string) => void;
}

function InviteRow({ invite, roles, employeeLabel, isLoading, canRemove, onUpdate, onRemove }: Readonly<InviteRowProps>) {
  const { t } = useI18n();
  const ti = t.common.inviteMember;
  return (
    <div className="flex gap-2 items-start">
      <div className="flex-1 grid grid-cols-[1fr_1fr_120px] gap-2">
        <Input
          type="email"
          placeholder={t.common.labels.email}
          value={invite.email}
          onChange={(e) => onUpdate(invite.id, 'email', e.target.value)}
          disabled={isLoading}
          className="focus-visible:ring-0 focus-visible:ring-offset-0"
        />
        <Input
          type="text"
          placeholder={t.common.labels.name}
          value={invite.name}
          onChange={(e) => onUpdate(invite.id, 'name', e.target.value)}
          disabled={isLoading}
          className="focus-visible:ring-0 focus-visible:ring-offset-0"
        />
        <Select
          value={invite.roleId}
          onValueChange={(value) => onUpdate(invite.id, 'roleId', value)}
          disabled={isLoading || roles.length === 0}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={ti.rolePlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {roles.map((role) => (
              <SelectItem key={role.id} value={role.id}>
                {getRoleLabel(role.name, ti.roles)}
                {!role.isSystemRole && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    {ti.customRole}
                  </span>
                )}
              </SelectItem>
            ))}
            {employeeLabel && (
              <SelectItem value={EMPLOYEE_ROLE_VALUE}>{employeeLabel}</SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>
      {canRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={() => onRemove(invite.id)}
          disabled={isLoading}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

function sendInvitesLabel(
  invites: InviteEntry[],
  ti: { sendInvitesNone: string; sendInvites: { one: string; other: string } },
  pluralize: (count: number, forms: { one: string; other: string }) => string,
): string {
  const filled = invites.filter((i) => i.email && i.name).length;
  return filled === 0 ? ti.sendInvitesNone : pluralize(filled, ti.sendInvites);
}

export function InviteMemberDialog({ open, onOpenChange }: Readonly<InviteMemberDialogProps>) {
  const [invites, setInvites] = useState<InviteEntry[]>([newBlankInvite()]);
  const [isLoading, setIsLoading] = useState(false);
  const [roles, setRoles] = useState<Role[]>([]);
  const [memberLimits, setMemberLimits] = useState<MemberLimitsInfo | null>(null);
  const [prepaidSeats, setPrepaidSeats] = useState<PrepaidSeatsInfo | null>(null);
  const router = useRouter();
  const t = useTranslations();
  const { t: tr, plural, format } = useI18n();
  const ti = tr.common.inviteMember;
  const tCancel = tr.common.actions.cancel;
  const { getClient } = useAppApiClient();
  const { teamMembers } = useAppApi();
  const { data: installedApps } = useInstalledApps();
  const hrInstalled = (installedApps ?? []).some((app) => app.appCode === 'weldhr');
  const employeeLabel = hrInstalled ? t('sweep.settings.team.inviteAsEmployee') : undefined;

  // Check if this is a paid plan (no hard limit)
  const isPaidPlan = memberLimits !== null && memberLimits.limit === null;

  useEffect(() => {
    if (open) {
      // Load available roles when dialog opens — system + custom, minus OWNER.
      // app-api GET /api/roles (was api-worker GET /settings/roles).
      getClient().then(async (client) => {
        try {
          const result = await client.get<{ data?: Role[] }>('/roles');
          if (result.data) {
            const availableRoles = result.data.filter(
              (r) => r.name.toUpperCase() !== 'OWNER',
            );
            setRoles(availableRoles);

            // Pick a sensible default: prefer Member, then Viewer, otherwise first available
            const defaultRole = pickDefaultRole(availableRoles);
            if (defaultRole) {
              setInvites((prev) => applyDefaultRole(prev, availableRoles, defaultRole));
            }
          }
        } catch {
          // Role list stays empty — the role select is disabled below when empty.
        }
      });

      // Load member limits and prepaid seats info — app-api /api/member-limits
      // and /api/prepaid-seats (were /settings/member-limits and
      // /settings/prepaid-seats).
      getClient().then(async (client) => {
        try {
          const [limitsResult, seatsResult] = await Promise.all([
            client.get<{ data?: MemberLimitsInfo }>('/member-limits'),
            client.get<{ data?: PrepaidSeatsInfo }>('/prepaid-seats'),
          ]);
          if (limitsResult.data) {
            setMemberLimits(limitsResult.data);
          }
          if (seatsResult.data) {
            setPrepaidSeats(seatsResult.data);
          }
        } catch {
          // Member limits / prepaid seats stay null — UI treats null as "no limit info".
        } finally {
        }
      });
    }
  }, [open, getClient]);

  const defaultRoleId = pickDefaultRole(roles)?.id ?? '';

  const addInvite = () => {
    setInvites([...invites, newBlankInvite(defaultRoleId)]);
  };

  const removeInvite = (id: string) => {
    if (invites.length > 1) {
      setInvites(invites.filter(invite => invite.id !== id));
    }
  };

  const updateInvite = (id: string, field: 'email' | 'name' | 'roleId', value: string) => {
    setInvites(invites.map(invite =>
      invite.id === id ? { ...invite, [field]: value } : invite
    ));
  };

  const getValidInvites = () => invites.filter(invite => invite.email.trim() && invite.name.trim() && invite.roleId);

  // Toast one result per invite: a summary for the successes, one error per failure.
  const reportInviteResults = (results: PromiseSettledResult<unknown>[], validInvites: InviteEntry[]) => {
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failures = results
      .map((result, i) => ({ result, invite: validInvites[i] }))
      .filter(({ result }) => result.status === 'rejected');

    if (succeeded > 0) {
      toast.success(plural(succeeded, ti.invitationsSent), {
        description: failures.length > 0 ? format(ti.couldNotBeSent, { count: failures.length }) : undefined,
      });
      resetAndClose();
    }

    // Show a specific toast for each failed invite
    for (const { result, invite } of failures) {
      const message = (result as PromiseRejectedResult).reason?.message;
      toast.error(format(ti.couldNotInvite, { email: invite.email }), {
        description: message || ti.tryAgainLater,
      });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const validInvites = getValidInvites();

    if (validInvites.length === 0) {
      toast.error(ti.fillAtLeastOne);
      return;
    }

    // Check if we have enough prepaid seats for paid plans
    if (isPaidPlan && prepaidSeats && validInvites.length > prepaidSeats.availableSeats) {
      toast.error(ti.notEnoughSeats, {
        description: format(ti.notEnoughSeatsDescription, {
          available: plural(prepaidSeats.availableSeats, ti.seatCount),
          requested: plural(validInvites.length, ti.memberCount),
        }),
      });
      return;
    }

    setIsLoading(true);

    try {
      const results = await Promise.allSettled(
        validInvites.map(invite =>
          teamMembers.inviteMember(
            invite.roleId === EMPLOYEE_ROLE_VALUE
              ? { email: invite.email.trim(), name: invite.name.trim(), memberType: 'EMPLOYEE' }
              : { email: invite.email.trim(), name: invite.name.trim(), roleId: invite.roleId || undefined },
          )
        )
      );
      reportInviteResults(results, validInvites);
    } catch (error) {
      console.error('Error inviting users:', error);
      toast.error(ti.sendFailed, {
        description: error instanceof Error ? error.message : ti.unexpectedError,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleBuyMoreSeats = () => {
    onOpenChange(false);
    router.push('/settings/plans?action=buy-seats');
  };

  const resetAndClose = () => {
    setInvites([newBlankInvite()]);
    setMemberLimits(null);
    setPrepaidSeats(null);
    onOpenChange(false);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Reset form and limits when closing
      setInvites([newBlankInvite()]);
      setMemberLimits(null);
      setPrepaidSeats(null);
    }
    onOpenChange(newOpen);
  };

  const handleUpgrade = () => {
    onOpenChange(false);
    router.push('/settings/plans');
  };

  // Check if user can invite (has available seats for paid plan)
  const noSeatsAvailable = isPaidPlan && prepaidSeats && !prepaidSeats.canAddMore;
  // Edition flags (4.F3): plans and seats are bought through billing.
  const billingAvailable = isFeatureAvailable('billing');

  // Render the invite form body: upgrade / buy-seats prompt or the form itself
  const renderInviteBody = () => {
    if (memberLimits?.atLimit) {
      return (
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            {tCancel}
          </Button>
          {billingAvailable && (
            <Button onClick={handleUpgrade}>
              {ti.upgradePlan}
            </Button>
          )}
        </DialogFooter>
      );
    }
    if (noSeatsAvailable) {
      return (
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            {tCancel}
          </Button>
          {billingAvailable && (
            <Button onClick={handleBuyMoreSeats}>
              {ti.buyMoreSeats}
            </Button>
          )}
        </DialogFooter>
      );
    }
    return (
      <form onSubmit={handleSubmit}>
        <div className="grid gap-4 py-4">
          <div className="space-y-3 max-h-[300px] overflow-y-auto">
            {invites.map((invite) => (
              <InviteRow
                key={invite.id}
                invite={invite}
                roles={roles}
                employeeLabel={employeeLabel}
                isLoading={isLoading}
                canRemove={invites.length > 1}
                onUpdate={updateInvite}
                onRemove={removeInvite}
              />
            ))}
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit text-gray-600"
            onClick={addInvite}
            disabled={isLoading}
          >
            <Plus className="h-4 w-4 mr-1" />
            {ti.addAnother}
          </Button>

        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isLoading}
          >
            {tCancel}
          </Button>
          <Button type="submit" disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {ti.sending}
              </>
            ) : (
              sendInvitesLabel(invites, ti, plural)
            )}
          </Button>
        </DialogFooter>
      </form>
    );
  };

  // Render invite form step
  const renderInviteForm = () => (
    <>
      <DialogHeader>
        <DialogTitle>
          {ti.title}
        </DialogTitle>
      </DialogHeader>

      <MemberLimitNotices memberLimits={memberLimits} prepaidSeats={prepaidSeats} isPaidPlan={isPaidPlan} />

      {renderInviteBody()}
    </>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        {renderInviteForm()}
      </DialogContent>
    </Dialog>
  );
}
