import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Button } from '@weldsuite/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { DatePicker } from '@weldsuite/ui/components/date-picker';
import { FolderKanban } from 'lucide-react';
import { cn } from '@/lib/utils';
import { coloredSquareColors, coloredSquareIcons } from '@/components/app-sidebar-layout';
import { projectsApi } from '@/app/weldflow/lib/api-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

interface GeneralSectionProps {
  projectId: string;
  isAdmin: boolean;
}

export function GeneralSection({ projectId, isAdmin }: GeneralSectionProps) {
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
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('Planning');
  const [priority, setPriority] = useState('medium');
  const [dueDate, setDueDate] = useState<Date | undefined>(undefined);
  const [color, setColor] = useState<string | undefined>(undefined);
  const [iconLabel, setIconLabel] = useState<string | undefined>(undefined);
  const [colorOpen, setColorOpen] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [originalName, setOriginalName] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    projectsApi.get(projectId).then((res) => {
      if (cancelled) return;
      if (res.success && res.data) {
        const p = res.data;
        setName(p.name || '');
        setOriginalName(p.name || '');
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
    const found = coloredSquareIcons.find((i) => i.label === iconLabel);
    return found?.value || FolderKanban;
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

    const timer = setTimeout(async () => {
      setSaving(true);
      try {
        const payload = {
          name: name.trim(),
          description: description.trim() || undefined,
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
        if (name.trim() !== originalName) {
          window.dispatchEvent(
            new CustomEvent('project:renamed', { detail: { id: projectId, name: name.trim() } }),
          );
          setOriginalName(name.trim());
        }
      } finally {
        setSaving(false);
      }
    }, 600);

    return () => clearTimeout(timer);
    // `t` intentionally excluded — including it would re-trigger this autosave
    // effect (and schedule a spurious save) on every locale switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, description, status, priority, dueDate, color, iconLabel, loading, isAdmin, projectId, originalName]);

  if (loading) return <PageLoader fullScreen={false} />;

  const disabled = !isAdmin || saving;

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
              placeholder="No due date"
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

      </div>
    </div>
  );
}
