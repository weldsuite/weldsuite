/**
 * App-API mail-attachments domain client — flat `/api/mail-attachments/*`.
 */

import type { ClientApi, DataResponse } from '../types';
import type {
  CreateMailAttachmentInput,
  UpdateMailAttachmentInput,
  AssociateMailAttachmentsInput,
} from '../schemas/mail-attachments';

export interface MailAttachmentRow {
  id: string;
  messageId: string;
  fileName: string;
  contentType: string | null;
  size: number;
  isInline: boolean | null;
  contentId: string | null;
  contentDisposition: string | null;
  checksum: string | null;
  downloadUrl: string | null;
  storagePath: string | null;
  externalAttachmentId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export function createMailAttachmentsApi(api: ClientApi) {
  return {
    listForMessage(messageId: string): Promise<DataResponse<MailAttachmentRow[]>> {
      return api.get<DataResponse<MailAttachmentRow[]>>(
        `/mail-attachments/message/${messageId}`,
      );
    },

    get(id: string): Promise<DataResponse<MailAttachmentRow>> {
      return api.get<DataResponse<MailAttachmentRow>>(`/mail-attachments/${id}`);
    },

    create(data: CreateMailAttachmentInput): Promise<DataResponse<MailAttachmentRow>> {
      return api.post<DataResponse<MailAttachmentRow>>('/mail-attachments', data);
    },

    update(id: string, data: UpdateMailAttachmentInput): Promise<DataResponse<MailAttachmentRow>> {
      return api.patch<DataResponse<MailAttachmentRow>>(`/mail-attachments/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/mail-attachments/${id}`);
    },

    associate(
      data: AssociateMailAttachmentsInput,
    ): Promise<DataResponse<{ messageId: string; associated: number }>> {
      return api.post<DataResponse<{ messageId: string; associated: number }>>(
        '/mail-attachments/associate',
        data,
      );
    },
  };
}
