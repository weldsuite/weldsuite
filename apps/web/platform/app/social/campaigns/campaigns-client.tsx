import { useState } from 'react';
import { Loader2, Megaphone, Edit, Trash2, Plus } from 'lucide-react';
import { format as formatDate } from 'date-fns';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
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
  useSocialCampaigns,
  useCreateSocialCampaign,
  useUpdateSocialCampaign,
  useDeleteSocialCampaign,
} from '@/hooks/queries/use-social-queries';
import type { SocialCampaign } from '@weldsuite/app-api-client/domains/social';

const statusVariants: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  draft: 'secondary',
  active: 'default',
  paused: 'outline',
  completed: 'default',
  archived: 'secondary',
};

const campaignStatuses = ['draft', 'active', 'paused', 'completed', 'archived'];

interface CampaignForm {
  name: string;
  description: string;
  color: string;
  status: string;
  startDate: string;
  endDate: string;
}

const emptyForm: CampaignForm = {
  name: '',
  description: '',
  color: '#6366f1',
  status: 'draft',
  startDate: '',
  endDate: '',
};

export function CampaignsClient() {
  const { t } = useI18n();
  const st = useTranslations();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editCampaign, setEditCampaign] = useState<SocialCampaign | null>(null);
  const [form, setForm] = useState<CampaignForm>(emptyForm);

  const { data, isLoading } = useSocialCampaigns();
  const createCampaign = useCreateSocialCampaign();
  const updateCampaign = useUpdateSocialCampaign();
  const deleteCampaign = useDeleteSocialCampaign();

  const campaigns = data?.data || [];

  const openCreate = () => {
    setEditCampaign(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (campaign: SocialCampaign) => {
    setEditCampaign(campaign);
    setForm({
      name: campaign.name || '',
      description: campaign.description || '',
      color: campaign.color || '#6366f1',
      status: campaign.status || 'draft',
      startDate: campaign.startDate ? campaign.startDate.slice(0, 10) : '',
      endDate: campaign.endDate ? campaign.endDate.slice(0, 10) : '',
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    try {
      if (editCampaign) {
        await updateCampaign.mutateAsync({ id: editCampaign.id, ...form });
      } else {
        await createCampaign.mutateAsync(form as unknown as Record<string, unknown>);
      }
      setDialogOpen(false);
    } catch {
      toast.error(t.social.campaigns.createCampaign);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteCampaign.mutateAsync(id);
    } catch {
      // ignore
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
        <h1 className="text-2xl font-semibold">{t.social.campaigns.title}</h1>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" />
          {t.social.campaigns.newCampaign}
        </Button>
      </div>

      {campaigns.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
          <Megaphone className="h-8 w-8 opacity-20" />
          <p className="text-sm">{t.social.campaigns.noCampaigns}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {campaigns.map((campaign: SocialCampaign) => (
            <Card key={campaign.id}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  {campaign.color && (
                    <div
                      className="w-3 h-3 rounded-full mt-1 shrink-0"
                      style={{ backgroundColor: campaign.color }}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">{campaign.name}</h3>
                      <Badge variant={statusVariants[campaign.status] || 'secondary'} className="text-xs">
                        {t.social.campaigns.statuses[campaign.status as keyof typeof t.social.campaigns.statuses] || campaign.status}
                      </Badge>
                    </div>
                    {campaign.description && (
                      <p className="text-xs text-muted-foreground mt-1">{campaign.description}</p>
                    )}
                    {(campaign.startDate || campaign.endDate) && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {campaign.startDate ? formatDate(new Date(campaign.startDate), 'MMM d') : '?'}
                        {' — '}
                        {campaign.endDate ? formatDate(new Date(campaign.endDate), 'MMM d, yyyy') : '?'}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(campaign)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => handleDelete(campaign.id)}
                      disabled={deleteCampaign.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
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
              {editCampaign ? t.social.campaigns.editCampaign : t.social.campaigns.createCampaign}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>{t.social.campaigns.campaignName}</Label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>{st('sweep.miscA.socialCampaigns.description')}</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={2}
              />
            </div>
            <div className="flex gap-4">
              <div className="space-y-1.5 flex-1">
                <Label>{st('sweep.miscA.socialCampaigns.color')}</Label>
                <Input
                  type="color"
                  value={form.color}
                  onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5 flex-1">
                <Label>{st('sweep.miscA.socialCampaigns.status')}</Label>
                <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {campaignStatuses.map((s) => (
                      <SelectItem key={s} value={s}>
                        {t.social.campaigns.statuses[s as keyof typeof t.social.campaigns.statuses] || s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex gap-4">
              <div className="space-y-1.5 flex-1">
                <Label>{t.social.campaigns.startDate}</Label>
                <Input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5 flex-1">
                <Label>{t.social.campaigns.endDate}</Label>
                <Input
                  type="date"
                  value={form.endDate}
                  onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              {t.social.actions.cancel}
            </Button>
            <Button onClick={handleSave} disabled={!form.name || createCampaign.isPending || updateCampaign.isPending}>
              {t.social.actions.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
