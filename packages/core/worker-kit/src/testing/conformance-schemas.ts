/**
 * The Zod response schema of each route the Rust backend serves, for
 * conformance mode (./conformance.ts): every successful Rust response is
 * validated against it, so a shape the clients can't parse fails even where a
 * test's assertions don't look.
 *
 * Keyed by method and the Hono route pattern (`/api/companies/:id`). Register
 * a route here when its module is ported (playbook step 5). Schemas come from
 * the client packages, which is what the platform and the mobile apps parse
 * responses with.
 */

import { accessRequestSchema } from '@weldsuite/app-api-client/schemas/access-requests';
import { desktopTicketSchema } from '@weldsuite/app-api-client/schemas/auth-desktop';
import { cliAuthApproveSchema, cliAuthDeviceSchema, cliAuthTokenSchema } from '@weldsuite/app-api-client/schemas/cli-auth';
import {
  appDeveloperAccountSchema,
  installedUserAppSchema,
  userAppBundleUrlSchema,
  userAppDevSessionViewSchema,
  userAppInstallResultSchema,
  userAppInstallSchema,
  userAppOauthClientSchema,
  userAppOauthClientSecretSchema,
  userAppSchema,
  userAppSessionTokenSchema,
  userAppStoreListingSchema,
  userAppVersionSchema,
} from '@weldsuite/app-api-client/schemas/user-apps';
import {
  customFieldDefinitionSchema,
  customFieldDefinitionsByEntityTypeSchema,
  customFieldDeletedSchema,
} from '@weldsuite/app-api-client/schemas/custom-fields';
import {
  customObjectDeleteImpactSchema,
  customObjectLinkPanelSchema,
  customObjectLinkSchema,
  customObjectLinkTargetSchema,
  customObjectRecordSchema,
  customObjectRelatedRecordSchema,
  customObjectReversePanelSchema,
  customObjectSchema,
  reorderResultSchema,
} from '@weldsuite/app-api-client/schemas/custom-objects';
import {
  catalogAppDetailSchema,
  catalogAppListSchema,
  catalogCodesSchema,
  installedCatalogAppSchema,
} from '@weldsuite/app-api-client/schemas/app-catalog';
import { appAccessViewOrNullSchema, appAccessViewSchema } from '@weldsuite/app-api-client/schemas/reach';
import {
  installableAppListSchema,
  permissionCatalogSchema,
  roleListSchema,
  roleSummarySchema,
} from '@weldsuite/app-api-client/schemas/roles';
import { featureFlagsResponseSchema } from '@weldsuite/app-api-client/schemas/feature-flags';
import { gridViewResponseSchema } from '@weldsuite/app-api-client/schemas/grid-views';
import { objectTemplateSchema } from '@weldsuite/app-api-client/schemas/object-templates';
import { myPermissionsSchema } from '@weldsuite/app-api-client/schemas/me';
import { accountDeletionStatusSchema, deleteAccountResultSchema } from '@weldsuite/app-api-client/schemas/account';
import { acceptedInvitationSchema, invitationDetailsSchema } from '@weldsuite/app-api-client/schemas/invitations';
import {
  deleteWorkspaceResultSchema,
  workspaceDeletionStatusSchema,
  workspaceNameUpdatedSchema,
  workspaceSettingsSchema,
  workspaceSlugUpdatedSchema,
} from '@weldsuite/app-api-client/schemas/workspace-settings';
import { workspaceSummarySchema } from '@weldsuite/app-api-client/schemas/workspaces';
import {
  notificationPreferenceRefSchema,
  notificationPreferenceSchema,
} from '@weldsuite/app-api-client/schemas/notification-preferences';
import {
  pushTestResultSchema,
  pushTokenRegisteredSchema,
  pushTokenListSchema,
  pushTokenUnregisteredSchema,
} from '@weldsuite/app-api-client/schemas/push-tokens';
import { selfAvatarSchema, selfProfileSchema } from '@weldsuite/app-api-client/schemas/settings-profile';
import {
  userFontSizeSchema,
  userPreferencesSchema,
  userThemeSchema,
} from '@weldsuite/app-api-client/schemas/user-preferences';
import {
  commonConceptsResponseSchema,
  memberActivityItemSchema,
  memberAppAssignmentSchema,
  memberAppToggleResultSchema,
  memberNoteSchema,
  memberPermissionsBreakdownSchema,
  memberProfileSchema,
  teamMemberListItemSchema,
  teamMemberSelfSchema,
} from '@weldsuite/app-api-client/schemas/team-members';
import { memberLimitsSchema, myRoleSchema } from '@weldsuite/app-api-client/schemas/member-limits';
import {
  inviteMemberResultSchema,
  resendInviteResultSchema,
  teamMembersSyncResultSchema,
  updateMemberResultSchema,
} from '@weldsuite/app-api-client/schemas/team-members-manage';
import {
  knowledgeFavoriteRefSchema,
  knowledgeFavoriteSchema,
  knowledgeMembershipSchema,
  knowledgePageSchema,
  knowledgePageTreeNodeSchema,
  knowledgePageVersionSchema,
  knowledgePageVersionSummarySchema,
  knowledgeSavedContentSchema,
  knowledgeSpaceMemberSchema,
  knowledgeSpaceRowSchema,
  knowledgeSpaceSchema,
  knowledgeTeammateSchema,
  knowledgeTrashedPageSchema,
} from '@weldsuite/core-api-client/schemas/knowledge';
import {
  signDocumentDtoSchema,
  signDocumentListSchema,
  signEnvelopeDetailSchema,
  signEnvelopeSummarySchema,
  signEventListSchema,
  signFieldListSchema,
  signRecipientDtoSchema,
  signRecipientSuggestionListSchema,
  signRemindResultSchema,
  signSigningLinkSchema,
  signTemplateSummarySchema,
} from '@weldsuite/app-api-client/schemas/weldsign';
import {
  deletedResultSchema,
  driveFileSchema,
  moveFileResultSchema,
  pinFileResultSchema,
  starFileResultSchema,
  unifiedFileSchema,
} from '@weldsuite/core-api-client/schemas/files';
import { driveFolderSchema } from '@weldsuite/core-api-client/schemas/folders';
import { driveItemSharingSchema } from '@weldsuite/core-api-client/schemas/drive-shares';
import {
  driveStatsSchema,
  driveTrashSchema,
  emptiedResultSchema,
  restoredResultSchema,
  sharedWithMeSchema,
} from '@weldsuite/core-api-client/schemas/drive';
import { searchResultGroupSchema } from '@weldsuite/app-api-client/schemas/search';
import {
  confirmUploadResponseSchema,
  filesAccessSchema,
  generateUploadUrlResponseSchema,
  privateFilesMigrationBatchSchema,
  signedObjectUrlsSchema,
} from '@weldsuite/core-api-client/schemas/storage';
// crm (crm-api)
import {
  bulkUpdateResultSchema,
  companyDetailSchema,
  companyPersonLinkSchema,
  companyRowSchema,
  importResultSchema,
  recordNavigationSchema,
} from '@weldsuite/app-api-client/schemas/companies';
import { customerStatusSchema } from '@weldsuite/app-api-client/schemas/customer-statuses';
import { pipelineFieldVisibilitySchema } from '@weldsuite/app-api-client/schemas/pipeline-field-visibility';
import { activitySchema } from '@weldsuite/core-api-client/schemas/activities';
import {
  leadConversionResultSchema,
  leadQualifiedSchema,
  leadSchema,
  recordIdSchema,
} from '@weldsuite/core-api-client/schemas/leads';
import { listEntitySchema, listMemberSchema, listMembersAddedSchema } from '@weldsuite/core-api-client/schemas/lists';
import { opportunitySchema } from '@weldsuite/core-api-client/schemas/opportunities';
import { personCompanySchema } from '@weldsuite/core-api-client/schemas/person-companies';
import { pipelineStageSchema, reorderPipelineStagesResultSchema } from '@weldsuite/core-api-client/schemas/pipeline-stages';
import { pipelineRowSchema } from '@weldsuite/core-api-client/schemas/pipelines-crm';

/** The parts of a Zod schema this file needs, so worker-kit doesn't depend on zod. */
interface ResponseSchema {
  safeParse(value: unknown): { success: true } | { success: false; error: { message: string } };
}

type Envelope = 'single' | 'list' | 'array' | 'body';

interface RouteSchema {
  method: string;
  route: string;
  /**
   * `{ data: T }`, `{ data: T[], pagination }`, `{ data: T[] }`
   * (`success(c, rows)`), or the whole body for the few routes that answer
   * without the envelope (`body`).
   */
  envelope: Envelope;
  data: ResponseSchema;
}

const ROUTES: RouteSchema[] = [
  { method: 'GET', route: '/api/me/permissions', envelope: 'single', data: myPermissionsSchema },
  { method: 'GET', route: '/api/feature-flags', envelope: 'single', data: featureFlagsResponseSchema },
  { method: 'POST', route: '/api/access-requests', envelope: 'single', data: accessRequestSchema },
  { method: 'PATCH', route: '/api/access-requests/:id', envelope: 'single', data: accessRequestSchema },
  { method: 'GET', route: '/api/access-requests/me/pending', envelope: 'list', data: accessRequestSchema },
  // core: settings-profile
  { method: 'GET', route: '/api/settings/profile', envelope: 'single', data: selfProfileSchema },
  { method: 'PUT', route: '/api/settings/profile', envelope: 'single', data: selfProfileSchema },
  { method: 'PUT', route: '/api/settings/profile/avatar', envelope: 'single', data: selfAvatarSchema },
  // core: user-preferences
  { method: 'GET', route: '/api/user-preferences', envelope: 'single', data: userPreferencesSchema },
  { method: 'PUT', route: '/api/user-preferences', envelope: 'single', data: userPreferencesSchema },
  { method: 'PATCH', route: '/api/user-preferences/theme', envelope: 'single', data: userThemeSchema },
  { method: 'PATCH', route: '/api/user-preferences/font-size', envelope: 'single', data: userFontSizeSchema },
  // core: notification-preferences
  { method: 'GET', route: '/api/notification-preferences', envelope: 'list', data: notificationPreferenceSchema },
  { method: 'GET', route: '/api/notification-preferences/:id', envelope: 'single', data: notificationPreferenceSchema },
  { method: 'PUT', route: '/api/notification-preferences', envelope: 'single', data: notificationPreferenceSchema },
  { method: 'PUT', route: '/api/notification-preferences/module/:module', envelope: 'single', data: notificationPreferenceSchema },
  { method: 'POST', route: '/api/notification-preferences', envelope: 'single', data: notificationPreferenceRefSchema },
  { method: 'PATCH', route: '/api/notification-preferences/:id', envelope: 'single', data: notificationPreferenceRefSchema },
  // core: push-tokens
  { method: 'GET', route: '/api/push-tokens', envelope: 'single', data: pushTokenListSchema },
  { method: 'POST', route: '/api/push-tokens', envelope: 'single', data: pushTokenRegisteredSchema },
  { method: 'POST', route: '/api/push-tokens/test', envelope: 'single', data: pushTestResultSchema },
  { method: 'DELETE', route: '/api/push-tokens', envelope: 'single', data: pushTokenUnregisteredSchema },
  // core: team-members (directory)
  { method: 'GET', route: '/api/team-members/me', envelope: 'single', data: teamMemberSelfSchema },
  { method: 'GET', route: '/api/team-members', envelope: 'list', data: teamMemberListItemSchema },
  { method: 'GET', route: '/api/team-members/:id', envelope: 'single', data: teamMemberListItemSchema },
  { method: 'GET', route: '/api/team-members/:id/permissions', envelope: 'single', data: memberPermissionsBreakdownSchema },
  { method: 'GET', route: '/api/team-members/:id/apps', envelope: 'single', data: memberAppAssignmentSchema.array() },
  { method: 'POST', route: '/api/team-members/:id/apps/toggle', envelope: 'single', data: memberAppToggleResultSchema },
  { method: 'GET', route: '/api/team-members/user/:userId/profile', envelope: 'single', data: memberProfileSchema },
  { method: 'PATCH', route: '/api/team-members/user/:userId/profile', envelope: 'single', data: memberProfileSchema },
  { method: 'GET', route: '/api/team-members/user/:userId/notes', envelope: 'single', data: memberNoteSchema.nullable() },
  { method: 'PUT', route: '/api/team-members/user/:userId/notes', envelope: 'single', data: memberNoteSchema },
  { method: 'GET', route: '/api/team-members/user/:userId/common', envelope: 'single', data: commonConceptsResponseSchema },
  { method: 'GET', route: '/api/team-members/user/:userId/activity', envelope: 'list', data: memberActivityItemSchema },
  // core: roles
  { method: 'GET', route: '/api/roles', envelope: 'single', data: roleListSchema },
  { method: 'GET', route: '/api/roles/permission-catalog', envelope: 'single', data: permissionCatalogSchema },
  { method: 'GET', route: '/api/roles/installable-apps', envelope: 'single', data: installableAppListSchema },
  { method: 'GET', route: '/api/roles/:roleId', envelope: 'single', data: roleSummarySchema },
  { method: 'POST', route: '/api/roles', envelope: 'single', data: roleSummarySchema },
  { method: 'PUT', route: '/api/roles/:roleId', envelope: 'single', data: roleSummarySchema },
  // core: app-catalog (and its access requests)
  { method: 'GET', route: '/api/app-catalog', envelope: 'single', data: catalogAppListSchema },
  { method: 'GET', route: '/api/app-catalog/categories', envelope: 'single', data: catalogCodesSchema },
  { method: 'GET', route: '/api/app-catalog/beta', envelope: 'single', data: catalogCodesSchema },
  { method: 'GET', route: '/api/app-catalog/:code', envelope: 'single', data: catalogAppDetailSchema },
  { method: 'POST', route: '/api/app-catalog/:code/install', envelope: 'single', data: installedCatalogAppSchema },
  { method: 'GET', route: '/api/app-catalog/:code/access-request', envelope: 'single', data: appAccessViewOrNullSchema },
  { method: 'POST', route: '/api/app-catalog/:code/access-request', envelope: 'single', data: appAccessViewSchema },
  // core: workspace settings, account, invitations, workspaces
  { method: 'GET', route: '/api/workspace-settings', envelope: 'single', data: workspaceSettingsSchema.nullable() },
  { method: 'PUT', route: '/api/workspace-settings', envelope: 'single', data: workspaceSettingsSchema },
  { method: 'PUT', route: '/api/workspace-settings/name', envelope: 'single', data: workspaceNameUpdatedSchema },
  { method: 'POST', route: '/api/workspace-settings/slug', envelope: 'single', data: workspaceSlugUpdatedSchema },
  { method: 'GET', route: '/api/workspace-settings/deletion-status', envelope: 'single', data: workspaceDeletionStatusSchema },
  { method: 'POST', route: '/api/workspace-settings/delete', envelope: 'single', data: deleteWorkspaceResultSchema },
  { method: 'GET', route: '/api/account/deletion-status', envelope: 'single', data: accountDeletionStatusSchema },
  { method: 'POST', route: '/api/account/delete', envelope: 'single', data: deleteAccountResultSchema },
  { method: 'GET', route: '/api/invitations/:token', envelope: 'single', data: invitationDetailsSchema },
  { method: 'POST', route: '/api/invitations/accept', envelope: 'single', data: acceptedInvitationSchema },
  { method: 'GET', route: '/api/workspaces', envelope: 'single', data: workspaceSummarySchema.array() },
  // core: team-members (manage), member-limits, my-role
  { method: 'POST', route: '/api/team-members/sync', envelope: 'single', data: teamMembersSyncResultSchema },
  { method: 'POST', route: '/api/team-members/invite', envelope: 'single', data: inviteMemberResultSchema },
  { method: 'PATCH', route: '/api/team-members/:id', envelope: 'single', data: updateMemberResultSchema },
  { method: 'POST', route: '/api/team-members/:id/resend-invite', envelope: 'single', data: resendInviteResultSchema },
  { method: 'GET', route: '/api/member-limits', envelope: 'single', data: memberLimitsSchema },
  { method: 'GET', route: '/api/my-role', envelope: 'single', data: myRoleSchema },
  // know (WeldKnow)
  { method: 'GET', route: '/api/knowledge/spaces', envelope: 'list', data: knowledgeSpaceSchema },
  { method: 'POST', route: '/api/knowledge/spaces', envelope: 'single', data: knowledgeSpaceRowSchema },
  { method: 'PATCH', route: '/api/knowledge/spaces/:id', envelope: 'single', data: knowledgeSpaceRowSchema },
  { method: 'GET', route: '/api/knowledge/teammates', envelope: 'list', data: knowledgeTeammateSchema },
  { method: 'GET', route: '/api/knowledge/spaces/:id/members', envelope: 'list', data: knowledgeSpaceMemberSchema },
  { method: 'POST', route: '/api/knowledge/spaces/:id/members', envelope: 'single', data: knowledgeMembershipSchema },
  { method: 'PATCH', route: '/api/knowledge/spaces/:id/members/:userId', envelope: 'single', data: knowledgeMembershipSchema },
  { method: 'POST', route: '/api/knowledge/spaces/:id/join', envelope: 'single', data: knowledgeMembershipSchema },
  { method: 'GET', route: '/api/knowledge/pages/tree', envelope: 'list', data: knowledgePageTreeNodeSchema },
  { method: 'GET', route: '/api/knowledge/trash', envelope: 'list', data: knowledgeTrashedPageSchema },
  { method: 'GET', route: '/api/knowledge/pages/:id', envelope: 'single', data: knowledgePageSchema },
  { method: 'POST', route: '/api/knowledge/pages', envelope: 'single', data: knowledgePageSchema },
  { method: 'PATCH', route: '/api/knowledge/pages/:id', envelope: 'single', data: knowledgePageSchema },
  { method: 'PUT', route: '/api/knowledge/pages/:id/content', envelope: 'single', data: knowledgeSavedContentSchema },
  { method: 'POST', route: '/api/knowledge/pages/:id/move', envelope: 'single', data: knowledgePageSchema },
  { method: 'POST', route: '/api/knowledge/pages/:id/restore', envelope: 'single', data: knowledgePageSchema },
  { method: 'GET', route: '/api/knowledge/pages/:id/versions', envelope: 'list', data: knowledgePageVersionSummarySchema },
  { method: 'POST', route: '/api/knowledge/pages/:id/versions', envelope: 'single', data: knowledgePageVersionSchema },
  { method: 'GET', route: '/api/knowledge/pages/:id/versions/:versionId', envelope: 'single', data: knowledgePageVersionSchema },
  { method: 'POST', route: '/api/knowledge/pages/:id/versions/:versionId/restore', envelope: 'single', data: knowledgePageSchema },
  { method: 'GET', route: '/api/knowledge/favorites', envelope: 'list', data: knowledgeFavoriteSchema },
  { method: 'POST', route: '/api/knowledge/favorites', envelope: 'single', data: knowledgeFavoriteRefSchema },
  // sign (WeldSign, members)
  { method: 'GET', route: '/api/sign/envelopes', envelope: 'list', data: signEnvelopeSummarySchema },
  { method: 'POST', route: '/api/sign/envelopes', envelope: 'single', data: signEnvelopeDetailSchema },
  { method: 'GET', route: '/api/sign/envelopes/:id', envelope: 'single', data: signEnvelopeDetailSchema },
  { method: 'PATCH', route: '/api/sign/envelopes/:id', envelope: 'single', data: signEnvelopeDetailSchema },
  { method: 'GET', route: '/api/sign/envelopes/:id/events', envelope: 'single', data: signEventListSchema },
  { method: 'POST', route: '/api/sign/envelopes/:id/send', envelope: 'single', data: signEnvelopeDetailSchema },
  { method: 'POST', route: '/api/sign/envelopes/:id/void', envelope: 'single', data: signEnvelopeDetailSchema },
  { method: 'POST', route: '/api/sign/envelopes/:id/remind', envelope: 'single', data: signRemindResultSchema },
  { method: 'POST', route: '/api/sign/envelopes/:id/signing-link', envelope: 'single', data: signSigningLinkSchema },
  { method: 'POST', route: '/api/sign/envelopes/:id/recipients', envelope: 'single', data: signRecipientDtoSchema },
  { method: 'PATCH', route: '/api/sign/envelopes/:id/recipients/:recipientId', envelope: 'single', data: signRecipientDtoSchema },
  { method: 'GET', route: '/api/sign/envelopes/:id/recipients/suggestions', envelope: 'single', data: signRecipientSuggestionListSchema },
  { method: 'POST', route: '/api/sign/envelopes/:id/recipients/:recipientId/resend', envelope: 'single', data: signRecipientDtoSchema },
  { method: 'POST', route: '/api/sign/envelopes/:id/recipients/:recipientId/correct', envelope: 'single', data: signRecipientDtoSchema },
  { method: 'PUT', route: '/api/sign/envelopes/:id/fields', envelope: 'single', data: signFieldListSchema },
  { method: 'POST', route: '/api/sign/envelopes/:id/documents', envelope: 'single', data: signDocumentDtoSchema },
  { method: 'POST', route: '/api/sign/envelopes/:id/documents/from-drive', envelope: 'single', data: signDocumentDtoSchema },
  { method: 'PUT', route: '/api/sign/envelopes/:id/documents/order', envelope: 'single', data: signDocumentListSchema },
  { method: 'GET', route: '/api/sign/templates', envelope: 'list', data: signTemplateSummarySchema },
  { method: 'POST', route: '/api/sign/templates', envelope: 'single', data: signEnvelopeDetailSchema },
  { method: 'GET', route: '/api/sign/templates/:id', envelope: 'single', data: signEnvelopeDetailSchema },
  { method: 'PATCH', route: '/api/sign/templates/:id', envelope: 'single', data: signEnvelopeDetailSchema },
  { method: 'POST', route: '/api/sign/templates/:id/use', envelope: 'single', data: signEnvelopeDetailSchema },
  { method: 'POST', route: '/api/sign/templates/:id/roles', envelope: 'single', data: signRecipientDtoSchema },
  { method: 'PATCH', route: '/api/sign/templates/:id/roles/:roleId', envelope: 'single', data: signRecipientDtoSchema },
  { method: 'PUT', route: '/api/sign/templates/:id/fields', envelope: 'single', data: signFieldListSchema },
  { method: 'POST', route: '/api/sign/templates/:id/documents', envelope: 'single', data: signDocumentDtoSchema },
  { method: 'POST', route: '/api/sign/templates/:id/documents/from-drive', envelope: 'single', data: signDocumentDtoSchema },
  { method: 'PUT', route: '/api/sign/templates/:id/documents/order', envelope: 'single', data: signDocumentListSchema },
  // core: WeldObjects definitions
  { method: 'GET', route: '/api/custom-objects', envelope: 'list', data: customObjectSchema },
  { method: 'GET', route: '/api/custom-objects/:id', envelope: 'single', data: customObjectSchema },
  { method: 'GET', route: '/api/custom-objects/:id/delete-impact', envelope: 'single', data: customObjectDeleteImpactSchema },
  { method: 'PUT', route: '/api/custom-objects/reorder', envelope: 'single', data: reorderResultSchema },
  { method: 'POST', route: '/api/custom-objects', envelope: 'single', data: customObjectSchema },
  { method: 'PUT', route: '/api/custom-objects/:id', envelope: 'single', data: customObjectSchema },
  { method: 'GET', route: '/api/custom-objects/link-targets', envelope: 'array', data: customObjectLinkTargetSchema },
  { method: 'GET', route: '/api/custom-objects/:id/links', envelope: 'array', data: customObjectLinkSchema },
  { method: 'POST', route: '/api/custom-objects/:id/links', envelope: 'single', data: customObjectLinkSchema },
  { method: 'PUT', route: '/api/custom-objects/:id/links/:linkId', envelope: 'single', data: customObjectLinkSchema },
  // core: WeldObjects records and relationships
  { method: 'GET', route: '/api/objects/:slug/records', envelope: 'list', data: customObjectRecordSchema },
  { method: 'GET', route: '/api/objects/:slug/records/:id', envelope: 'single', data: customObjectRecordSchema },
  { method: 'POST', route: '/api/objects/:slug/records', envelope: 'single', data: customObjectRecordSchema },
  { method: 'PATCH', route: '/api/objects/:slug/records/:id', envelope: 'single', data: customObjectRecordSchema },
  { method: 'GET', route: '/api/objects/:slug/records/:id/links', envelope: 'array', data: customObjectLinkPanelSchema },
  { method: 'GET', route: '/api/objects/:slug/records/:id/links/:linkSlug', envelope: 'array', data: customObjectRelatedRecordSchema },
  { method: 'POST', route: '/api/objects/:slug/records/:id/links/:linkSlug/:targetId', envelope: 'array', data: customObjectRelatedRecordSchema },
  { method: 'GET', route: '/api/related/:entityType/:entityId/custom-objects', envelope: 'array', data: customObjectReversePanelSchema },
  // core: custom fields
  { method: 'GET', route: '/api/custom-fields', envelope: 'array', data: customFieldDefinitionSchema },
  { method: 'GET', route: '/api/custom-fields/all', envelope: 'single', data: customFieldDefinitionsByEntityTypeSchema },
  { method: 'PUT', route: '/api/custom-fields/reorder', envelope: 'single', data: reorderResultSchema },
  { method: 'GET', route: '/api/custom-fields/:id', envelope: 'single', data: customFieldDefinitionSchema },
  { method: 'POST', route: '/api/custom-fields', envelope: 'single', data: customFieldDefinitionSchema },
  { method: 'PUT', route: '/api/custom-fields/:id', envelope: 'single', data: customFieldDefinitionSchema },
  { method: 'DELETE', route: '/api/custom-fields/:id', envelope: 'single', data: customFieldDeletedSchema },
  // core: object templates
  { method: 'GET', route: '/api/object-templates', envelope: 'list', data: objectTemplateSchema },
  { method: 'GET', route: '/api/object-templates/:id', envelope: 'single', data: objectTemplateSchema },
  { method: 'POST', route: '/api/object-templates', envelope: 'single', data: objectTemplateSchema },
  { method: 'PATCH', route: '/api/object-templates/:id', envelope: 'single', data: objectTemplateSchema },
  // core: grid views
  { method: 'GET', route: '/api/grid-views/:gridName', envelope: 'single', data: gridViewResponseSchema },
  { method: 'PUT', route: '/api/grid-views/:gridName', envelope: 'single', data: gridViewResponseSchema },
  // core: files (the lists page in memory: `{ success, data, pagination: { page, … } }`)
  { method: 'GET', route: '/api/files', envelope: 'single', data: unifiedFileSchema.array() },
  { method: 'GET', route: '/api/files/:id', envelope: 'single', data: driveFileSchema },
  { method: 'POST', route: '/api/files', envelope: 'single', data: driveFileSchema },
  { method: 'PATCH', route: '/api/files/:id', envelope: 'single', data: driveFileSchema },
  { method: 'DELETE', route: '/api/files/:id', envelope: 'single', data: deletedResultSchema },
  { method: 'POST', route: '/api/files/:id/star', envelope: 'single', data: starFileResultSchema },
  { method: 'POST', route: '/api/files/:id/pin', envelope: 'single', data: pinFileResultSchema },
  { method: 'PUT', route: '/api/files/:id/content', envelope: 'single', data: driveFileSchema },
  { method: 'POST', route: '/api/files/:id/move', envelope: 'single', data: moveFileResultSchema },
  { method: 'GET', route: '/api/files/:id/shares', envelope: 'single', data: driveItemSharingSchema },
  { method: 'PUT', route: '/api/files/:id/shares/:userId', envelope: 'single', data: driveItemSharingSchema },
  { method: 'DELETE', route: '/api/files/:id/shares/:userId', envelope: 'single', data: driveItemSharingSchema.nullable() },
  // core: folders
  { method: 'GET', route: '/api/folders', envelope: 'single', data: driveFolderSchema.array() },
  { method: 'GET', route: '/api/folders/:id', envelope: 'single', data: driveFolderSchema },
  { method: 'POST', route: '/api/folders', envelope: 'single', data: driveFolderSchema },
  { method: 'PATCH', route: '/api/folders/:id', envelope: 'single', data: driveFolderSchema },
  { method: 'DELETE', route: '/api/folders/:id', envelope: 'single', data: deletedResultSchema },
  { method: 'GET', route: '/api/folders/:id/shares', envelope: 'single', data: driveItemSharingSchema },
  { method: 'PUT', route: '/api/folders/:id/shares/:userId', envelope: 'single', data: driveItemSharingSchema },
  { method: 'DELETE', route: '/api/folders/:id/shares/:userId', envelope: 'single', data: driveItemSharingSchema.nullable() },
  // core: drive
  { method: 'GET', route: '/api/drive/all', envelope: 'single', data: unifiedFileSchema.array() },
  { method: 'GET', route: '/api/drive/stats', envelope: 'single', data: driveStatsSchema },
  { method: 'GET', route: '/api/drive/shared', envelope: 'single', data: sharedWithMeSchema },
  { method: 'GET', route: '/api/drive/trash', envelope: 'single', data: driveTrashSchema },
  { method: 'POST', route: '/api/drive/trash/restore/file/:id', envelope: 'single', data: restoredResultSchema },
  { method: 'POST', route: '/api/drive/trash/restore/folder/:id', envelope: 'single', data: restoredResultSchema },
  { method: 'DELETE', route: '/api/drive/trash/file/:id', envelope: 'single', data: deletedResultSchema },
  { method: 'DELETE', route: '/api/drive/trash/folder/:id', envelope: 'single', data: deletedResultSchema },
  { method: 'DELETE', route: '/api/drive/trash/empty', envelope: 'single', data: emptiedResultSchema },
  // core: search (`{ data: groups, query, permittedTypes, understanding }`)
  { method: 'POST', route: '/api/search', envelope: 'single', data: searchResultGroupSchema.array() },
  // core: WeldApps (user-created apps)
  { method: 'GET', route: '/api/user-apps', envelope: 'list', data: userAppSchema },
  { method: 'POST', route: '/api/user-apps', envelope: 'single', data: userAppSchema },
  { method: 'GET', route: '/api/user-apps/store', envelope: 'list', data: userAppStoreListingSchema },
  { method: 'GET', route: '/api/user-apps/store/:code', envelope: 'single', data: userAppStoreListingSchema },
  { method: 'GET', route: '/api/user-apps/installed', envelope: 'list', data: installedUserAppSchema },
  { method: 'GET', route: '/api/user-apps/developer-account', envelope: 'single', data: appDeveloperAccountSchema },
  { method: 'POST', route: '/api/user-apps/code/:code/session-token', envelope: 'single', data: userAppSessionTokenSchema },
  { method: 'POST', route: '/api/user-apps/code/:code/bundle-url', envelope: 'single', data: userAppBundleUrlSchema },
  { method: 'GET', route: '/api/user-apps/code/:code/dev-session', envelope: 'single', data: userAppDevSessionViewSchema.nullable() },
  { method: 'PUT', route: '/api/user-apps/code/:code/dev-session', envelope: 'single', data: userAppDevSessionViewSchema },
  { method: 'GET', route: '/api/user-apps/:id', envelope: 'single', data: userAppSchema },
  { method: 'PATCH', route: '/api/user-apps/:id', envelope: 'single', data: userAppSchema },
  { method: 'GET', route: '/api/user-apps/:id/versions', envelope: 'list', data: userAppVersionSchema },
  { method: 'POST', route: '/api/user-apps/:id/versions', envelope: 'single', data: userAppVersionSchema },
  { method: 'POST', route: '/api/user-apps/:id/submit', envelope: 'single', data: userAppSchema },
  { method: 'POST', route: '/api/user-apps/:id/review', envelope: 'single', data: userAppSchema },
  { method: 'POST', route: '/api/user-apps/:id/install', envelope: 'single', data: userAppInstallResultSchema },
  { method: 'POST', route: '/api/user-apps/:id/consent', envelope: 'single', data: userAppInstallSchema },
  { method: 'POST', route: '/api/user-apps/:id/oauth-client', envelope: 'single', data: userAppOauthClientSecretSchema },
  { method: 'GET', route: '/api/user-apps/:id/oauth-client', envelope: 'single', data: userAppOauthClientSchema },
  // core: CLI login, desktop sign-in handoff
  { method: 'POST', route: '/api/cli-auth/device', envelope: 'single', data: cliAuthDeviceSchema },
  { method: 'POST', route: '/api/cli-auth/token', envelope: 'single', data: cliAuthTokenSchema },
  { method: 'POST', route: '/api/cli-auth/approve', envelope: 'single', data: cliAuthApproveSchema },
  { method: 'POST', route: '/api/auth-desktop/ticket', envelope: 'single', data: desktopTicketSchema },
  // core: storage (the upload broker answers without the envelope)
  { method: 'POST', route: '/api/storage/generate-upload-url', envelope: 'body', data: generateUploadUrlResponseSchema },
  { method: 'POST', route: '/api/storage/confirm-upload', envelope: 'body', data: confirmUploadResponseSchema },
  { method: 'POST', route: '/api/storage/access', envelope: 'single', data: filesAccessSchema },
  { method: 'POST', route: '/api/storage/sign', envelope: 'single', data: signedObjectUrlsSchema },
  { method: 'POST', route: '/api/storage/migrate-private', envelope: 'single', data: privateFilesMigrationBatchSchema },
  // crm: pipelines, stages, field visibility, customer statuses, person ↔ company links
  { method: 'GET', route: '/api/pipelines', envelope: 'list', data: pipelineRowSchema },
  { method: 'GET', route: '/api/pipelines/:id', envelope: 'single', data: pipelineRowSchema },
  { method: 'POST', route: '/api/pipelines', envelope: 'single', data: pipelineRowSchema },
  { method: 'PATCH', route: '/api/pipelines/:id', envelope: 'single', data: pipelineRowSchema },
  { method: 'GET', route: '/api/pipeline-stages', envelope: 'list', data: pipelineStageSchema },
  { method: 'GET', route: '/api/pipeline-stages/:id', envelope: 'single', data: pipelineStageSchema },
  { method: 'POST', route: '/api/pipeline-stages', envelope: 'single', data: recordIdSchema },
  { method: 'PATCH', route: '/api/pipeline-stages/:id', envelope: 'single', data: recordIdSchema },
  { method: 'POST', route: '/api/pipeline-stages/reorder', envelope: 'single', data: reorderPipelineStagesResultSchema },
  { method: 'GET', route: '/api/pipeline-field-visibility/:id/field-visibility', envelope: 'single', data: pipelineFieldVisibilitySchema },
  { method: 'PATCH', route: '/api/pipeline-field-visibility/:id/field-visibility', envelope: 'single', data: pipelineFieldVisibilitySchema },
  { method: 'GET', route: '/api/customer-statuses', envelope: 'array', data: customerStatusSchema },
  { method: 'GET', route: '/api/customer-statuses/:id', envelope: 'single', data: customerStatusSchema },
  { method: 'POST', route: '/api/customer-statuses', envelope: 'single', data: customerStatusSchema },
  { method: 'PATCH', route: '/api/customer-statuses/:id', envelope: 'single', data: customerStatusSchema },
  { method: 'PUT', route: '/api/customer-statuses/reorder', envelope: 'array', data: customerStatusSchema },
  { method: 'POST', route: '/api/person-companies', envelope: 'single', data: personCompanySchema },
  { method: 'PATCH', route: '/api/person-companies/:id', envelope: 'single', data: personCompanySchema },
  // crm: activities, leads, opportunities
  { method: 'GET', route: '/api/activities', envelope: 'list', data: activitySchema },
  { method: 'GET', route: '/api/activities/:id', envelope: 'single', data: activitySchema },
  { method: 'POST', route: '/api/activities', envelope: 'single', data: recordIdSchema },
  { method: 'PATCH', route: '/api/activities/:id', envelope: 'single', data: recordIdSchema },
  { method: 'GET', route: '/api/leads', envelope: 'list', data: leadSchema },
  { method: 'GET', route: '/api/leads/:id', envelope: 'single', data: leadSchema },
  { method: 'POST', route: '/api/leads', envelope: 'single', data: recordIdSchema },
  { method: 'PATCH', route: '/api/leads/:id', envelope: 'single', data: recordIdSchema },
  { method: 'POST', route: '/api/leads/:id/qualify', envelope: 'single', data: leadQualifiedSchema },
  { method: 'POST', route: '/api/leads/:id/convert', envelope: 'single', data: leadConversionResultSchema },
  { method: 'GET', route: '/api/opportunities', envelope: 'list', data: opportunitySchema },
  { method: 'GET', route: '/api/opportunities/:id', envelope: 'single', data: opportunitySchema },
  { method: 'POST', route: '/api/opportunities', envelope: 'single', data: recordIdSchema },
  { method: 'PATCH', route: '/api/opportunities/:id', envelope: 'single', data: recordIdSchema },
  // crm: lists
  { method: 'GET', route: '/api/lists', envelope: 'list', data: listEntitySchema },
  { method: 'GET', route: '/api/lists/:id', envelope: 'single', data: listEntitySchema },
  { method: 'POST', route: '/api/lists', envelope: 'single', data: listEntitySchema },
  { method: 'PATCH', route: '/api/lists/:id', envelope: 'single', data: listEntitySchema },
  { method: 'GET', route: '/api/lists/:id/members', envelope: 'array', data: listMemberSchema },
  { method: 'POST', route: '/api/lists/:id/members', envelope: 'single', data: listMembersAddedSchema },
  // crm: companies
  { method: 'GET', route: '/api/companies', envelope: 'list', data: companyRowSchema },
  { method: 'GET', route: '/api/companies/export', envelope: 'array', data: companyRowSchema },
  { method: 'POST', route: '/api/companies/import', envelope: 'single', data: importResultSchema },
  { method: 'POST', route: '/api/companies/bulk-update', envelope: 'single', data: bulkUpdateResultSchema },
  { method: 'GET', route: '/api/companies/:id', envelope: 'single', data: companyRowSchema },
  { method: 'POST', route: '/api/companies', envelope: 'single', data: companyRowSchema },
  { method: 'PATCH', route: '/api/companies/:id', envelope: 'single', data: companyRowSchema },
  { method: 'POST', route: '/api/companies/:id/archive', envelope: 'single', data: companyRowSchema },
  { method: 'POST', route: '/api/companies/:id/unarchive', envelope: 'single', data: companyRowSchema },
  { method: 'POST', route: '/api/companies/:id/refresh-logo', envelope: 'single', data: companyRowSchema },
  { method: 'GET', route: '/api/companies/:id/people', envelope: 'array', data: companyPersonLinkSchema },
  { method: 'GET', route: '/api/companies/:id/detail', envelope: 'single', data: companyDetailSchema },
  { method: 'GET', route: '/api/companies/:id/navigation', envelope: 'single', data: recordNavigationSchema },
  // crm: end
];

/** null when valid, else why not. */
type Validator = (body: unknown) => string | null;

/** Every item of `data` against the route's item schema. */
function validateItems(entry: RouteSchema, data: unknown): string | null {
  if (!Array.isArray(data)) return '`data` is not an array';
  for (const [i, item] of data.entries()) {
    const result = entry.data.safeParse(item);
    if (!result.success) return `data[${i}]: ${result.error.message}`;
  }
  return null;
}

function validate(entry: RouteSchema, body: unknown): string | null {
  if (entry.envelope === 'body') {
    const result = entry.data.safeParse(body);
    return result.success ? null : result.error.message;
  }
  if (!body || typeof body !== 'object' || !('data' in body)) return 'no `data` in the response envelope';
  const data = (body as { data: unknown }).data;
  if (entry.envelope === 'array') return validateItems(entry, data);
  if (entry.envelope === 'list') {
    const pagination = (body as { pagination?: unknown }).pagination as Record<string, unknown> | undefined;
    if (
      Array.isArray(data) &&
      (!pagination ||
        typeof pagination.totalCount !== 'number' ||
        typeof pagination.hasMore !== 'boolean' ||
        !(typeof pagination.cursor === 'string' || pagination.cursor === null))
    ) {
      return '`pagination` is not { totalCount, hasMore, cursor }';
    }
    return validateItems(entry, data);
  }
  const result = entry.data.safeParse(data);
  return result.success ? null : result.error.message;
}

/** The validator registered for a route, if any. */
export function schemaFor(method: string, route: string): Validator | undefined {
  const entry = ROUTES.find((r) => r.method === method && r.route === route);
  return entry ? (body) => validate(entry, body) : undefined;
}

/** Every registered route, for the coverage report. */
export function registeredRoutes(): ReadonlyArray<{ method: string; route: string }> {
  return ROUTES.map(({ method, route }) => ({ method, route }));
}
