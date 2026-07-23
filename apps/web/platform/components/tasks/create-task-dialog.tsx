
import { useState, useTransition } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { Badge } from '@weldsuite/ui/components/badge';
import { CalendarIcon, Repeat2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { tasksApi } from '@/app/weldflow/lib/api-client';
import {
  RepeatConfigMenu,
  repeatLabel,
  buildRepeatPayload,
  type RepeatFrequency,
  type RepeatUnit,
} from '@/components/tasks/repeat-config';

type TaskStatus = 'todo' | 'in_progress' | 'done';
type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTitle?: string;
  defaultDescription?: string;
  onTaskCreated?: (task: any) => void;
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  defaultTitle = '',
  defaultDescription = '',
  onTaskCreated,
}: CreateTaskDialogProps) {
  const t = useTranslations();
  const [isPending, startTransition] = useTransition();
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState(defaultDescription);
  const [status, setStatus] = useState<TaskStatus>('todo');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [dueDate, setDueDate] = useState<Date | undefined>(undefined);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  // Scheduler fields
  const [durationValue, setDurationValue] = useState<number>(30);
  const [durationUnit, setDurationUnit] = useState<'min' | 'hr'>('min');
  const [startDate, setStartDate] = useState<Date | undefined>(undefined);
  const [repeat, setRepeat] = useState<RepeatFrequency | null>(null);
  const [repeatInterval, setRepeatInterval] = useState<number>(1);
  const [repeatUnit, setRepeatUnit] = useState<RepeatUnit>('days');

  // Reset form when dialog opens with new defaults
  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      setTitle(defaultTitle);
      setDescription(defaultDescription);
      setStatus('todo');
      setPriority('medium');
      setDueDate(undefined);
      setTags([]);
      setTagInput('');
      setDurationValue(30);
      setDurationUnit('min');
      setStartDate(undefined);
      setRepeat(null);
      setRepeatInterval(1);
      setRepeatUnit('days');
    }
    onOpenChange(newOpen);
  };

  const handleAddTag = () => {
    if (tagInput.trim() && !tags.includes(tagInput.trim())) {
      setTags([...tags, tagInput.trim()]);
      setTagInput('');
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setTags(tags.filter(tag => tag !== tagToRemove));
  };

  const handleCreateTask = async () => {
    if (!title.trim()) return;

    const durationMinutes = durationUnit === 'hr' ? durationValue * 60 : durationValue;

    startTransition(async () => {
      const result = await tasksApi.createGlobal({
        title: title.trim(),
        description: description.trim() || undefined,
        status,
        priority,
        dueDate: dueDate?.toISOString(),
        tags: tags.length > 0 ? tags : undefined,
        duration: durationMinutes,
        startDate: startDate?.toISOString(),
        repeat: buildRepeatPayload(repeat, repeatInterval, repeatUnit),
      });

      if (result.success && result.data) {
        toast.success(t('sweep.shared.taskCreated'));
        onTaskCreated?.(result.data);
        onOpenChange(false);
        // Reset form
        setTitle('');
        setDescription('');
        setStatus('todo');
        setPriority('medium');
        setDueDate(undefined);
        setTags([]);
        setDurationValue(30);
        setDurationUnit('min');
        setStartDate(undefined);
        setRepeat(null);
        setRepeatInterval(1);
        setRepeatUnit('days');
      } else {
        toast.error(result.error || t('sweep.shared.failedToCreateTask'));
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t('sweep.shared.addTask')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="task-title" className="text-[13px]">{t('sweep.shared.title')}</Label>
            <Input
              id="task-title"
              placeholder={t('sweep.shared.taskTitlePlaceholder')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="task-description" className="text-[13px]">{t('sweep.shared.description')}</Label>
            <Textarea
              id="task-description"
              placeholder={t('sweep.shared.addMoreDetailsPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label className="text-[13px]">{t('sweep.shared.status')}</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as TaskStatus)}>
                <SelectTrigger className="focus:ring-0 focus:ring-offset-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todo">{t('sweep.shared.taskStatus.todo')}</SelectItem>
                  <SelectItem value="in_progress">{t('sweep.shared.taskStatus.inProgress')}</SelectItem>
                  <SelectItem value="done">{t('sweep.shared.taskStatus.done')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label className="text-[13px]">{t('sweep.shared.priority')}</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)}>
                <SelectTrigger className="focus:ring-0 focus:ring-offset-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">{t('sweep.shared.taskPriority.low')}</SelectItem>
                  <SelectItem value="medium">{t('sweep.shared.taskPriority.medium')}</SelectItem>
                  <SelectItem value="high">{t('sweep.shared.taskPriority.high')}</SelectItem>
                  <SelectItem value="urgent">{t('sweep.shared.taskPriority.urgent')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label className="text-[13px]">{t('sweep.shared.dueDate')}</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "justify-start text-left font-normal focus:ring-0 focus:ring-offset-0",
                    !dueDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {dueDate ? format(dueDate, "PPP") : t('sweep.shared.selectADate')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={dueDate}
                  onSelect={setDueDate}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>
          {/* Duration */}
          <div className="grid gap-2">
            <Label className="text-[13px]">{t('sweep.shared.duration')}</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                min={1}
                value={durationValue}
                onChange={(e) => setDurationValue(Math.max(1, parseInt(e.target.value) || 1))}
                className="focus-visible:ring-0 focus-visible:ring-offset-0 flex-1"
              />
              <Select value={durationUnit} onValueChange={(v) => setDurationUnit(v as 'min' | 'hr')}>
                <SelectTrigger className="w-20 focus:ring-0 focus:ring-offset-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="min">{t('sweep.shared.durationUnit.min')}</SelectItem>
                  <SelectItem value="hr">{t('sweep.shared.durationUnit.hr')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Earliest Start */}
          <div className="grid gap-2">
            <Label className="text-[13px]">
              {t('sweep.shared.earliestStart')}{' '}
              <span className="text-muted-foreground font-normal">({t('sweep.shared.optional')})</span>
            </Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "justify-start text-left font-normal focus:ring-0 focus:ring-offset-0",
                    !startDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {startDate ? format(startDate, "PPP") : t('sweep.shared.selectADate')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={startDate}
                  onSelect={setStartDate}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>

          {/* Repeat */}
          <div className="grid gap-2">
            <Label className="text-[13px]">{t('sweep.shared.repeat')}</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="justify-start text-left font-normal focus:ring-0 focus:ring-offset-0 gap-2"
                >
                  <Repeat2 className="h-4 w-4 text-muted-foreground" />
                  {repeat
                    ? repeatLabel(repeat, repeatInterval, repeatUnit, t)
                    : <span className="text-muted-foreground">{t('sweep.shared.noRepeat')}</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-1" align="start">
                <RepeatConfigMenu
                  repeat={repeat}
                  repeatInterval={repeatInterval}
                  repeatUnit={repeatUnit}
                  onRepeatChange={setRepeat}
                  onIntervalChange={setRepeatInterval}
                  onUnitChange={setRepeatUnit}
                />
                {repeat === 'custom' && (
                  <p className="text-[11px] text-muted-foreground px-2 py-1.5 border-t mt-1">
                    {t('sweep.shared.advancedRecurrenceHint')}
                  </p>
                )}
              </PopoverContent>
            </Popover>
          </div>

          <div className="grid gap-2">
            <Label className="text-[13px]">{t('sweep.shared.tags')}</Label>
            <div className="flex flex-wrap gap-2 mb-2">
              {tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="gap-1">
                  {tag}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => handleRemoveTag(tag)}
                    className="ml-1 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </Badge>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                placeholder={t('sweep.shared.addATagPlaceholder')}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddTag();
                  }
                }}
                className="focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              <Button type="button" variant="outline" onClick={handleAddTag} disabled={!tagInput.trim()}>
                {t('sweep.shared.add')}
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('sweep.shared.cancel')}
          </Button>
          <Button onClick={handleCreateTask} disabled={!title.trim() || isPending}>
            {t('sweep.shared.addTask')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
