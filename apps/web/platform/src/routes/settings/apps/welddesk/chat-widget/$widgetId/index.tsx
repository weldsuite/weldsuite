import { createFileRoute } from '@tanstack/react-router';
import WidgetEditPage from '@/app/welddesk/chat-widget/widget-edit-page';

export const Route = createFileRoute('/settings/apps/welddesk/chat-widget/$widgetId/')({
  component: WidgetEditRouteComponent,
});

function WidgetEditRouteComponent() {
  const { widgetId } = Route.useParams();
  return <WidgetEditPage widgetId={widgetId} />;
}
