
import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  X,
  Calendar,
  User,
  Building2,
  Flag,
  Clock
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';

interface NewTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (task: any) => void;
}

export function NewTaskModal({ isOpen, onClose, onSave }: NewTaskModalProps) {
  const st = useTranslations();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [duration, setDuration] = useState('');

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setDescription('');
      setDueDate('');
      setAssigneeId('');
      setCompanyId('');
      setDuration('30');
    }
  }, [isOpen]);

  const handleSave = () => {
    if (!title.trim()) return;

    const newTask = {
      id: Date.now().toString(),
      title,
      description,
      completed: false,
      duration: duration ? parseInt(duration, 10) : undefined,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      assignee: assigneeId ? { 
        id: assigneeId, 
        name: assigneeId === '1' ? 'John Doe' : 'Sarah Chen'
      } : undefined,
      linkedCompany: companyId ? {
        id: companyId,
        name: companyId === '1' ? 'TechCorp' : companyId === '2' ? 'GlobalTech' : 'StartupX',
        color: companyId === '1' ? '#FF5A5F' : companyId === '2' ? '#00D084' : '#0063E0'
      } : undefined,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    onSave(newTask);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent 
        className="max-w-md p-0 gap-0"
        showCloseButton={false}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <DialogTitle className="text-base font-medium">{st('sweep.weldflow.newTaskModal.title')}</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-4">
          {/* Title */}
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={st('sweep.weldflow.newTaskModal.taskNamePlaceholder')}
            className="w-full text-sm border-none outline-none bg-transparent placeholder:text-gray-400"
            autoFocus
          />

          {/* Description */}
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={st('sweep.weldflow.newTaskModal.descriptionPlaceholder')}
            className="w-full min-h-[60px] text-sm border-none outline-none bg-transparent resize-none placeholder:text-gray-400"
          />

          {/* Quick Properties */}
          <div className="flex flex-wrap gap-2">
            {/* Due Date */}
            <div className="relative">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs font-normal pl-2 pr-3"
                onClick={() => document.getElementById('dueDate')?.click()}
              >
                <Calendar className="h-3 w-3 mr-1.5" />
                {dueDate ? new Date(dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : st('sweep.weldflow.newTaskModal.dueDate')}
              </Button>
              <input
                id="dueDate"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
            </div>

            {/* Assignee */}
            <Select value={assigneeId} onValueChange={setAssigneeId}>
              <SelectTrigger className="h-7 text-xs font-normal w-auto">
                <div className="flex items-center gap-1.5">
                  <User className="h-3 w-3" />
                  {assigneeId ? (assigneeId === '1' ? 'John' : 'Sarah') : st('sweep.weldflow.newTaskModal.assignee')}
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">
                  <div className="flex items-center gap-2">
                    <Avatar className="h-4 w-4">
                      <AvatarFallback className="text-[7px]">JD</AvatarFallback>
                    </Avatar>
                    <span className="text-xs">John Doe</span>
                  </div>
                </SelectItem>
                <SelectItem value="2">
                  <div className="flex items-center gap-2">
                    <Avatar className="h-4 w-4">
                      <AvatarFallback className="text-[7px]">SC</AvatarFallback>
                    </Avatar>
                    <span className="text-xs">Sarah Chen</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>

            {/* Duration */}
            <div className="relative">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs font-normal pl-2 pr-3"
                onClick={() => document.getElementById('duration')?.focus()}
              >
                <Clock className="h-3 w-3 mr-1.5" />
                {duration ? st('sweep.weldflow.newTaskModal.durationMinutes', { count: duration }) : st('sweep.weldflow.newTaskModal.duration')}
              </Button>
              <input
                id="duration"
                type="number"
                min="0"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                placeholder={st('sweep.weldflow.newTaskModal.minutesAbbreviation')}
                className="absolute inset-0 opacity-0 w-full cursor-pointer"
              />
            </div>

            {/* Company */}
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger className="h-7 text-xs font-normal w-auto">
                <div className="flex items-center gap-1.5">
                  {companyId ? (
                    <>
                      <div 
                        className="h-2.5 w-2.5 rounded-sm" 
                        style={{ 
                          backgroundColor: companyId === '1' ? '#FF5A5F' : companyId === '2' ? '#00D084' : '#0063E0' 
                        }} 
                      />
                      {companyId === '1' ? 'TechCorp' : companyId === '2' ? 'GlobalTech' : 'StartupX'}
                    </>
                  ) : (
                    <>
                      <Building2 className="h-3 w-3" />
                      {st('sweep.weldflow.newTaskModal.company')}
                    </>
                  )}
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: '#FF5A5F' }} />
                    <span className="text-xs">TechCorp</span>
                  </div>
                </SelectItem>
                <SelectItem value="2">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: '#00D084' }} />
                    <span className="text-xs">GlobalTech</span>
                  </div>
                </SelectItem>
                <SelectItem value="3">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: '#0063E0' }} />
                    <span className="text-xs">StartupX</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t flex items-center justify-end gap-2">
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={onClose}
            className="h-7 text-xs"
          >
            {st('sweep.weldflow.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!title.trim()}
            className="h-7 text-xs"
          >
            {st('sweep.weldflow.newTaskModal.create')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}