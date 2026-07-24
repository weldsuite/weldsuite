import type { ClientApi, DataResponse } from '../types';
import type {
  CustomerStatus,
  CreateCustomerStatusInput,
  UpdateCustomerStatusInput,
} from '../schemas/customer-statuses';
import type {
  PipelineFieldVisibility,
  UpdatePipelineFieldVisibilityInput,
} from '../schemas/pipelines';

// Note: the legacy contacts CRUD surface (`listContacts`/`getContact`/
// `createContact`/`updateContact`/`deleteContact`) was removed here along
// with `../schemas/contacts` in the companies/people migration. Use the
// canonical hooks in
// apps/web/platform/components/objects/{company,person}/use-{company,person}-data.ts.

export function createWeldcrmApi(api: ClientApi) {
  return {
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
