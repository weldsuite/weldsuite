/**
 * App-API legal entities domain client — `/api/legal-entities` (core).
 *
 * The companies of the workspace, shared by WeldBooks and WeldHR: their
 * registrations, bank accounts and who may see each one (per-entity access).
 * Bank account numbers only leave the API through `revealBankAccountNumber`,
 * which needs `legal_entities:reveal` and is logged. See
 * `../schemas/legal-entities.ts` and docs/plans/legal-entities.md.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateBankAccountInput,
  CreateLegalEntityInput,
  CreateRegistrationInput,
  LegalEntity,
  LegalEntityAccess,
  LegalEntityAccessMember,
  LegalEntityApp,
  LegalEntityBankAccount,
  LegalEntityEffectiveAccess,
  LegalEntityRegistration,
  LegalEntityUsage,
  UpdateBankAccountInput,
  UpdateLegalEntityInput,
  UpdateRegistrationInput,
} from '../schemas/legal-entities';

export interface ListLegalEntitiesParams {
  /** Only entities this app is enabled for. */
  app?: LegalEntityApp;
  includeArchived?: boolean;
}

export function createLegalEntitiesApi(api: ClientApi) {
  const base = '/legal-entities';
  const enc = encodeURIComponent;

  return {
    /** Entities the signed-in member sees, each with `myAccess`. */
    list(params: ListLegalEntitiesParams = {}): Promise<DataResponse<LegalEntity[]>> {
      return api.get<DataResponse<LegalEntity[]>>(
        `${base}${buildQueryString({ app: params.app, includeArchived: params.includeArchived ? 'true' : undefined })}`,
      );
    },
    get(id: string): Promise<DataResponse<LegalEntity>> {
      return api.get<DataResponse<LegalEntity>>(`${base}/${enc(id)}`);
    },
    /** The workspace default entity; `data` is null when there is none (or the member cannot see it). */
    getDefault(): Promise<DataResponse<LegalEntity | null>> {
      return api.get<DataResponse<LegalEntity | null>>(`${base}/default`);
    },
    usage(id: string): Promise<DataResponse<LegalEntityUsage[]>> {
      return api.get<DataResponse<LegalEntityUsage[]>>(`${base}/${enc(id)}/usage`);
    },
    create(input: CreateLegalEntityInput): Promise<DataResponse<LegalEntity>> {
      return api.post<DataResponse<LegalEntity>>(base, input);
    },
    update(id: string, input: UpdateLegalEntityInput): Promise<DataResponse<LegalEntity>> {
      return api.patch<DataResponse<LegalEntity>>(`${base}/${enc(id)}`, input);
    },
    makeDefault(id: string): Promise<DataResponse<LegalEntity>> {
      return api.post<DataResponse<LegalEntity>>(`${base}/${enc(id)}/make-default`);
    },
    archive(id: string): Promise<DataResponse<LegalEntity>> {
      return api.post<DataResponse<LegalEntity>>(`${base}/${enc(id)}/archive`);
    },
    unarchive(id: string): Promise<DataResponse<LegalEntity>> {
      return api.post<DataResponse<LegalEntity>>(`${base}/${enc(id)}/unarchive`);
    },
    /** Refused (409) for the default and while an app holds data for the entity. */
    delete(id: string): Promise<void> {
      return api.delete<void>(`${base}/${enc(id)}`);
    },

    // Registrations
    listRegistrations(id: string): Promise<DataResponse<LegalEntityRegistration[]>> {
      return api.get<DataResponse<LegalEntityRegistration[]>>(`${base}/${enc(id)}/registrations`);
    },
    createRegistration(id: string, input: CreateRegistrationInput): Promise<DataResponse<LegalEntityRegistration>> {
      return api.post<DataResponse<LegalEntityRegistration>>(`${base}/${enc(id)}/registrations`, input);
    },
    updateRegistration(id: string, registrationId: string, input: UpdateRegistrationInput): Promise<DataResponse<LegalEntityRegistration>> {
      return api.patch<DataResponse<LegalEntityRegistration>>(`${base}/${enc(id)}/registrations/${enc(registrationId)}`, input);
    },
    deleteRegistration(id: string, registrationId: string): Promise<void> {
      return api.delete<void>(`${base}/${enc(id)}/registrations/${enc(registrationId)}`);
    },

    // Bank accounts
    listBankAccounts(id: string): Promise<DataResponse<LegalEntityBankAccount[]>> {
      return api.get<DataResponse<LegalEntityBankAccount[]>>(`${base}/${enc(id)}/bank-accounts`);
    },
    createBankAccount(id: string, input: CreateBankAccountInput): Promise<DataResponse<LegalEntityBankAccount>> {
      return api.post<DataResponse<LegalEntityBankAccount>>(`${base}/${enc(id)}/bank-accounts`, input);
    },
    updateBankAccount(id: string, accountId: string, input: UpdateBankAccountInput): Promise<DataResponse<LegalEntityBankAccount>> {
      return api.patch<DataResponse<LegalEntityBankAccount>>(`${base}/${enc(id)}/bank-accounts/${enc(accountId)}`, input);
    },
    deleteBankAccount(id: string, accountId: string): Promise<void> {
      return api.delete<void>(`${base}/${enc(id)}/bank-accounts/${enc(accountId)}`);
    },
    /** Needs `legal_entities:reveal`; every reveal is logged. */
    revealBankAccountNumber(
      id: string,
      accountId: string,
      reason?: string,
    ): Promise<DataResponse<{ accountNumber: string; routingNumber: string | null }>> {
      return api.post<DataResponse<{ accountNumber: string; routingNumber: string | null }>>(
        `${base}/${enc(id)}/bank-accounts/${enc(accountId)}/reveal`,
        { reason },
      );
    },

    // Per-entity access (`legal_entities:manage`)
    getAccess(id: string): Promise<DataResponse<LegalEntityAccess>> {
      return api.get<DataResponse<LegalEntityAccess>>(`${base}/${enc(id)}/access`);
    },
    setRestricted(id: string, restricted: boolean): Promise<DataResponse<LegalEntityAccess>> {
      return api.patch<DataResponse<LegalEntityAccess>>(`${base}/${enc(id)}/access`, { restricted });
    },
    /** Add a member or change their role; `roleId` null = their workspace role. */
    setMember(id: string, userId: string, roleId: string | null): Promise<DataResponse<LegalEntityAccessMember>> {
      return api.put<DataResponse<LegalEntityAccessMember>>(`${base}/${enc(id)}/access/members/${enc(userId)}`, { roleId });
    },
    removeMember(id: string, userId: string): Promise<void> {
      return api.delete<void>(`${base}/${enc(id)}/access/members/${enc(userId)}`);
    },
    /** The signed-in member's role and permissions inside this entity (404 when they do not see it). */
    myAccess(id: string): Promise<DataResponse<LegalEntityEffectiveAccess>> {
      return api.get<DataResponse<LegalEntityEffectiveAccess>>(`${base}/${enc(id)}/my-access`);
    },
  };
}

export type LegalEntitiesApi = ReturnType<typeof createLegalEntitiesApi>;
