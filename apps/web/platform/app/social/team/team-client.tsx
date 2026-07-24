import { useState } from 'react';
import { Loader2, Users, Plus, Trash2, Edit } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  useSocialTeam,
  useCreateSocialTeamMember,
  useUpdateSocialTeamMember,
  useDeleteSocialTeamMember,
} from '@/hooks/queries/use-social-queries';
import type { SocialTeamMember } from '@weldsuite/app-api-client/domains/social';

const roles = ['owner', 'admin', 'manager', 'editor', 'contributor', 'viewer'];

interface MemberForm {
  email: string;
  name: string;
  role: string;
}

const emptyForm: MemberForm = { email: '', name: '', role: 'editor' };

export function TeamClient() {
  const { t } = useI18n();
  const st = useTranslations();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editMember, setEditMember] = useState<SocialTeamMember | null>(null);
  const [form, setForm] = useState<MemberForm>(emptyForm);

  const { data, isLoading } = useSocialTeam();
  const createMember = useCreateSocialTeamMember();
  const updateMember = useUpdateSocialTeamMember();
  const deleteMember = useDeleteSocialTeamMember();

  const members = data?.data || [];

  const openInvite = () => {
    setEditMember(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (member: SocialTeamMember) => {
    setEditMember(member);
    setForm({ email: member.email || '', name: member.name || '', role: member.role || 'editor' });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    try {
      if (editMember) {
        await updateMember.mutateAsync({ id: editMember.id, ...form });
      } else {
        await createMember.mutateAsync(form as unknown as Record<string, unknown>);
      }
      setDialogOpen(false);
    } catch {
      toast.error(t.social.team.inviteMember);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t.social.team.title}</h1>
        <Button onClick={openInvite}>
          <Plus className="h-4 w-4 mr-2" />
          {t.social.team.inviteMember}
        </Button>
      </div>

      {members.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
          <Users className="h-8 w-8 opacity-20" />
          <p className="text-sm">{t.social.team.noTeamMembers}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {members.map((member: SocialTeamMember) => (
            <Card key={member.id}>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{member.name || member.email}</p>
                  {member.email && member.name && (
                    <p className="text-xs text-muted-foreground">{member.email}</p>
                  )}
                </div>
                <Badge variant="outline" className="text-xs capitalize">
                  {t.social.team.roles[member.role as keyof typeof t.social.team.roles] || member.role}
                </Badge>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => openEdit(member)}>
                    <Edit className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => deleteMember.mutate(member.id)}
                    disabled={deleteMember.isPending}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editMember ? t.social.team.changeRole : t.social.team.inviteMember}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>{st('sweep.miscA.socialTeam.name')}</Label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>{st('sweep.miscA.socialTeam.email')}</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                disabled={!!editMember}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{st('sweep.miscA.socialTeam.role')}</Label>
              <Select value={form.role} onValueChange={(v) => setForm((f) => ({ ...f, role: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t.social.team.roles[r as keyof typeof t.social.team.roles] || r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              {t.social.actions.cancel}
            </Button>
            <Button
              onClick={handleSave}
              disabled={!form.email || createMember.isPending || updateMember.isPending}
            >
              {t.social.actions.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
