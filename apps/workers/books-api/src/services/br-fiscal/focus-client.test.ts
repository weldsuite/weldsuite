import { describe, expect, it } from 'vitest';
import { accessKeyOf, FiscalProviderError, FocusClient, mapFocusStatus } from './focus-client';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined });
    const next = responses.shift();
    if (!next) throw new Error('no response queued');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls, impl };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('FocusClient', () => {
  it('posts with Basic auth (token as user, empty password) to the environment host', async () => {
    const { calls, impl } = fakeFetch([json({ ref: 'inv-1', status: 'processando_autorizacao' }, 202)]);
    const client = new FocusClient({ token: 'tok123', environment: 'homologacao', fetch: impl });
    const res = await client.submit('nfe', 'inv-1', { natureza_operacao: 'Venda' });
    expect(res.status).toBe(202);
    expect(calls[0].url).toBe('https://homologacao.focusnfe.com.br/v2/nfe?ref=inv-1');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.Authorization).toBe(`Basic ${btoa('tok123:')}`);
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ natureza_operacao: 'Venda' });
    expect(new FocusClient({ token: 't', environment: 'producao' }).baseUrl).toBe('https://api.focusnfe.com.br');
  });

  it('asks for the full NF-e on GET, and cancels with a justificativa body', async () => {
    const { calls, impl } = fakeFetch([json({ status: 'autorizado' }), json({ status: 'cancelado' })]);
    const client = new FocusClient({ token: 't', environment: 'producao', fetch: impl });
    await client.get('nfe', 'inv-1');
    await client.cancel('nfsen', 'inv-2', 'Emissao em duplicidade');
    expect(calls[0].url).toBe('https://api.focusnfe.com.br/v2/nfe/inv-1?completa=1');
    expect(calls[1].url).toBe('https://api.focusnfe.com.br/v2/nfsen/inv-2');
    expect(calls[1].method).toBe('DELETE');
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({ justificativa: 'Emissao em duplicidade' });
  });

  it('turns a 422 into a FiscalProviderError with codigo and itemised errors', async () => {
    const { impl } = fakeFetch([
      json({ codigo: 'erro_validacao_schema', mensagem: 'Erro na validação do Schema XML', erros: [{ mensagem: 'Tipo documento não pode ser vazio', campo: 'tipo_documento' }] }, 422),
    ]);
    const client = new FocusClient({ token: 't', environment: 'producao', fetch: impl });
    const err = await client.submit('nfe', 'x', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FiscalProviderError);
    const provider = err as FiscalProviderError;
    expect(provider.status).toBe(422);
    expect(provider.codigo).toBe('erro_validacao_schema');
    expect(provider.isRejection).toBe(true);
    expect(provider.detail).toBe('Erro na validação do Schema XML (tipo_documento: Tipo documento não pode ser vazio)');
  });

  it('reads the HTML 401 as a token failure and a network error as status 0', async () => {
    const { impl } = fakeFetch([new Response('HTTP Basic: Access denied', { status: 401, headers: { 'Content-Type': 'text/html' } }), new TypeError('fetch failed')]);
    const client = new FocusClient({ token: 'bad', environment: 'producao', fetch: impl });
    const auth = (await client.listHooks().catch((e: unknown) => e)) as FiscalProviderError;
    expect(auth.isAuthFailure).toBe(true);
    expect(auth.message).toBe('Focus NFe rejected the token');
    const down = (await client.listHooks().catch((e: unknown) => e)) as FiscalProviderError;
    expect(down.status).toBe(0);
    expect(down.isRejection).toBe(false);
  });

  it('waits out a short rate limit once, and gives up on a long one', async () => {
    const { calls, impl } = fakeFetch([json({ mensagem: 'limite' }, 429, { 'Rate-Limit-Reset': '0' }), json({ status: 'autorizado' })]);
    const client = new FocusClient({ token: 't', environment: 'producao', fetch: impl });
    expect((await client.get('nfse', 'a')).data.status).toBe('autorizado');
    expect(calls).toHaveLength(2);

    const long = fakeFetch([json({}, 429, { 'Rate-Limit-Reset': '40' })]);
    const limited = (await new FocusClient({ token: 't', environment: 'producao', fetch: long.impl }).get('nfse', 'a').catch((e: unknown) => e)) as FiscalProviderError;
    expect(limited.status).toBe(429);
    expect(limited.retryAfterSeconds).toBe(40);
    expect(long.calls).toHaveLength(1);
  });

  it('reads the list of received NF-e with its paging headers', async () => {
    const { calls, impl } = fakeFetch([json([{ chave_nfe: 'k', versao: 7 }], 200, { 'X-Total-Count': '230', 'X-Max-Version': '412' })]);
    const client = new FocusClient({ token: 't', environment: 'producao', fetch: impl });
    const page = await client.listReceived({ cnpj: '12345678000123', versao: 7 });
    expect(calls[0].url).toBe('https://api.focusnfe.com.br/v2/nfes_recebidas?cnpj=12345678000123&versao=7');
    expect(page).toEqual({ items: [{ chave_nfe: 'k', versao: 7 }], totalCount: 230, maxVersion: 412 });
  });

  it('builds absolute URLs for relative caminho paths only', () => {
    const client = new FocusClient({ token: 't', environment: 'producao' });
    expect(client.absoluteUrl('/arquivos/x/nfe.xml')).toBe('https://api.focusnfe.com.br/arquivos/x/nfe.xml');
    expect(client.absoluteUrl('https://focusnfe.s3.sa-east-1.amazonaws.com/x.pdf')).toBe('https://focusnfe.s3.sa-east-1.amazonaws.com/x.pdf');
    expect(client.absoluteUrl(undefined)).toBeNull();
  });
});

describe('mapFocusStatus / accessKeyOf', () => {
  it('maps Focus statuses to ours', () => {
    expect(mapFocusStatus('autorizado')).toBe('authorized');
    expect(mapFocusStatus('processando_autorizacao')).toBe('processing');
    expect(mapFocusStatus('erro_autorizacao')).toBe('rejected');
    expect(mapFocusStatus('denegado')).toBe('rejected');
    expect(mapFocusStatus('cancelado')).toBe('cancelled');
    expect(mapFocusStatus('substituido')).toBe('cancelled');
    expect(mapFocusStatus(undefined)).toBe('processing');
  });

  it('strips the NFe prefix of an access key', () => {
    const key = '41190612345678000123550010000000221923094166';
    expect(accessKeyOf(`NFe${key}`)).toBe(key);
    expect(accessKeyOf(key)).toBe(key);
    expect(accessKeyOf('NFe123')).toBeNull();
    expect(accessKeyOf(undefined)).toBeNull();
  });
});
