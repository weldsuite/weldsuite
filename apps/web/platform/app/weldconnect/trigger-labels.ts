import type { Translations } from '@weldsuite/i18n/locales';

/**
 * Human label for a workflow / execution trigger type (`entity_event`,
 * `schedule`, `manual`, ...). A missing type means the run was started by hand.
 * Shared by the dashboard, the executions list and the workflows list.
 */
export function getTriggerLabel(t: Translations, type: string | null | undefined): string {
  const labels = t.weldconnect.triggerEmptyState;
  switch (type) {
    case 'entity_event': return labels.entityEvent;
    case 'schedule': return labels.schedule;
    case 'webhook': return labels.webhook;
    case 'integration_event': return labels.integrationEvent;
    case 'workflow_complete': return labels.workflowComplete;
    case 'api': return labels.api;
    case 'manual':
    case null:
    case undefined:
    case '':
      return labels.manual;
    default: {
      // Unknown type from a newer backend: "some_type" -> "Some type".
      const words = type.replace(/[_-]+/g, ' ').trim();
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}
