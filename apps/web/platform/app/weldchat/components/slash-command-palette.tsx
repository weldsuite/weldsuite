import { useMemo, type ComponentType } from 'react';
import { ListTodo } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
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
}

export function SlashCommandPalette({ query, onSelect }: SlashCommandPaletteProps) {
  const { t } = useI18n();

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

  if (filteredCommands.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 bg-popover border rounded-lg shadow-lg max-h-48 overflow-y-auto z-50">
      {filteredCommands.map((cmd) => (
        <Button
          key={cmd.name}
          variant="ghost"
          className="flex items-center gap-3 w-full px-3 py-2 text-sm hover:bg-muted text-left"
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
