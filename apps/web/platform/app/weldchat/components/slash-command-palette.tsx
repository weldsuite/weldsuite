import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { ListTodo } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';

interface SlashCommand {
  name: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

interface SlashCommandPaletteProps {
  query: string;
  /** Called when the user picks a command — completes text in the editor. */
  onSelect: (command: string) => void;
  /** Escape closes the palette (and is consumed while it is showing). */
  onDismiss?: () => void;
}

export function SlashCommandPalette({ query, onSelect, onDismiss }: Readonly<SlashCommandPaletteProps>) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // `/invite` and its agent sub-picker were removed along with the rest of the
  // add-an-agent-to-a-channel surfaces. Channel membership is managed from the
  // members panel; agents are no longer added to channels from anywhere.
  const COMMANDS: SlashCommand[] = useMemo(() => [
    { name: '/createtask', description: t.weldchat.slashCommandPalette.commands.createtask, icon: ListTodo },
  ], [t]);

  const filteredCommands = useMemo(() => {
    if (!query) return COMMANDS;
    const q = query.toLowerCase();
    return COMMANDS.filter((cmd) => cmd.name.toLowerCase().includes(q));
  }, [query, COMMANDS]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Keyboard selection. Capture phase on `document`, ahead of the composer's
  // own key handler, so Enter completes the highlighted command instead of
  // sending the half-typed "/" as a message.
  useEffect(() => {
    if (filteredCommands.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Only react to keys typed in the composer this palette belongs to.
      const composer = ref.current?.closest('[data-chat-composer-root]');
      if (composer && e.target instanceof Node && !composer.contains(e.target)) return;
      if (e.isComposing) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onDismiss?.();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setActiveIndex((i) => (i + 1) % filteredCommands.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setActiveIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const cmd = filteredCommands[Math.min(activeIndex, filteredCommands.length - 1)];
        e.preventDefault();
        e.stopPropagation();
        onSelect(cmd.name + ' ');
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [filteredCommands, activeIndex, onSelect, onDismiss]);

  if (filteredCommands.length === 0) return null;

  return (
    <div ref={ref} className="absolute bottom-full left-0 right-0 mb-1 bg-popover border rounded-lg shadow-lg max-h-48 overflow-y-auto z-50">
      {filteredCommands.map((cmd, i) => (
        <Button
          key={cmd.name}
          variant="ghost"
          className={cn(
            'flex items-center gap-3 w-full px-3 py-2 text-sm hover:bg-muted text-left',
            i === activeIndex && 'bg-muted',
          )}
          onMouseEnter={() => setActiveIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(cmd.name + ' ');
          }}
        >
          <cmd.icon className="h-4 w-4 text-muted-foreground" />
          <div>
            <span className="font-mono font-medium">{cmd.name}</span>
            <span className="text-muted-foreground ml-2">{cmd.description}</span>
          </div>
        </Button>
      ))}
    </div>
  );
}
