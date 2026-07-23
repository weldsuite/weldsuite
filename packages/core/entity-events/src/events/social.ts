/**
 * Social-publishing entity events.
 */
export const SOCIAL_ENTITY_EVENTS = {
  social_account: ['created', 'updated', 'deleted'],
  social_approval: ['created', 'updated', 'deleted', 'approved', 'rejected'],
  social_campaign: ['created', 'updated', 'deleted', 'started', 'completed'],
  social_media: ['created', 'updated', 'deleted'],
  social_post: [
    'created',
    'updated',
    'deleted',
    'queue_manual',
    'email_scheduled',
    'scheduled',
    'published',
    'failed',
    'cancelled',
  ],
  social_settings: ['updated'],
  social_team_member: ['added', 'updated', 'removed'],
} as const;
