import { z } from 'zod';

const RESERVED_SLUGS = [
  'www',
  'app',
  'api',
  'admin',
  'mail',
  'welddesk',
  'weldmail',
  'support',
  'help',
];

export const SLUG_REGEX = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;

export const updateWorkspaceSlugInput = z.object({
  slug: z
    .string()
    .min(3, 'Slug must be at least 3 characters')
    .max(63, 'Slug must be at most 63 characters')
    .regex(
      SLUG_REGEX,
      'Slug must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens',
    )
    .refine(
      (value) => !RESERVED_SLUGS.includes(value),
      { message: 'This slug is reserved' },
    ),
});

export type UpdateWorkspaceSlugInput = z.infer<typeof updateWorkspaceSlugInput>;

export interface WorkspaceSlugUpdated {
  id: string;
  slug: string;
  previousSlug: string;
}

export const updateWorkspaceNameInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(255, 'Name must be at most 255 characters'),
});

export type UpdateWorkspaceNameInput = z.infer<typeof updateWorkspaceNameInput>;

export interface WorkspaceNameUpdated {
  id: string;
  name: string;
}
