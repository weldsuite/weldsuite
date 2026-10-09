import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Label } from '@weldsuite/ui/components/label';
import { Button } from '@weldsuite/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { DatePicker } from '@weldsuite/ui/components/date-picker';
import { FolderKanban } from 'lucide-react';
import { cn } from '@/lib/utils';
import { coloredSquareColors, coloredSquareIcons, findColoredSquareIconByLabel } from '@/components/app-sidebar-layout';
import { projectsApi } from '@/app/weldflow/lib/api-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

interface GeneralSectionProps {
  projectId: string;
  isAdmin: boolean;
}

export function GeneralSection({ projectId, isAdmin }: Readonly<GeneralSectionProps>) {
  const { t } = useI18n();

  const STATUS_OPTIONS = [
    { value: 'Planning', label: t.projects.settings.statusPlanning },
    { value: 'Active', label: t.projects.settings.statusActive },
    { value: 'On Hold', label: t.projects.settings.statusOnHold },
    { value: 'Completed', label: t.projects.settings.statusCompleted },
    { value: 'Cancelled', label: t.projects.settings.statusCancelled },
  ];

  const PRIORITY_OPTIONS = [
    { value: 'low', label: t.projects.settings.priorityLow },
    { value: 'medium', label: t.projects.settings.priorityMedium },
    { value: 'high', label: t.projects.settings.priorityHigh },
    { value: 'critical', label: t.projects.settings.priorityCritical },
  ];

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('Planning');
  const [priority, setPriority] = useState('medium');
  const [dueDate, setDueDate] = useState<Date | undefined>(undefined);
  const [color, setColor] = useState<string | undefined>(undefined);
  const [iconLabel, setIconLabel] = useState<string | undefined>(undefined);
  const [colorOpen, setColorOpen] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  // A ref, not state: renaming must not re-run the autosave effect below.
  const originalNameRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void projectsApi.get(projectId).then((res) => {
      if (cancelled) return;
      if (res.success && res.data) {
        const p = res.data;
        setName(p.name || '');
        originalNameRef.current = p.name || '';
        setDescription(p.description || '');
        setStatus(p.status || 'Planning');
        setPriority(p.priority || 'medium');
        setDueDate(p.endDate ? new Date(p.endDate) : undefined);
        setColor(p.color || undefined);
        setIconLabel(p.icon || undefined);
      } else {
        toast.error(res.error || t.projects.settings.failedToLoadProject);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
    // `t` intentionally excluded — this effect should only re-fetch when the
    // project changes, not re-run (and re-fetch) on every locale switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const SelectedIcon = useMemo(() => {
    return (iconLabel && findColoredSquareIconByLabel(iconLabel)) || FolderKanban;
  }, [iconLabel]);

  // Track when the initial project data has been loaded so the first render
  // (which just sets the form state from the API) doesn't trigger an auto-save.
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    if (loading || !isAdmin) return;
    // Skip the first pass right after load finishes — those state values came
    // from the API, there's nothing to save yet.
    if (!hasLoadedRef.current) {
      hasLoadedRef.current = true;
      return;
    }
    if (!name.trim()) return; // required — silently skip while empty

    setSaved(false);
    const timer = setTimeout(async () => {
      setSaving(true);
      try {
        const payload = {
          name: name.trim(),
          // Sent even when empty so a cleared description is saved too.
          description: description.trim(),
          status,
          priority,
          endDate: dueDate ? dueDate.toISOString() : undefined,
          color: color ?? undefined,
          icon: iconLabel ?? undefined,
        };
        const result = await projectsApi.update(projectId, payload);
        if (!result.success) {
          toast.error(result.error || t.projects.settings.failedToSaveChanges);
          return;
        }
        if (name.trim() !== originalNameRef.current) {
          window.dispatchEvent(
            new CustomEvent('project:renamed', { detail: { id: projectId, name: name.trim() } }),
          );
          originalNameRef.current = name.trim();
        }
        setSaved(true);
      } finally {
        setSaving(false);
      }
    }, 600);

    return () => clearTimeout(timer);
    // `t` intentionally excluded — including it would re-trigger this autosave
    // effect (and schedule a spurious save) on every locale switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, description, status, priority, dueDate, color, iconLabel, loading, isAdmin, projectId]);

  if (loading) return <PageLoader fullScreen={false} />;

  // Not disabled while saving: the form autosaves as you type, and disabling
  // the fields mid-request would drop focus from the one being edited.
  const disabled = !isAdmin;

  return (
    <div className="max-w-3xl">
      <div className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="name" className="text-[13px]">{t.projects.settings.nameLabel}</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={disabled}
              className="focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description" className="text-[13px]">{t.projects.settings.descriptionLabel}</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={disabled}
              rows={4}
              placeholder={t.projects.settings.descriptionPlaceholder}
              className="focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-[13px]">{t.projects.settings.statusLabel}</Label>
              <Select value={status} onValueChange={setStatus} disabled={disabled}>
                <SelectTrigger className="focus:ring-0 focus:ring-offset-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-[13px]">{t.projects.settings.priorityLabel}</Label>
              <Select value={priority} onValueChange={setPriority} disabled={disabled}>
                <SelectTrigger className="focus:ring-0 focus:ring-offset-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-[13px]">{t.projects.settings.dueDateLabel}</Label>
            <DatePicker
              date={dueDate}
              onDateChange={(d) => !disabled && setDueDate(d)}
              placeholder={t.projects.settings.noDueDatePlaceholder}
              className="max-w-xs"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-[13px]">{t.projects.settings.appearanceLabel}</Label>
            <div className="flex items-center gap-2">
              {/* Color square — click to choose color */}
              <Popover open={colorOpen} onOpenChange={setColorOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={disabled}
                    title={t.projects.settings.changeColorTitle}
                    aria-label={t.projects.settings.changeColorTitle}
                    className={cn(
                      'w-8 h-8 rounded-md transition-all p-0',
                      color || 'bg-muted',
                      !disabled && 'hover:ring-2 hover:ring-offset-2 hover:ring-foreground/30',
                      disabled && 'opacity-60 cursor-not-allowed',
                    )}
                  />
                </PopoverTrigger>
                <PopoverContent className="w-auto p-1" align="start">
                  <div className="grid grid-cols-4 gap-1">
                    {coloredSquareColors.map((c) => (
                      <Button
                        key={c.value}
                        type="button"
                        variant="ghost"
                        onClick={() => { setColor(c.value); setColorOpen(false); }}
                        title={c.label}
                        className={cn(
                          'w-8 h-8 rounded-md transition-transform hover:scale-110 p-0',
                          c.value,
                          color === c.value && 'ring-2 ring-offset-2 ring-primary',
                        )}
                      />
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

              {/* Icon square — click to choose icon */}
              <Popover open={iconOpen} onOpenChange={setIconOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={disabled}
                    title={t.projects.settings.changeIconTitle}
                    aria-label={t.projects.settings.changeIconTitle}
                    className={cn(
                      'w-8 h-8 rounded-md flex items-center justify-center transition-all p-0',
                      color || 'bg-gray-500',
                      !disabled && 'hover:ring-2 hover:ring-offset-2 hover:ring-foreground/30',
                      disabled && 'opacity-60 cursor-not-allowed',
                    )}
                  >
                    <SelectedIcon className="h-4 w-4 text-white" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-1" align="start">
                  <div className="grid grid-cols-7 gap-1">
                    {coloredSquareIcons.map((opt) => {
                      const Icon = opt.value;
                      return (
                        <Button
                          key={opt.label}
                          type="button"
                          variant="ghost"
                          onClick={() => { setIconLabel(opt.label); setIconOpen(false); }}
                          title={opt.label}
                          className={cn(
                            'w-8 h-8 rounded-md flex items-center justify-center transition-colors hover:bg-accent p-0',
                            iconLabel === opt.label && 'bg-accent',
                          )}
                        >
                          <Icon className="h-4 w-4" />
                        </Button>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>

        {isAdmin && (
          <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
            {saving
              ? t.projects.settings.savingChanges
              : saved
                ? t.projects.settings.changesSaved
                : t.projects.settings.autoSaveHint}
          </p>
        )}
      </div>
    </div>
  );
}
