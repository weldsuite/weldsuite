/**
 * Person ↔ Company junction client — `/api/weldcrm/person-companies/*`.
 *
 * Used when the caller needs direct CRUD on the affiliation row itself
 * (linking a Person to a Company, changing the primary flag, ending a
 * historical employment). The list of affiliations is still fetched via
 * `companies.listPeople(companyId)` or `people.listCompanies(personId)`.
 */

import type { ClientApi, DataResponse } from '../types';
import type {
  CreatePersonCompanyInput,
  UpdatePersonCompanyInput,
  PersonCompany,
} from '../schemas/person-companies';

export function createPersonCompaniesApi(api: ClientApi) {
  return {
    create(data: CreatePersonCompanyInput): Promise<DataResponse<PersonCompany>> {
      return api.post<DataResponse<PersonCompany>>('/weldcrm/person-companies', data);
    },

    update(id: string, data: UpdatePersonCompanyInput): Promise<DataResponse<PersonCompany>> {
      return api.patch<DataResponse<PersonCompany>>(`/weldcrm/person-companies/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/weldcrm/person-companies/${id}`);
    },
  };
}
