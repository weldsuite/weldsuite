/**
 * Check if a WebSocket's topic tags match a published event topic.
 *
 * Tags are stored as "topic:project", "topic:notification.usr_123", etc.
 * An event on "project.proj_456" matches a subscription tag "topic:project".
 */
export function wsMatchesTopic(tags: readonly string[], eventTopic: string): boolean {
  for (const tag of tags) {
    if (!tag.startsWith('topic:')) continue;
    const subscription = tag.slice(6);
    if (eventTopic === subscription || eventTopic.startsWith(subscription + '.')) {
      return true;
    }
  }
  return false;
}
