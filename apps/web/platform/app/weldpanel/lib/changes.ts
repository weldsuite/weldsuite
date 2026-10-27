/**
 * What a form changed. Saving sends only these fields, so a save never
 * overwrites something a colleague changed in the meantime in a field this
 * form did not touch.
 */

import type {
  PanelProjectDto,
  PanelSettings,
  UpdatePanelProjectInput,
  UpdatePanelProjectSettingsInput,
} from '@weldsuite/app-api-client/schemas/weldpanel';
import type { PrivacyFormValues, ProjectFormValues } from './validation';

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

export function projectChanges(
  values: ProjectFormValues,
  project: Pick<PanelProjectDto, 'name' | 'kind' | 'allowedDomains'>,
): UpdatePanelProjectInput {
  const changes: UpdatePanelProjectInput = {};
  if (values.name !== project.name) changes.name = values.name;
  if (values.kind !== project.kind) changes.kind = values.kind;
  if (!sameList(values.allowedDomains, project.allowedDomains)) changes.allowedDomains = values.allowedDomains;
  return changes;
}

export function settingsChanges(
  values: PrivacyFormValues,
  settings: Pick<PanelSettings, 'autocapture' | 'consentMode' | 'maskingLevel' | 'excludedUrls'>,
): UpdatePanelProjectSettingsInput {
  const changes: NonNullable<UpdatePanelProjectSettingsInput['settings']> = {};
  if (values.autocapture !== settings.autocapture) changes.autocapture = values.autocapture;
  if (values.consentMode !== settings.consentMode) changes.consentMode = values.consentMode;
  if (values.maskingLevel !== settings.maskingLevel) changes.maskingLevel = values.maskingLevel;
  if (!sameList(values.excludedUrls, settings.excludedUrls)) changes.excludedUrls = values.excludedUrls;
  return Object.keys(changes).length > 0 ? { settings: changes } : {};
}

/** The form's starting values for a project. */
export function projectFormValues(project: Pick<PanelProjectDto, 'name' | 'kind' | 'allowedDomains'>): ProjectFormValues {
  return { name: project.name, kind: project.kind, allowedDomains: [...project.allowedDomains] };
}

export function privacyFormValues(settings: PanelSettings): PrivacyFormValues {
  return {
    autocapture: settings.autocapture,
    consentMode: settings.consentMode,
    maskingLevel: settings.maskingLevel,
    excludedUrls: [...settings.excludedUrls],
  };
}
