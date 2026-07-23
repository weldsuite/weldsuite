import { createFileRoute } from '@tanstack/react-router';
import WidgetEditPage from '@/app/welddesk/chat-widget/widget-edit-page';

export const Route = createFileRoute('/welddesk/chat-widget/$widgetId/')({
  component: () => {
    const { widgetId } = Route.useParams();
    return <WidgetEditPage widgetId={widgetId} />;
  },
});
