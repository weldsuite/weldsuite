
import { useState } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Plus, Trash2, Edit2, Check, X, Settings2, Info } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Switch } from '@weldsuite/ui/components/switch';
import { Slider } from '@weldsuite/ui/components/slider';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@weldsuite/ui/components/card';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { toast } from 'sonner';
import { Mail } from '@/lib/api/types/apps/mail.types';
import {
  useCreateMailLabel,
  useUpdateMailLabel,
  useDeleteMailLabel,
} from '@/hooks/queries/use-mail-queries';
import { useI18n } from '@/lib/i18n/provider';

const LABEL_COLORS = [
  { key: 'colorRed', value: '#EF4444' },
  { key: 'colorOrange', value: '#F97316' },
  { key: 'colorYellow', value: '#EAB308' },
  { key: 'colorGreen', value: '#22C55E' },
  { key: 'colorTeal', value: '#14B8A6' },
  { key: 'colorBlue', value: '#3B82F6' },
  { key: 'colorPurple', value: '#8B5CF6' },
  { key: 'colorPink', value: '#EC4899' },
] as const;

interface LabelsClientProps {
  initialLabels: Mail.Label[];
  accountId: string;
}

export function LabelsClient({ initialLabels, accountId }: LabelsClientProps) {
  const createLabelMutation = useCreateMailLabel();
  const updateLabelMutation = useUpdateMailLabel();
  const deleteLabelMutation = useDeleteMailLabel();
  const { t } = useI18n();

  useBreadcrumbs([
    { label: t.mail.inboxPage.mailBreadcrumb, href: '/weldmail' },
    { label: t.mail.sidebar.settings, href: '/weldmail/settings' },
    { label: t.mail.search.labels }
  ]);

  const [labels, setLabels] = useState<Mail.Label[]>(initialLabels);
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [deleteLabel, setDeleteLabel] = useState<Mail.Label | null>(null);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  const [newLabelColor, setNewLabelColor] = useState(LABEL_COLORS[5].value); // Default blue

  // AI Auto-Labeling state
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiKeywords, setAiKeywords] = useState('');
  const [aiDescription, setAiDescription] = useState('');
  const [aiConfidence, setAiConfidence] = useState(70);

  // Edit dialog state
  const [editDialogLabel, setEditDialogLabel] = useState<Mail.Label | null>(null);
  const [editDialogName, setEditDialogName] = useState('');
  const [editDialogColor, setEditDialogColor] = useState('');
  const [editDialogAiEnabled, setEditDialogAiEnabled] = useState(false);
  const [editDialogAiKeywords, setEditDialogAiKeywords] = useState('');
  const [editDialogAiDescription, setEditDialogAiDescription] = useState('');
  const [editDialogAiConfidence, setEditDialogAiConfidence] = useState(70);

  const isCreating = createLabelMutation.isPending;
  const isUpdating = updateLabelMutation.isPending;

  const handleCreateLabel = () => {
    const name = newLabelName.trim();

    if (!name) {
      toast.error(t.mail.settingsLabels.labelNameEmpty);
      return;
    }

    if (labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      toast.error(t.mail.settingsLabels.labelNameExists);
      return;
    }

    // Parse keywords from comma-separated string
    const keywords = aiKeywords
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    createLabelMutation.mutate(
      {
        accountId,
        name,
        color: newLabelColor,
        aiEnabled,
        aiKeywords: keywords,
        aiDescription: aiDescription.trim() || undefined,
        aiConfidence: aiEnabled ? aiConfidence : undefined,
      },
      {
        onSuccess: (result) => {
          const created = result.data as Record<string, unknown>;
          const newLabel: Mail.Label = {
            id: created.id as string,
            name: created.name as string,
            color: created.color as string,
            count: (created.messageCount as number | undefined) ?? 0,
            aiEnabled: created.aiEnabled as boolean | undefined,
            aiKeywords: created.aiKeywords as string[] | undefined,
            aiDescription: created.aiDescription as string | undefined,
            aiConfidence: created.aiConfidence as number | undefined,
          };
          setLabels((prev) => [...prev, newLabel]);
          toast.success(t.mail.settingsLabels.labelCreatedSuccessfully);
          setIsCreateDialogOpen(false);
          // Reset form
          setNewLabelName('');
          setNewLabelColor(LABEL_COLORS[5].value);
          setAiEnabled(false);
          setAiKeywords('');
          setAiDescription('');
          setAiConfidence(70);
        },
        onError: (err: unknown) => {
          const message = err instanceof Error ? err.message : undefined;
          toast.error(message ?? t.mail.settingsLabels.failedToCreateLabel);
        },
      },
    );
  };

  const handleOpenEditDialog = (label: Mail.Label) => {
    setEditDialogLabel(label);
    setEditDialogName(label.name);
    setEditDialogColor(label.color || LABEL_COLORS[5].value);
    setEditDialogAiEnabled(label.aiEnabled || false);
    setEditDialogAiKeywords(label.aiKeywords?.join(', ') || '');
    setEditDialogAiDescription(label.aiDescription || '');
    setEditDialogAiConfidence(label.aiConfidence ?? 70);
  };

  const handleCloseEditDialog = () => {
    setEditDialogLabel(null);
    setEditDialogName('');
    setEditDialogColor('');
    setEditDialogAiEnabled(false);
    setEditDialogAiKeywords('');
    setEditDialogAiDescription('');
    setEditDialogAiConfidence(70);
  };

  const handleUpdateLabel = () => {
    if (!editDialogLabel?.id) return;

    const name = editDialogName.trim();
    if (!name) {
      toast.error(t.mail.settingsLabels.labelNameEmpty);
      return;
    }

    if (labels.some((l) => l.name !== editDialogLabel.name && l.name.toLowerCase() === name.toLowerCase())) {
      toast.error(t.mail.settingsLabels.labelNameExists);
      return;
    }

    const keywords = editDialogAiKeywords
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    updateLabelMutation.mutate(
      {
        id: editDialogLabel.id,
        name,
        color: editDialogColor,
        aiEnabled: editDialogAiEnabled,
        aiKeywords: keywords,
        aiDescription: editDialogAiDescription.trim() || null,
        aiConfidence: editDialogAiEnabled ? editDialogAiConfidence : undefined,
      },
      {
        onSuccess: (result) => {
          const updated = result.data as Record<string, unknown>;
          const updatedLabel: Mail.Label = {
            id: updated.id as string,
            name: updated.name as string,
            color: updated.color as string,
            count: (updated.messageCount as number | undefined) ?? 0,
            aiEnabled: updated.aiEnabled as boolean | undefined,
            aiKeywords: updated.aiKeywords as string[] | undefined,
            aiDescription: updated.aiDescription as string | undefined,
            aiConfidence: updated.aiConfidence as number | undefined,
          };
          setLabels((prev) =>
            prev.map((l) => (l.id === editDialogLabel.id ? updatedLabel : l))
          );
          toast.success(t.mail.settingsLabels.labelUpdatedSuccessfully);
          handleCloseEditDialog();
        },
        onError: (err: unknown) => {
          const message = err instanceof Error ? err.message : undefined;
          toast.error(message ?? t.mail.settingsLabels.failedToUpdateLabel);
        },
      },
    );
  };

  const handleStartEdit = (label: Mail.Label) => {
    setEditingLabel(label.name);
    setEditValue(label.name);
  };

  const handleCancelEdit = () => {
    setEditingLabel(null);
    setEditValue('');
  };

  const handleSaveEdit = (oldName: string) => {
    const newName = editValue.trim();

    if (!newName) {
      toast.error(t.mail.settingsLabels.labelNameEmpty);
      return;
    }

    if (newName === oldName) {
      handleCancelEdit();
      return;
    }

    if (labels.some((l) => l.name.toLowerCase() === newName.toLowerCase())) {
      toast.error(t.mail.settingsLabels.labelNameExists);
      return;
    }

    const label = labels.find((l) => l.name === oldName);
    if (!label?.id) {
      toast.error(t.mail.settingsLabels.labelNotFound);
      return;
    }

    updateLabelMutation.mutate(
      { id: label.id, name: newName },
      {
        onSuccess: () => {
          setLabels((prev) =>
            prev.map((l) => (l.name === oldName ? { ...l, name: newName } : l))
          );
          toast.success(t.mail.settingsLabels.labelRenamedSuccessfully);
          handleCancelEdit();
        },
        onError: (err: unknown) => {
          const message = err instanceof Error ? err.message : undefined;
          toast.error(message ?? t.mail.settingsLabels.failedToRenameLabel);
        },
      },
    );
  };

  const handleDeleteConfirm = () => {
    if (!deleteLabel?.id) return;

    deleteLabelMutation.mutate(deleteLabel.id, {
      onSuccess: () => {
        setLabels((prev) => prev.filter((l) => l.name !== deleteLabel.name));
        toast.success(t.mail.settingsLabels.labelDeletedSuccessfully);
        setDeleteLabel(null);
      },
      onError: (err: unknown) => {
        const message = err instanceof Error ? err.message : undefined;
        toast.error(message ?? t.mail.settingsLabels.failedToDeleteLabel);
      },
    });
  };

  const getLabelColor = (label: Mail.Label): string => {
    // If the label has a hex color, use it directly
    if (label.color?.startsWith('#')) {
      return label.color;
    }

    // Fallback to named color mapping for backwards compatibility
    const colorMap: Record<string, string> = {
      blue: '#3B82F6',
      green: '#22C55E',
      red: '#EF4444',
      yellow: '#EAB308',
      purple: '#8B5CF6',
      pink: '#EC4899',
      orange: '#F97316',
      teal: '#14B8A6',
    };

    return colorMap[label.color || 'blue'] || '#3B82F6';
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t.mail.settingsLabels.yourLabels}</CardTitle>
              <CardDescription>
                {labels.length === 0
                  ? t.mail.settingsLabels.noLabelsFound
                  : labels.length === 1
                    ? t.mail.settingsLabels.youHaveLabels.replace('{count}', String(labels.length))
                    : t.mail.settingsLabels.youHaveLabelsPlural.replace('{count}', String(labels.length))}
              </CardDescription>
            </div>
            <Button data-testid="labels-create-btn" onClick={() => setIsCreateDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-0.5" />
              {t.mail.settingsLabels.createLabel}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {labels.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">
                {t.mail.settingsLabels.noLabelsYet}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {labels.map((label) => (
                <div
                  key={label.name}
                  className="flex items-center justify-between p-3 border rounded-lg hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-3 flex-1">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: getLabelColor(label) }}
                    />

                    {editingLabel === label.name ? (
                      <div className="flex items-center gap-2 flex-1">
                        <Input
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              handleSaveEdit(label.name);
                            } else if (e.key === 'Escape') {
                              handleCancelEdit();
                            }
                          }}
                          className="max-w-xs"
                          autoFocus
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleSaveEdit(label.name)}
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={handleCancelEdit}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <span className="font-medium">{label.name}</span>
                        {label.aiEnabled && (
                          <Badge variant="secondary" className="text-xs flex items-center gap-1">
                            <img src="/assets/images/weldagent/logo-light.png" alt="AI" width={12} height={12} />
                            AI
                          </Badge>
                        )}
                        {label.count > 0 && (
                          <span className="text-sm text-muted-foreground">
                            ({label.count} {label.count === 1 ? t.mail.settingsLabels.emailSingular : t.mail.settingsLabels.emailPlural})
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  {editingLabel !== label.name && (
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`label-settings-btn-${label.name}`}
                        onClick={() => handleOpenEditDialog(label)}
                        title={t.mail.settingsLabels.editLabelSettings}
                      >
                        <Settings2 className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`label-rename-btn-${label.name}`}
                        onClick={() => handleStartEdit(label)}
                        title={t.mail.settingsLabels.quickRename}
                      >
                        <Edit2 className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`label-delete-btn-${label.name}`}
                        onClick={() => setDeleteLabel(label)}
                        className="text-destructive hover:text-destructive"
                        title={t.mail.settingsLabels.deleteLabel}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!deleteLabel}
        onOpenChange={(open) => !open && setDeleteLabel(null)}
        title={t.mail.settingsLabels.confirmDeleteTitle}
        description={<>{t.mail.settingsLabels.confirmDeleteDescription.replace('{name}', deleteLabel?.name || '')}</>}
        variant="destructive"
        confirmLabel={t.mail.settingsLabels.delete}
        onConfirm={handleDeleteConfirm}
      />

      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.mail.settingsLabels.createLabelDialogTitle}</DialogTitle>
            <DialogDescription>
              {t.mail.settingsLabels.createLabelDialogDescription}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="label-name">{t.mail.settingsLabels.name}</Label>
              <div className="flex items-center gap-2">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-9 h-9 rounded-md border border-input flex items-center justify-center flex-shrink-0 hover:bg-accent transition-colors"
                    >
                      <div
                        className="w-5 h-5 rounded"
                        style={{ backgroundColor: newLabelColor }}
                      />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-2" align="start">
                    <div className="grid grid-cols-4 gap-1.5">
                      {LABEL_COLORS.map((color) => (
                        <Button
                          key={color.value}
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => setNewLabelColor(color.value)}
                          className="w-8 h-8 rounded-md flex items-center justify-center hover:scale-110 transition-transform"
                          style={{ backgroundColor: color.value }}
                          title={t.mail.settingsLabels[color.key]}
                        >
                          {newLabelColor === color.value && (
                            <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </Button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
                <Input
                  id="label-name"
                  placeholder={t.mail.settingsLabels.enterLabelName}
                  value={newLabelName}
                  onChange={(e) => setNewLabelName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !isCreating) {
                      handleCreateLabel();
                    }
                  }}
                  autoFocus
                />
              </div>
            </div>

            {/* AI Auto-Labeling Configuration */}
            <div className="border border-border/60 rounded-lg p-4 mt-4 bg-muted/25">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Label className="flex items-center gap-2">
                    <img src="/assets/images/weldagent/logo-light.png" alt="AI" width={18} height={18} />
                    {t.mail.settingsLabels.aiAutoLabeling}
                  </Label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground h-auto w-auto p-0">
                        <Info className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[220px]">
                      {t.mail.settingsLabels.tooltipAutoLabel}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Switch checked={aiEnabled} onCheckedChange={setAiEnabled} />
              </div>

              <div className={`grid transition-all duration-300 ease-in-out ${aiEnabled ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
                <div className="overflow-hidden">
                  <div className="space-y-4 pt-4">
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="ai-keywords">{t.mail.settingsLabels.keywords}</Label>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground h-auto w-auto p-0">
                              <Info className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-[220px]">
                            {t.mail.settingsLabels.tooltipKeywords}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <Input
                        id="ai-keywords"
                        placeholder={t.mail.settingsLabels.keywordsPlaceholder}
                        value={aiKeywords}
                        onChange={(e) => setAiKeywords(e.target.value)}
                        className="bg-background"
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="ai-description">{t.mail.settingsLabels.aiDescriptionLabel}</Label>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground h-auto w-auto p-0">
                              <Info className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-[220px]">
                            {t.mail.settingsLabels.tooltipAiDescription}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <Textarea
                        id="ai-description"
                        placeholder={t.mail.settingsLabels.aiDescriptionPlaceholder}
                        value={aiDescription}
                        onChange={(e) => setAiDescription(e.target.value)}
                        rows={3}
                        className="bg-background"
                      />
                    </div>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <Label>{t.mail.settingsLabels.minimumConfidence}</Label>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground h-auto w-auto p-0">
                                <Info className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[220px]">
                              {t.mail.settingsLabels.tooltipMinConfidence}
                            </TooltipContent>
                          </Tooltip>
                        </div>
                        <span className="text-sm font-medium tabular-nums">{aiConfidence}%</span>
                      </div>
                      <Slider
                        value={[aiConfidence]}
                        onValueChange={(value) => setAiConfidence(value[0])}
                        min={0}
                        max={100}
                        step={5}
                        className="w-full"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsCreateDialogOpen(false)}
              disabled={isCreating}
            >
              {t.mail.settingsLabels.cancel}
            </Button>
            <Button onClick={handleCreateLabel} disabled={isCreating}>
              {isCreating ? t.mail.settingsLabels.creating : t.mail.settingsLabels.create}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Label Dialog */}
      <Dialog open={!!editDialogLabel} onOpenChange={(open) => !open && handleCloseEditDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.mail.settingsLabels.editLabelDialogTitle}</DialogTitle>
            <DialogDescription>
              {t.mail.settingsLabels.editLabelDialogDescription}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-label-name">{t.mail.settingsLabels.name}</Label>
              <Input
                id="edit-label-name"
                placeholder={t.mail.settingsLabels.enterLabelName}
                value={editDialogName}
                onChange={(e) => setEditDialogName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-label-color">{t.mail.settingsLabels.color}</Label>
              <Select value={editDialogColor} onValueChange={setEditDialogColor}>
                <SelectTrigger id="edit-label-color">
                  <SelectValue>
                    <div className="flex items-center gap-2">
                      <div
                        className="w-4 h-4 rounded-full"
                        style={{ backgroundColor: editDialogColor }}
                      />
                      {LABEL_COLORS.find((c) => c.value === editDialogColor) ? t.mail.settingsLabels[LABEL_COLORS.find((c) => c.value === editDialogColor)!.key] : t.mail.settingsLabels.colorCustom}
                    </div>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {LABEL_COLORS.map((color) => (
                    <SelectItem key={color.value} value={color.value}>
                      <div className="flex items-center gap-2">
                        <div
                          className="w-4 h-4 rounded-full"
                          style={{ backgroundColor: color.value }}
                        />
                        {t.mail.settingsLabels[color.key]}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* AI Auto-Labeling Configuration */}
            <div className="border border-border/60 rounded-lg p-4 mt-4 bg-muted/25">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Label className="flex items-center gap-2">
                    <img src="/assets/images/weldagent/logo-light.png" alt="AI" width={18} height={18} />
                    {t.mail.settingsLabels.aiAutoLabeling}
                  </Label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground h-auto w-auto p-0">
                        <Info className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[220px]">
                      {t.mail.settingsLabels.tooltipAutoLabel}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Switch checked={editDialogAiEnabled} onCheckedChange={setEditDialogAiEnabled} />
              </div>

              <div className={`grid transition-all duration-300 ease-in-out ${editDialogAiEnabled ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
                <div className="overflow-hidden">
                  <div className="space-y-4 pt-4">
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="edit-ai-keywords">{t.mail.settingsLabels.keywords}</Label>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground h-auto w-auto p-0">
                              <Info className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-[220px]">
                            {t.mail.settingsLabels.tooltipKeywords}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <Input
                        id="edit-ai-keywords"
                        placeholder={t.mail.settingsLabels.keywordsPlaceholder}
                        value={editDialogAiKeywords}
                        onChange={(e) => setEditDialogAiKeywords(e.target.value)}
                        className="bg-background"
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="edit-ai-description">{t.mail.settingsLabels.aiDescriptionLabel}</Label>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground h-auto w-auto p-0">
                              <Info className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-[220px]">
                            {t.mail.settingsLabels.tooltipAiDescription}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <Textarea
                        id="edit-ai-description"
                        placeholder={t.mail.settingsLabels.aiDescriptionPlaceholder}
                        value={editDialogAiDescription}
                        onChange={(e) => setEditDialogAiDescription(e.target.value)}
                        rows={3}
                        className="bg-background"
                      />
                    </div>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <Label>{t.mail.settingsLabels.minimumConfidence}</Label>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground h-auto w-auto p-0">
                                <Info className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[220px]">
                              {t.mail.settingsLabels.tooltipMinConfidence}
                            </TooltipContent>
                          </Tooltip>
                        </div>
                        <span className="text-sm font-medium tabular-nums">{editDialogAiConfidence}%</span>
                      </div>
                      <Slider
                        value={[editDialogAiConfidence]}
                        onValueChange={(value) => setEditDialogAiConfidence(value[0])}
                        min={0}
                        max={100}
                        step={5}
                        className="w-full"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCloseEditDialog}
              disabled={isUpdating}
            >
              {t.mail.settingsLabels.cancel}
            </Button>
            <Button onClick={handleUpdateLabel} disabled={isUpdating}>
              {isUpdating ? t.mail.settingsLabels.saving : t.mail.settingsLabels.saveChanges}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
