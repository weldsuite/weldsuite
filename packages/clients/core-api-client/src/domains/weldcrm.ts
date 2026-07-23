import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  Contact,
  ContactDetail,
  CreateContactInput,
  UpdateContactInput,
  ListContactsQuery,
} from '../schemas/contacts';
import type {
  CustomerStatus,
  CreateCustomerStatusInput,
  UpdateCustomerStatusInput,
} from '../schemas/customer-statuses';
import type {
  PipelineFieldVisibility,
  UpdatePipelineFieldVisibilityInput,
} from '../schemas/pipelines';

export function createWeldcrmApi(api: ClientApi) {
  return {
    listContacts(params: ListContactsQuery = {}): Promise<ListResponse<Contact>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<Contact>>(`/weldcrm/contacts${query}`);
    },

    lookupContactsByEmails(emails: string[]): Promise<DataResponse<Array<{
      id: string;
      email: string;
      fullName: string | null;
      firstName: string;
      lastName: string;
      avatarUrl: string | null;
    }>>> {
      return api.post<DataResponse<Array<{
        id: string;
        email: string;
        fullName: string | null;
        firstName: string;
        lastName: string;
        avatarUrl: string | null;
      }>>>('/weldcrm/contacts/lookup-by-emails', { emails });
    },

    getContact(id: string): Promise<DataResponse<ContactDetail>> {
      return api.get<DataResponse<ContactDetail>>(`/weldcrm/contacts/${id}`);
    },

    createContact(data: CreateContactInput): Promise<DataResponse<{ id: string; customerIds: string[]; supplierIds: string[] }>> {
      return api.post<DataResponse<{ id: string; customerIds: string[]; supplierIds: string[] }>>('/weldcrm/contacts', data);
    },

    updateContact(id: string, data: UpdateContactInput): Promise<DataResponse<{ id: string }>> {
      return api.put<DataResponse<{ id: string }>>(`/weldcrm/contacts/${id}`, data);
    },

    deleteContact(id: string): Promise<void> {
      return api.delete<void>(`/weldcrm/contacts/${id}`);
    },

    customerStatuses: {
      list(): Promise<DataResponse<CustomerStatus[]>> {
        return api.get<DataResponse<CustomerStatus[]>>('/weldcrm/customer-statuses');
      },

      create(data: CreateCustomerStatusInput): Promise<DataResponse<CustomerStatus>> {
        return api.post<DataResponse<CustomerStatus>>('/weldcrm/customer-statuses', data);
      },

      update(id: string, data: UpdateCustomerStatusInput): Promise<DataResponse<CustomerStatus>> {
        return api.patch<DataResponse<CustomerStatus>>(`/weldcrm/customer-statuses/${id}`, data);
      },

      delete(id: string): Promise<void> {
        return api.delete<void>(`/weldcrm/customer-statuses/${id}`);
      },

      reorder(ids: string[]): Promise<DataResponse<CustomerStatus[]>> {
        return api.put<DataResponse<CustomerStatus[]>>('/weldcrm/customer-statuses/reorder', { ids });
      },
    },

    pipelineSettings: {
      getFieldVisibility(pipelineId: string): Promise<DataResponse<PipelineFieldVisibility>> {
        return api.get<DataResponse<PipelineFieldVisibility>>(
          `/weldcrm/pipelines/${pipelineId}/field-visibility`,
        );
      },

      updateFieldVisibility(
        pipelineId: string,
        data: UpdatePipelineFieldVisibilityInput,
      ): Promise<DataResponse<PipelineFieldVisibility>> {
        return api.patch<DataResponse<PipelineFieldVisibility>>(
          `/weldcrm/pipelines/${pipelineId}/field-visibility`,
          data,
        );
      },
    },
  };
}
