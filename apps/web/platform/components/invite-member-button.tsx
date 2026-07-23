
import * as React from 'react';
import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import { InviteMemberDialog } from './invite-member-dialog';
import { useOrganization } from '@clerk/clerk-react';
import { usePermissions } from '@weldsuite/permissions/react';

interface InviteMemberButtonProps {
  collapsed?: boolean;
}

export function InviteMemberButton({ collapsed = false }: InviteMemberButtonProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { can } = usePermissions();
  const { organization } = useOrganization();

  const canManageMembers = can('team:create');

  // Check if there are seats left (if maxAllowedMemberships is set)
  const hasSeatsLeft = organization?.maxAllowedMemberships
    ? organization.membersCount < organization.maxAllowedMemberships
    : true;

  if (!canManageMembers || !hasSeatsLeft) {
    return null;
  }

  if (collapsed) {
    return (
      <div className="mb-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDialogOpen(true)}
              className="h-8 w-8 rounded-md border border-dashed border-muted-foreground/30 text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground transition-colors"
            >
              <UserPlus className="h-4 w-4" />
              <span className="sr-only">Invite members</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Invite members</TooltipContent>
        </Tooltip>
        <InviteMemberDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      </div>
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        onClick={() => setDialogOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-muted-foreground/30 px-3 py-[7px] mb-2 text-sm text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground transition-colors"
      >
        <UserPlus className="h-4 w-4" />
        <span>Invite members</span>
      </Button>
      <InviteMemberDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
