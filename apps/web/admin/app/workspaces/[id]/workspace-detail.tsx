import Link from 'next/link';
import { ArrowLeft, Crown, Search, Users } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import type { WorkspaceMemberRow, WorkspaceRow } from '@/lib/workspaces-data';
import { StatusBadge, formatDate } from '../workspace-presentation';

/** `org:admin` → `Admin`. Unknown Clerk roles fall through unchanged. */
function roleLabel(role: string): string {
  const bare = role.replace(/^org:/, '');
  if (!bare) return role;
  return bare[0]!.toUpperCase() + bare.slice(1);
}

function displayName(member: WorkspaceMemberRow): string {
  const full = [member.firstName, member.lastName].filter(Boolean).join(' ').trim();
  return full || member.email;
}

function initials(member: WorkspaceMemberRow): string {
  const source = displayName(member);
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const second = parts.length > 1 ? parts[1]![0]! : '';
  return `${first}${second}`.toUpperCase();
}

export function WorkspaceDetail({
  workspace,
  members,
}: {
  workspace: WorkspaceRow;
  members: WorkspaceMemberRow[];
}) {
  const active = members.filter((m) => m.status === 'ACTIVE');
  const pending = members.filter((m) => m.status === 'PENDING');
  const admins = active.filter((m) => m.role === 'org:admin');

  return (
    <PageContent>
      <PageBody className="space-y-6">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2 text-muted-foreground">
            <Link href="/workspaces">
              <ArrowLeft className="h-4 w-4" />
              All workspaces
            </Link>
          </Button>

          <PageHeading
            title={workspace.name}
            description={
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-xs">{workspace.slug}</span>
                <span aria-hidden>·</span>
                <span className="text-xs">{workspace.planName ?? 'no plan'}</span>
                <span aria-hidden>·</span>
                <span className="text-xs">created {formatDate(workspace.createdAt, false)}</span>
              </span>
            }
            actions={<StatusBadge workspace={workspace} />}
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Active members" value={active.length} />
          <StatCard label="Admins" value={admins.length} />
          <StatCard label="Pending invites" value={pending.length} />
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">
              Members
              <span className="ml-1.5 text-muted-foreground tabular-nums">({members.length})</span>
            </h2>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader className="[&_tr]:border-border/70">
                <TableRow>
                  <TableHead className="text-[13.5px]">Member</TableHead>
                  <TableHead className="w-40 text-[13.5px]">Role</TableHead>
                  <TableHead className="w-32 text-[13.5px]">Status</TableHead>
                  <TableHead className="w-36 text-[13.5px]">Joined</TableHead>
                  <TableHead className="w-36 text-[13.5px]">Invited</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr]:border-border/70">
                {members.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="py-16 text-center text-sm text-muted-foreground"
                    >
                      <Search className="mx-auto mb-2 h-5 w-5 opacity-50" />
                      This workspace has no members yet.
                    </TableCell>
                  </TableRow>
                )}
                {members.map((member) => (
                  <TableRow key={member.id} className="h-12 hover:bg-muted/50">
                    <TableCell className="py-2">
                      <div className="flex items-center gap-2.5">
                        <Avatar className="h-7 w-7">
                          <AvatarImage src={member.imageUrl ?? undefined} alt={displayName(member)} />
                          <AvatarFallback className="text-[11px]">
                            {initials(member)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium">
                              {displayName(member)}
                            </span>
                            {!member.userIsActive && (
                              <Badge variant="outline" className="text-[10px]">
                                deactivated
                              </Badge>
                            )}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {member.email}
                            {member.jobTitle ? ` · ${member.jobTitle}` : ''}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="py-2">
                      <span className="inline-flex items-center gap-1.5 text-sm">
                        {member.role === 'org:admin' && (
                          <Crown className="h-3.5 w-3.5 text-amber-500" />
                        )}
                        {roleLabel(member.role)}
                      </span>
                    </TableCell>
                    <TableCell className="py-2">
                      <Badge variant={member.status === 'ACTIVE' ? 'success' : 'warning'}>
                        {member.status === 'ACTIVE' ? 'Active' : 'Pending'}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-2 text-xs tabular-nums text-muted-foreground">
                      {member.joinedAt ? formatDate(member.joinedAt, false) : '—'}
                    </TableCell>
                    <TableCell className="py-2 text-xs tabular-nums text-muted-foreground">
                      {member.invitedAt ? formatDate(member.invitedAt, false) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <p className="text-xs text-muted-foreground">
            Memberships are owned by Clerk and mirrored into the master database — this screen is
            read-only. Change roles or remove members from the Clerk dashboard.
          </p>
        </div>
      </PageBody>
    </PageContent>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card className="py-4">
      <CardContent className="px-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}
