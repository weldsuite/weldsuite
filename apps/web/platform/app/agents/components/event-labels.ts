export interface EventLabels {
  scheduled: string;
  manual: string;
  /** "When {article} {entity} {action}". */
  when: string;
  articleA: string;
  articleAn: string;
  /** Entity type (`project_task`) → noun ("task"). */
  entities: Record<string, string>;
  /** Event action (`created`) → predicate ("is created"). */
  actions: Record<string, string>;
}

/**
 * An agent's event trigger as a sentence: `project_task.created` reads "When a
 * task is created". Keys it cannot phrase are returned as they are.
 */
export function describeEvent(key: string, labels: EventLabels): string {
  if (key === 'scheduled') return labels.scheduled;
  if (key === 'manual') return labels.manual;
  const dot = key.indexOf('.');
  if (dot <= 0) return key;
  const entity = key.slice(0, dot);
  const predicate = labels.actions[key.slice(dot + 1)];
  if (!predicate) return key;
  const noun = labels.entities[entity] ?? entity.replace(/_/g, ' ');
  const article = /^[aeiou]/i.test(noun) ? labels.articleAn : labels.articleA;
  return labels.when.replace('{article}', article).replace('{entity}', noun).replace('{action}', predicate);
}
