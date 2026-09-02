import type {
  ApiError,
  CreateDraftBody,
  DataResponse,
  ForwardMessageBody,
  ListMessagesParams,
  ListResponse,
  MailAccount,
  MailAttachment,
  MailDraft,
  MailLabel,
  MailMessage,
  MeResponse,
  PatchMessageBody,
  PersonalAccount,
  PushTokenResult,
  RegisterPushTokenBody,
  ReplyMessageBody,
  SendMessageBody,
  UnreadCount,
  UpdateDraftBody,
  WeldmailCheckResult,
  WeldmailDomain,
  WeldmailReserveResult,
} from './types';

export class PersonalApiClientError extends Error {
  readonly isPersonalApiError = true;

  constructor(
    message: string,
    readonly status: number,
    readonly error: ApiError,
  ) {
    super(message);
    this.name = 'PersonalApiClientError';
  }
}

function buildQuery(params: Record<string, unknown> | object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const q = search.toString();
  return q ? `?${q}` : '';
}

/**
 * Lean client for personal-api (consumer WeldMail).
 * Responses use `{ data }` / `{ data, pagination }` envelopes.
 */
export class PersonalApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => Promise<string | null>,
  ) {}

  private url(path: string): string {
    const base = this.baseUrl.replace(/\/$/, '');
    return `${base}/api${path}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.getToken();
    if (!token) {
      throw new Error('Authentication required');
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(this.url(path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (response.status === 204) {
      return undefined as T;
    }

    const payload = await response.json().catch(() => ({
      error: { code: 'UNKNOWN', message: 'Request failed' },
    }));

    if (!response.ok) {
      const err = (payload as { error?: ApiError }).error ?? {
        code: 'UNKNOWN',
        message: `Request failed with status ${response.status}`,
      };
      throw new PersonalApiClientError(err.message, response.status, err);
    }

    return payload as T;
  }

  async onboard(body?: { displayName?: string }): Promise<DataResponse<PersonalAccount>> {
    return this.request('POST', '/onboard', body ?? {});
  }

  async me(): Promise<DataResponse<MeResponse>> {
    return this.request('GET', '/me');
  }

  readonly weldmail = {
    domain: (): Promise<DataResponse<WeldmailDomain>> =>
      this.request('GET', '/mail/weldmail/domain'),

    check: (address: string): Promise<DataResponse<WeldmailCheckResult>> =>
      this.request('POST', '/mail/weldmail/check', { address }),

    reserve: (body: {
      address: string;
      name?: string;
      displayName?: string;
    }): Promise<DataResponse<WeldmailReserveResult>> =>
      this.request('POST', '/mail/weldmail/reserve', body),
  };

  readonly mailAccounts = {
    list: (): Promise<DataResponse<MailAccount[]>> =>
      this.request('GET', '/mail/accounts'),

    get: (id: string): Promise<DataResponse<MailAccount>> =>
      this.request('GET', `/mail/accounts/${encodeURIComponent(id)}`),
  };

  readonly mailMessages = {
    list: (params?: ListMessagesParams): Promise<ListResponse<MailMessage>> =>
      this.request('GET', `/mail/messages${buildQuery(params ?? {})}`),

    /** Every message in one conversation, oldest first. */
    thread: (
      threadId: string,
      params?: Omit<ListMessagesParams, 'threadId'>,
    ): Promise<ListResponse<MailMessage>> =>
      this.request('GET', `/mail/messages${buildQuery({ ...params, threadId })}`),

    get: (id: string): Promise<DataResponse<MailMessage>> =>
      this.request('GET', `/mail/messages/${encodeURIComponent(id)}`),

    patch: (id: string, body: PatchMessageBody): Promise<DataResponse<MailMessage>> =>
      this.request('PATCH', `/mail/messages/${encodeURIComponent(id)}`, body),

    send: (body: SendMessageBody): Promise<DataResponse<MailMessage>> =>
      this.request('POST', '/mail/messages/send', body),

    reply: (id: string, body: ReplyMessageBody): Promise<DataResponse<MailMessage>> =>
      this.request('POST', `/mail/messages/${encodeURIComponent(id)}/reply`, body),

    forward: (id: string, body: ForwardMessageBody): Promise<DataResponse<MailMessage>> =>
      this.request('POST', `/mail/messages/${encodeURIComponent(id)}/forward`, body),

    attachments: (id: string): Promise<DataResponse<MailAttachment[]>> =>
      this.request('GET', `/mail/messages/${encodeURIComponent(id)}/attachments`),

    unreadCount: (): Promise<DataResponse<UnreadCount>> =>
      this.request('GET', '/mail/messages/unread-count'),
  };

  readonly pushTokens = {
    /** Upsert this device's push token for the signed-in personal account. */
    register: (body: RegisterPushTokenBody): Promise<DataResponse<PushTokenResult>> =>
      this.request('POST', '/push-tokens', body),

    /** Deactivate this device's token (workspace switch, sign-out). */
    unregister: (deviceId: string): Promise<DataResponse<PushTokenResult>> =>
      this.request('DELETE', `/push-tokens${buildQuery({ deviceId })}`),
  };

  readonly mailLabels = {
    list: (accountId?: string): Promise<DataResponse<MailLabel[]>> =>
      this.request('GET', `/mail/labels${buildQuery({ accountId })}`),
  };

  readonly mailDrafts = {
    list: (params?: {
      accountId?: string;
      cursor?: string;
      limit?: number;
    }): Promise<ListResponse<MailDraft>> =>
      this.request('GET', `/mail/drafts${buildQuery(params ?? {})}`),

    create: (body: CreateDraftBody): Promise<DataResponse<MailDraft>> =>
      this.request('POST', '/mail/drafts', body),

    update: (id: string, body: UpdateDraftBody): Promise<DataResponse<MailDraft>> =>
      this.request('PATCH', `/mail/drafts/${encodeURIComponent(id)}`, body),

    delete: (id: string): Promise<void> =>
      this.request('DELETE', `/mail/drafts/${encodeURIComponent(id)}`),
  };
}
