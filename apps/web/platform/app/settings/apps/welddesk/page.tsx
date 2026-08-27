import { MessagesSquare } from 'lucide-react';
import { Link } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { getTranslations } from '@/lib/i18n';

export default function HelpdeskSettingsPage() {
  const ts = getTranslations('settings');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.welddesk.title}</h1>
        <p className="text-muted-foreground">{ts.welddesk.description}</p>
      </div>
      <Button asChild>
        <Link href="/welddesk/chat-widget">
          <MessagesSquare className="h-4 w-4 mr-2" />
          {ts.welddesk.openChatWidget}
        </Link>
      </Button>
    </div>
  );
}
