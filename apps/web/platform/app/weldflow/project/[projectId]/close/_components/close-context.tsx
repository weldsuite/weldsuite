import { createContext, useContext } from 'react';
import type { CloseChecklist } from '@weldsuite/app-api-client/domains/project-closing';
import type { PickerMember } from '../_lib/members';

/** What the signed-in person may do on the close page. Every write is off once the project is closed. */
export interface CloseAbilities {
  /** Hand over, close register items and ask for sign-off: a project manager with `projects:update`. */
  manage: boolean;
  addLessons: boolean;
  voteLessons: boolean;
  editLessons: boolean;
  deleteLessons: boolean;
  publishLessons: boolean;
  /** `project_templates:manage`; allowed on a closed project too. */
  saveTemplate: boolean;
}

export interface CloseContextValue {
  projectId: string;
  checklist: CloseChecklist;
  userId: string | null;
  /** The project's API `canManageProject`. */
  isManager: boolean;
  abilities: CloseAbilities;
  members: PickerMember[];
  memberOf: (userId: string | null | undefined) => PickerMember | null;
}

export const CloseContext = createContext<CloseContextValue | null>(null);

export function useClose(): CloseContextValue {
  const value = useContext(CloseContext);
  if (!value) throw new Error('useClose must be used within the close page');
  return value;
}
