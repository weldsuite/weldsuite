/**
 * Focus NFe REST API v2 client (https://doc.focusnfe.com.br): the electronic
 * fiscal document provider WeldBooks uses for Brazilian NF-e and NFS-e. A small
 * fetch wrapper, no SDK. Reference: docs/plans/weldbooks-br/focusnfe-api.md.
 *
 * - Auth is HTTP Basic with the company token as user and an empty password.
 * - Every non-2xx answer becomes a `FiscalProviderError` carrying Focus' own
 *   `codigo` / `mensagem` / `erros`, so routes can show the provider's text.
 * - A 2xx only means Focus accepted the request: the document's `status` says
 *   what SEFAZ or the prefeitura decided.
 * - A 429 waits out `Rate-Limit-Reset` once when it is short, then gives up.
 */

export type FocusEnvironment = 'homologacao' | 'producao';

export const FOCUS_BASE_URLS: Record<FocusEnvironment, string> = {
  homologacao: 'https://homologacao.focusnfe.com.br',
  producao: 'https://api.focusnfe.com.br',
};

/** nfe = NF-e (goods), nfse = municipal NFS-e, nfsen = NFS-e Nacional. */
export type FocusDocumentKind = 'nfe' | 'nfse' | 'nfsen';

export interface FocusErrorItem {
  codigo?: string;
  mensagem: string;
  campo?: string;
  correcao?: string | null;
}

/** A Focus answer's JSON body: every value arrives as a string, number, boolean, object or array. */
export type FocusRecord = Record<string, unknown>;

export class FiscalProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codigo?: string,
    readonly erros: FocusErrorItem[] = [],
    /** Seconds until the rate limit window resets (429 only). */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'FiscalProviderError';
  }

  /** The provider refused the content (validation, already processed...), as opposed to being down or rejecting the token. */
  get isRejection(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 401 && this.status !== 403 && this.status !== 429;
  }

  /** The token is wrong, blocked or not allowed to use this CNPJ. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** The provider's message plus its itemised errors, one line. */
  get detail(): string {
    const items = this.erros.map((e) => (e.campo ? `${e.campo}: ${e.mensagem}` : e.mensagem)).filter(Boolean);
    return items.length > 0 ? `${this.message} (${items.join('; ')})` : this.message;
  }
}

export interface FocusResponse<T = FocusRecord> {
  status: number;
  data: T;
  headers: Headers;
}

export interface FocusClientOptions {
  token: string;
  environment: FocusEnvironment;
  /** Injected by tests; the global fetch otherwise. */
  fetch?: typeof fetch;
}

/** Longest rate-limit wait the client sits through before retrying once. */
const MAX_RETRY_WAIT_SECONDS = 3;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function toErrorItems(value: unknown): FocusErrorItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is FocusRecord => typeof item === 'object' && item !== null)
    .map((item) => ({
      codigo: asString(item.codigo),
      mensagem: asString(item.mensagem) ?? 'Unknown error',
      campo: asString(item.campo),
      correcao: typeof item.correcao === 'string' ? item.correcao : null,
    }));
}

/** Focus status -> the fiscal_documents.status values. Unknown values read as still processing. */
export function mapFocusStatus(status: unknown): 'processing' | 'authorized' | 'rejected' | 'cancelled' | 'error' {
  switch (status) {
    case 'autorizado':
      return 'authorized';
    case 'cancelado':
    case 'substituido':
      return 'cancelled';
    case 'erro_autorizacao':
    case 'denegado':
      return 'rejected';
    case 'processando_autorizacao':
      return 'processing';
    default:
      return 'processing';
  }
}

/** The 44-digit NF-e access key of a Focus `chave_nfe` ("NFe" + 44 digits). */
export function accessKeyOf(chave: unknown): string | null {
  if (typeof chave !== 'string') return null;
  const digits = chave.replace(/^NFe/i, '');
  return /^\d{44}$/.test(digits) ? digits : null;
}

export class FocusClient {
  readonly baseUrl: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FocusClientOptions) {
    this.baseUrl = FOCUS_BASE_URLS[options.environment];
    this.auth = `Basic ${btoa(`${options.token}:`)}`;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** A `caminho_*` path from a Focus answer as an absolute URL (url_* fields already are). */
  absoluteUrl(path: unknown): string | null {
    if (typeof path !== 'string' || path === '') return null;
    if (/^https?:\/\//i.test(path)) return path;
    return `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  private async send(method: string, path: string, query: Record<string, string> | undefined, body: unknown, retried: boolean): Promise<Response> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { Authorization: this.auth, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new FiscalProviderError(`Focus NFe could not be reached: ${err instanceof Error ? err.message : 'network error'}`, 0);
    }
    if (response.status === 429 && !retried) {
      const wait = Number.parseInt(response.headers.get('Rate-Limit-Reset') ?? '', 10);
      if (Number.isFinite(wait) && wait >= 0 && wait <= MAX_RETRY_WAIT_SECONDS) {
        await new Promise((resolve) => setTimeout(resolve, wait * 1000 + 50));
        return this.send(method, path, query, body, true);
      }
    }
    return response;
  }

  /** A JSON request; any non-2xx answer throws a FiscalProviderError. */
  async request<T = FocusRecord>(
    method: string,
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<FocusResponse<T>> {
    const response = await this.send(method, path, options.query, options.body, false);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = undefined;
    }

    if (response.ok) {
      if (parsed === undefined) {
        throw new FiscalProviderError('Focus NFe answered with something that is not JSON', response.status);
      }
      return { status: response.status, data: parsed as T, headers: response.headers };
    }

    if (response.status === 401) {
      throw new FiscalProviderError('Focus NFe rejected the token', 401, 'token_invalido');
    }
    const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as FocusRecord) : {};
    const erros = toErrorItems(body.erros);
    if (response.status === 429) {
      const reset = Number.parseInt(response.headers.get('Rate-Limit-Reset') ?? '', 10);
      throw new FiscalProviderError(
        'Focus NFe rate limit reached, try again in a moment',
        429,
        'limite_requisicoes',
        [],
        Number.isFinite(reset) ? reset : undefined,
      );
    }
    // Empresas errors come without a top-level codigo/mensagem; the text of a failed call may not be JSON at all.
    const message = asString(body.mensagem) ?? erros[0]?.mensagem ?? (parsed === undefined ? text.slice(0, 200) : '');
    throw new FiscalProviderError(message || `Focus NFe answered ${response.status}`, response.status, asString(body.codigo) ?? erros[0]?.codigo, erros);
  }

  // --- Documents (NF-e, NFS-e, NFS-e Nacional) -------------------------------

  /** Send a document for authorization. NF-e answers 202 (or 201 when issued synchronously). */
  submit(kind: FocusDocumentKind, ref: string, payload: FocusRecord): Promise<FocusResponse> {
    return this.request('POST', `/v2/${kind}`, { query: { ref }, body: payload });
  }

  /** The document's current state. NF-e takes `completa=1` for the protocol and the full request. */
  get(kind: FocusDocumentKind, ref: string): Promise<FocusResponse> {
    return this.request('GET', `/v2/${kind}/${encodeURIComponent(ref)}`, kind === 'nfe' ? { query: { completa: '1' } } : {});
  }

  /** Cancel an authorized document (synchronous). */
  cancel(kind: FocusDocumentKind, ref: string, justificativa: string): Promise<FocusResponse> {
    return this.request('DELETE', `/v2/${kind}/${encodeURIComponent(ref)}`, { body: { justificativa } });
  }

  /** Carta de correção (NF-e only, synchronous). */
  correction(ref: string, correcao: string): Promise<FocusResponse> {
    return this.request('POST', `/v2/nfe/${encodeURIComponent(ref)}/carta_correcao`, { body: { correcao } });
  }

  // --- Webhooks ----------------------------------------------------------------

  listHooks(): Promise<FocusResponse<FocusRecord[]>> {
    return this.request<FocusRecord[]>('GET', '/v2/hooks');
  }

  createHook(args: { event: string; url: string; authorization: string; authorizationHeader?: string }): Promise<FocusResponse> {
    return this.request('POST', '/v2/hooks', {
      body: {
        event: args.event,
        url: args.url,
        authorization: args.authorization,
        ...(args.authorizationHeader ? { authorization_header: args.authorizationHeader } : {}),
      },
    });
  }

  deleteHook(id: string): Promise<FocusResponse> {
    return this.request('DELETE', `/v2/hooks/${encodeURIComponent(id)}`);
  }

  // --- NF-e received (MD-e) ------------------------------------------------------

  /** Received NF-e of a CNPJ changed since `versao`, at most 100 per call. */
  async listReceived(args: { cnpj: string; versao?: number }): Promise<{ items: FocusRecord[]; totalCount: number; maxVersion: number | null }> {
    const query: Record<string, string> = { cnpj: args.cnpj };
    if (args.versao) query.versao = String(args.versao);
    const res = await this.request<FocusRecord[]>('GET', '/v2/nfes_recebidas', { query });
    const total = Number.parseInt(res.headers.get('X-Total-Count') ?? '', 10);
    const max = Number.parseInt(res.headers.get('X-Max-Version') ?? '', 10);
    const items = Array.isArray(res.data) ? res.data : [];
    return { items, totalCount: Number.isFinite(total) ? total : items.length, maxVersion: Number.isFinite(max) ? max : null };
  }

  /** The XML (nfeProc) of a received NF-e; Focus has it once the full document is available (after ciência). */
  async receivedXml(accessKey: string): Promise<string | null> {
    const response = await this.send('GET', `/v2/nfes_recebidas/${accessKey}.xml`, undefined, undefined, false);
    if (response.status === 404) return null;
    const text = await response.text();
    if (!response.ok) {
      throw new FiscalProviderError(`Focus NFe could not return the XML (${response.status})`, response.status);
    }
    return text;
  }

  /** Manifestação do destinatário on a received NF-e. */
  manifest(accessKey: string, tipo: string, justificativa?: string): Promise<FocusResponse> {
    return this.request('POST', `/v2/nfes_recebidas/${accessKey}/manifesto`, {
      body: { tipo, ...(justificativa ? { justificativa } : {}) },
    });
  }
}
