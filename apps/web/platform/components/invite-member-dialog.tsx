
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
import { useAppApiClient, useAppApi } from '@/lib/api/use-app-api';
import type { Role } from '@/lib/api/types/rbac.types';
import { useRouter } from '@/lib/router';

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

export function InviteMemberDialog({ open, onOpenChange }: InviteMemberDialogProps) {
  const [invites, setInvites] = useState<InviteEntry[]>([
    { id: crypto.randomUUID(), email: '', name: '', roleId: '' }
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [roles, setRoles] = useState<Role[]>([]);
  const [memberLimits, setMemberLimits] = useState<MemberLimitsInfo | null>(null);
  const [, setLimitsLoading] = useState(false);
  const [prepaidSeats, setPrepaidSeats] = useState<PrepaidSeatsInfo | null>(null);
  const router = useRouter();
  const { getClient } = useAppApiClient();
  const { teamMembers } = useAppApi();

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
            const findRole = (target: string) =>
              availableRoles.find((r) => r.name.toUpperCase() === target);
            const defaultRole = findRole('MEMBER') ?? findRole('VIEWER') ?? availableRoles[0];
            if (defaultRole) {
              setInvites((prev) =>
                prev.map((inv) =>
                  availableRoles.some((r) => r.id === inv.roleId)
                    ? inv
                    : { ...inv, roleId: defaultRole.id },
                ),
              );
            }
          }
        } catch {
          // Role list stays empty — the role select is disabled below when empty.
        }
      });

      // Load member limits and prepaid seats info — app-api /api/member-limits
      // and /api/prepaid-seats (were /settings/member-limits and
      // /settings/prepaid-seats).
      setLimitsLoading(true);
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
          setLimitsLoading(false);
        }
      });
    }
  }, [open, getClient]);

  const defaultRoleId = (() => {
    const findRole = (target: string) =>
      roles.find((r) => r.name.toUpperCase() === target)?.id;
    return findRole('MEMBER') ?? findRole('VIEWER') ?? roles[0]?.id ?? '';
  })();

  const addInvite = () => {
    setInvites([...invites, { id: crypto.randomUUID(), email: '', name: '', roleId: defaultRoleId }]);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const validInvites = getValidInvites();

    if (validInvites.length === 0) {
      toast.error('Please fill in at least one invitation');
      return;
    }

    // Check if we have enough prepaid seats for paid plans
    if (isPaidPlan && prepaidSeats) {
      if (validInvites.length > prepaidSeats.availableSeats) {
        toast.error(`Not enough seats available`, {
          description: `You have ${prepaidSeats.availableSeats} seat${prepaidSeats.availableSeats !== 1 ? 's' : ''} available but are trying to invite ${validInvites.length} member${validInvites.length !== 1 ? 's' : ''}.`,
        });
        return;
      }
    }

    setIsLoading(true);

    try {
      const results = await Promise.allSettled(
        validInvites.map(invite =>
          teamMembers.inviteMember({
            email: invite.email.trim(),
            name: invite.name.trim(),
            roleId: invite.roleId || undefined,
          })
        )
      );

      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failures = results
        .map((r, i) => ({ result: r, invite: validInvites[i] }))
        .filter(({ result }) => result.status === 'rejected');

      if (succeeded > 0) {
        toast.success(`${succeeded} invitation${succeeded > 1 ? 's' : ''} sent`, {
          description: failures.length > 0 ? `${failures.length} could not be sent` : undefined,
        });
        resetAndClose();
      }

      // Show a specific toast for each failed invite
      for (const { result, invite } of failures) {
        const message = (result as PromiseRejectedResult).reason?.message;
        toast.error(`Could not invite ${invite.email}`, {
          description: message || 'Please try again later',
        });
      }
    } catch (error) {
      console.error('Error inviting users:', error);
      toast.error('Failed to send invitations', {
        description: error instanceof Error ? error.message : 'An unexpected error occurred',
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
    setInvites([{ id: crypto.randomUUID(), email: '', name: '', roleId: '' }]);
    setMemberLimits(null);
    setPrepaidSeats(null);
    onOpenChange(false);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Reset form and limits when closing
      setInvites([{ id: crypto.randomUUID(), email: '', name: '', roleId: '' }]);
      setMemberLimits(null);
      setPrepaidSeats(null);
    }
    onOpenChange(newOpen);
  };

  const handleUpgrade = () => {
    onOpenChange(false);
    router.push('/settings/plans');
  };

  const getRoleLabel = (roleName: string) => {
    const upper = roleName.toUpperCase();
    switch (upper) {
      case 'OWNER': return 'Owner';
      case 'ADMIN': return 'Admin';
      case 'MEMBER': return 'Member';
      case 'VIEWER': return 'Viewer';
      default:
        return roleName
          .split(/[\s_-]+/)
          .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
          .join(' ');
    }
  };

  // Check if user can invite (has available seats for paid plan)
  const noSeatsAvailable = isPaidPlan && prepaidSeats && !prepaidSeats.canAddMore;

  // Render invite form step
  const renderInviteForm = () => (
    <>
      <DialogHeader>
        <DialogTitle>
          Invite Team Members
        </DialogTitle>
      </DialogHeader>

      {/* Show member limit warning when at limit */}
      {memberLimits?.atLimit && (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Member limit reached</AlertTitle>
          <AlertDescription>
            Your {memberLimits.planName} plan allows up to {memberLimits.limit} member{memberLimits.limit !== 1 ? 's' : ''}.
            You currently have {memberLimits.current} member{memberLimits.current !== 1 ? 's' : ''}.
            Upgrade your plan to add more team members.
          </AlertDescription>
        </Alert>
      )}

      {/* Show current member count info when not at limit but has a limit (free plan) */}
      {memberLimits && !memberLimits.atLimit && memberLimits.limit !== null && (
        <p className="text-sm text-muted-foreground mb-4">
          {memberLimits.current} of {memberLimits.limit} members used on your {memberLimits.planName} plan.
        </p>
      )}

      {/* Show prepaid seats info for paid plans */}
      {isPaidPlan && prepaidSeats && (
        <div className="mb-4">
          {prepaidSeats.availableSeats > 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="h-4 w-4" />
              <span>
                {prepaidSeats.availableSeats} seat{prepaidSeats.availableSeats !== 1 ? 's' : ''} available
                <span className="text-muted-foreground/70"> ({prepaidSeats.usedSeats}/{prepaidSeats.prepaidSeats} used)</span>
              </span>
            </div>
          ) : (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>No seats available</AlertTitle>
              <AlertDescription>
                All {prepaidSeats.prepaidSeats} seat{prepaidSeats.prepaidSeats !== 1 ? 's' : ''} are in use.
                Purchase more seats to invite members.
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}

      {memberLimits?.atLimit ? (
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button onClick={handleUpgrade}>
            Upgrade Plan
          </Button>
        </DialogFooter>
      ) : noSeatsAvailable ? (
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button onClick={handleBuyMoreSeats}>
            Buy More Seats
          </Button>
        </DialogFooter>
      ) : (
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="space-y-3 max-h-[300px] overflow-y-auto">
              {invites.map((invite) => (
                <div key={invite.id} className="flex gap-2 items-start">
                  <div className="flex-1 grid grid-cols-[1fr_1fr_120px] gap-2">
                    <Input
                      type="email"
                      placeholder="Email"
                      value={invite.email}
                      onChange={(e) => updateInvite(invite.id, 'email', e.target.value)}
                      disabled={isLoading}
                      className="focus-visible:ring-0 focus-visible:ring-offset-0"
                    />
                    <Input
                      type="text"
                      placeholder="Name"
                      value={invite.name}
                      onChange={(e) => updateInvite(invite.id, 'name', e.target.value)}
                      disabled={isLoading}
                      className="focus-visible:ring-0 focus-visible:ring-offset-0"
                    />
                    <Select
                      value={invite.roleId}
                      onValueChange={(value) => updateInvite(invite.id, 'roleId', value)}
                      disabled={isLoading || roles.length === 0}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Role" />
                      </SelectTrigger>
                      <SelectContent>
                        {roles.map((role) => (
                          <SelectItem key={role.id} value={role.id}>
                            {getRoleLabel(role.name)}
                            {!role.isSystemRole && (
                              <span className="ml-1 text-xs text-muted-foreground">
                                (Custom)
                              </span>
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {invites.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      onClick={() => removeInvite(invite.id)}
                      disabled={isLoading}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
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
              Add another
            </Button>

          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                `Send ${invites.filter(i => i.email && i.name).length || ''} Invite${invites.filter(i => i.email && i.name).length !== 1 ? 's' : ''}`
              )}
            </Button>
          </DialogFooter>
        </form>
      )}
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
