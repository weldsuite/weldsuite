# Focus NFe REST API v2: integration reference

Compiled 2026-10-15 from the official docs at https://doc.focusnfe.com.br/ (`/reference/*.md` OpenAPI pages, updated Apr-Oct 2026), the full field catalogues at https://campos.focusnfe.com.br/ (NF-e 4.00 `NotaFiscalXML` and NFS-e Nacional `EmissaoDPSXml`), and the legacy single-page docs (`focusnfe.com.br/doc/`, now a 301 to the new site; read through a 2025 web.archive.org snapshot) where the new reference is silent. Sources are given per section. Items marked **UNCONFIRMED** are inferences or conflicts between sources.

Conventions used below:
- `REQ` = required according to the field catalogue. `RT` = Reforma Tributária (IBS/CBS/IS) field.
- Enumerated codes are usually sent as strings or ints. The API echoes everything back as strings (see the GET examples), so parse responses as strings.

---

## 1. Basics

### 1.1 Base URLs

| Environment | Base URL | Fiscal validity |
|---|---|---|
| Homologação (sandbox) | `https://homologacao.focusnfe.com.br` | none |
| Produção | `https://api.focusnfe.com.br` | full |

All routes are prefixed with `/v2`, for example `https://api.focusnfe.com.br/v2/nfe`.

**Empresas API is production-only.** For tests, use `?dry_run=1` on create. A company created in production can then emit in both environments, each with its own token.

### 1.2 Authentication

- Use HTTP Basic (RFC 7617). The **token is the username and the password is empty**: `Authorization: Basic base64("<TOKEN>:")`. The trailing colon is required.
- The scheme is the same in both environments. Only the base URL and the token change.
- Legacy docs also accepted a `token` query parameter. Avoid it, because the token ends up in logs.
- A failed auth returns `401` with a `text/html` body `HTTP Basic: Access denied`, not JSON. Handle this case explicitly.
- **Token types** (guide "Como cadastrar uma empresa"; the guide calls them "Bearer Tokens", but they are still sent via Basic):
  - **Token Master**: account-level. Use it for the Empresas API (create/list companies) and the auxiliary APIs (CNPJ, CEP, NCM, CFOP, ...).
  - **Token de Homologação / Token de Produção**: per company (emitente). Use them for issuing and querying documents. `GET /v2/empresas/{id}` returns them as `token_homologacao` / `token_producao`.
- The `ref` you send is unique **per token**.

TS sketch (Workers):
```ts
const auth = 'Basic ' + btoa(`${token}:`);
await fetch(`${base}/v2/nfe?ref=${encodeURIComponent(ref)}`, {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
```

### 1.3 Referência (`ref`)

- `ref` is your own ID for an emission (query param on POST, path param on GET/DELETE). It is alphanumeric with **no special characters** (no accents, spaces, `@`, `/`). Your internal invoice ID is the typical choice.
- After a rejection (`erro_autorizacao`) you may **re-POST with the same ref** once the payload is fixed.
- Once a document has been **authorized**, the ref is permanently bound to it, even if the document is later cancelled. Re-posting it returns `422 already_processed` / `nfe_autorizada`.
- A ref already in flight returns `422 pending_operation` / `em_processamento`.

### 1.4 Rate limits

- The default is **100 requests/minute per token**. Every request costs 1 credit, whatever the document or method.
- Every response carries these headers:
  - `Rate-Limit-Limit`
  - `Rate-Limit-Remaining`
  - `Rate-Limit-Reset` (seconds until the window resets)
- Over the limit, the API returns **HTTP 429**. Wait `Rate-Limit-Reset` seconds before retrying.
- Support can raise the limit for high-volume accounts.
- Prefer webhooks to polling. If you must poll, use progressive backoff: NFS-e can take minutes because of municipal systems.

### 1.5 HTTP codes and the error envelope

| HTTP | Meaning |
|---|---|
| 200 | OK (query / sync op) |
| 201 | Created / accepted. NF-e returns `201` when authorized synchronously; NFS-e returns `201` when queued. |
| 202 | Accepted, async processing (NF-e async, NFS-e Nacional) |
| 400 | Invalid request (missing param, company not enabled, expired certificate...) |
| 401 | Bad token (HTML body) |
| 403 | Permission denied (token blocked / CNPJ not authorised for this token) |
| 404 | Not found |
| 415 | Body not parseable as JSON / empty body |
| 422 | Semantically invalid (already authorized, still processing, schema validation...) |
| 429 | Rate limit |
| 500 | Internal error |

A 2xx only means the API accepted the request. It **does not mean SEFAZ or the prefeitura authorized the document**. Always read the `status` field.

Error body (any 4xx):
```json
{
  "codigo": "erro_validacao_schema",
  "mensagem": "Erro na validação do Schema XML, verifique o detalhamento dos erros.",
  "erros": [ { "mensagem": "Tipo documento não pode ser vazio", "campo": "tipo_documento" } ]
}
```
- `erros[]` is optional.
- On NFS-e responses, error items are `{ codigo, mensagem, correcao }`. `correcao` is a fix hint and can be `null`.
- Empresas `400` errors come **without** the top-level `codigo`: `{"erros":[{"codigo":"parametros_invalidos","mensagem":"..."}]}`.

Common `codigo` values:
- `requisicao_invalida`
- `empresa_nao_habilitada` (400)
- `certificado_vencido` (400)
- `nfe_cancelada` (400)
- `permissao_negada` (403, e.g. "CNPJ do emitente não autorizado.")
- `nao_encontrado` (404; NF-e recebidas use `nao_encontrada`)
- `formato_invalido` (415)
- `erro_validacao_schema` (422)
- `erro_validacao` (422)
- `nfe_nao_autorizada` (422 on NF-e cancel; 400 on NFS-e cancel/CCe)
- `nfe_autorizada` / `already_processed` (422)
- `em_processamento` / `pending_operation` (422)

### 1.6 File paths (`caminho_*`)

- `caminho_xml_nota_fiscal`, `caminho_danfe`, `caminho_xml_cancelamento`, `caminho_xml_carta_correcao`, `caminho_pdf_carta_correcao` and `caminho_xml` (inutilização) are **relative paths**. Prefix them with the same base URL you called, e.g. `https://api.focusnfe.com.br` + `/arquivos/...-nfe.xml`.
- The NFS-e fields `url` (prefeitura / national portal mirror) and `url_danfse` (S3 URL) are **absolute**.
- Focus stores NF-e XMLs for the legal 5 years. Keep your own copy anyway.
- **UNCONFIRMED:** whether `/arquivos/...` needs Basic auth. The legacy docs just say "GET". Sending the Authorization header to the Focus host is harmless.
- `GET /v2/nfes_recebidas/{chave}.pdf` answers with a **302 to a pre-signed URL**. Fetch that URL **without** the Focus Authorization header. In Workers, use `redirect: 'manual'` and re-fetch `Location` without auth, rather than relying on the runtime to strip the header.

---

## 2. NF-e (modelo 55)

Source: `/reference/emitir_nfe.md`, `consultar_nfe.md`, `cancelar_nfe.md`, `emitir_carta_correcao.md`, `inutilizar_numeracao.md`, full field list `https://campos.focusnfe.com.br/nfe/NotaFiscalXML.html`.

| Method | Path | Notes |
|---|---|---|
| POST | `/v2/nfe?ref=REF` | Issue. Async by default (`202`, `status: processando_autorizacao`). If the company has `nfe_sincrono` enabled and the UF supports it, returns `201` with the final result. |
| GET | `/v2/nfe/REF` (`?completa=1`) | Query status |
| DELETE | `/v2/nfe/REF` | Cancel (synchronous). Body `{"justificativa": "..."}` |
| POST | `/v2/nfe/REF/carta_correcao` | CC-e (synchronous) |
| POST | `/v2/nfe/inutilizacao` | Void a number range (synchronous) |
| POST | `/v2/nfe/REF/hook` | Re-fire webhooks for this NF-e (empty body OK) |

Also documented but not detailed here:
- E-mail re-send
- Ator interessado
- Insucesso na entrega
- ECONF
- Generic events
- NF-e import
- DANFe preview
- DANFe etiqueta
- `GET` inutilizações

### 2.1 POST /v2/nfe?ref=REF: request body

**Gotcha: the item array key is `items` in requests** (OpenAPI schema and all legacy examples). Responses with `completa=1` echo it back as **`itens`**. The campos catalogue also lists `itens`. **UNCONFIRMED** whether the API accepts `itens` on input. Send `items`.

Omitted emitente fields are filled from the company record. Totals are auto-summed from items if omitted (see 2.1.4).

#### 2.1.1 Header

| Field | Type | Notes |
|---|---|---|
| `natureza_operacao` | String[1-60] REQ | e.g. "Venda de mercadoria" |
| `serie`, `numero` | Int | **Leave blank**: the API numbers automatically (recommended) |
| `data_emissao` | ISO 8601 datetime REQ | e.g. `"2026-03-30T12:40:37-03:00"` |
| `data_entrada_saida` | ISO datetime | optional |
| `tipo_documento` | REQ | `0` entrada, `1` saída |
| `local_destino` | REQ | `1` interna, `2` interestadual, `3` exterior |
| `finalidade_emissao` | REQ | `1` normal, `2` complementar, `3` ajuste, `4` devolução, `5` (RT) nota de crédito, `6` (RT) nota de débito |
| `tipo_nota_debito` / `tipo_nota_credito` | RT | required with finalidade 6 / 5 (codes 01-08 / 01-06) |
| `consumidor_final` | REQ | `0` normal, `1` consumidor final |
| `presenca_comprador` | REQ | `0` n/a, `1` presencial, `2` internet, `3` teleatendimento, `4` NFC-e entrega domicílio, `5` presencial fora do estabelecimento, `9` outros |
| `indicador_intermediario` | | `0` sem intermediador (default), `1` marketplace (then `cnpj_intermediario`, `id_intermediario`) |
| `municipio` | Int[7] | IBGE code of the ICMS fato gerador (defaults from company) |
| `ibs_cbs_municipio` | Int[7] RT | only when `presenca_comprador=5` and there is no destinatário address |
| `codigo_indicador_operacao_fornecimento` | Int[6] RT | `cIndOp` |
| `notas_referenciadas[]` | | `{ chave_nfe }` (or modelo 1 / produtor / ECF / `chave_cte` variants). Used for devolução and complementar |
| `informacoes_adicionais_contribuinte` | String[≤5000] | `infCpl` |
| `informacoes_adicionais_fisco` | String[≤2000] | `infAdFisco` |

#### 2.1.2 Emitente

| Field | Notes |
|---|---|
| `cnpj_emitente` | REQ, or `cpf_emitente`. Must be a company enabled on the token. |
| `inscricao_estadual_emitente` | catalogue says REQ |
| `nome_emitente`, `nome_fantasia_emitente`, `logradouro_emitente`, `numero_emitente`, `complemento_emitente`, `bairro_emitente`, `codigo_municipio_emitente`, `municipio_emitente`, `uf_emitente`, `cep_emitente`, `telefone_emitente` | Optional. Default from the company record. |
| `regime_tributario_emitente` (`CRT`) | `1` Simples Nacional, `2` SN excesso sublimite, `3` Regime Normal, `4` SN-MEI. Defaults from the company. |
| `inscricao_estadual_st_emitente`, `inscricao_municipal_emitente` + `cnae_fiscal_emitente` | `inscricao_municipal_emitente` and `cnae_fiscal_emitente` go together (NF-e conjugada with services) |

#### 2.1.3 Destinatário

| Field | Notes |
|---|---|
| `nome_destinatario` | REQ, String[2-60]. In homologação SEFAZ requires `"NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL"` (as in all examples) |
| `cnpj_destinatario` / `cpf_destinatario` / `id_estrangeiro_destinatario` | One of them |
| `indicador_inscricao_estadual_destinatario` | REQ. `1` contribuinte ICMS (send IE), `2` isento, `9` não contribuinte |
| `inscricao_estadual_destinatario` | required if it exists |
| `logradouro_destinatario` | REQ |
| `numero_destinatario` | REQ |
| `complemento_destinatario` | |
| `bairro_destinatario` | REQ |
| `codigo_municipio_destinatario` | Int[7]. Optional: the API resolves it from name+UF |
| `municipio_destinatario` | REQ |
| `uf_destinatario` | REQ. Omit for exterior |
| `cep_destinatario` | |
| `codigo_pais_destinatario` | only if not 1058 |
| `pais_destinatario` | only if not Brasil |
| `telefone_destinatario` | |
| `email_destinatario` | String[≤60]. Comma-separated for several addresses: all receive XML+DANFE by e-mail, but only the first goes into the XML. **The field is `email_destinatario`, not `email`.** |
| `inscricao_suframa_destinatario`, `inscricao_municipal_destinatario` | |

Also available:
- Retirada and entrega address blocks, with `_retirada` / `_entrega` suffixes.
- `pessoas_autorizadas[]` `{cnpj|cpf}` (autXML).

#### 2.1.4 Totals (all optional, auto-calculated as item sums if omitted)

Main totals:
- `valor_produtos` (sum of `valor_bruto` where `inclui_no_total=1`)
- `valor_frete`, `valor_seguro`, `valor_desconto`, `valor_outras_despesas`
- `valor_ipi`, `valor_pis`, `valor_cofins`, `valor_total_ii`, `valor_ipi_devolvido`
- `icms_base_calculo`, `icms_valor_total`, `icms_valor_total_desonerado`, `icms_base_calculo_st`, `icms_valor_total_st`
- `fcp_valor_total`, `fcp_valor_total_st`, `fcp_valor_total_retido_st`
- `valor_total_tributos` (Lei da Transparência; auto unless `consumidor_final=0` or the natureza contains REMESSA/EXPORTACAO/DEVOLUCAO)
- `valor_total`: if omitted it is `valor_produtos - valor_desconto - icms_valor_total_desonerado + icms_valor_total_st + valor_frete + valor_seguro + ...`

ISSQN totals (NF-e conjugada):
- `valor_total_servicos`, `issqn_base_calculo`, `issqn_valor_total`
- `data_prestacao_servico`
- `codigo_regime_especial_tributacao`

Federal withholdings:
- `pis_valor_retido`, `cofins_valor_retido`, `csll_valor_retido`
- `irrf_base_calculo`, `irrf_valor_retido`
- `prev_social_base_calculo`, `prev_social_valor_retido`

RT totals (all optional, computed):
- `ibs_cbs_base_calculo`
- `ibs_uf_valor_total`, `ibs_mun_valor_total`, `ibs_valor_total`
- `cbs_valor_total`
- `is_valor_total`
- the `*_diferimento`, `*_devolucao`, `*_credito_presumido`, `*_monofasico*` and `*_credito_estornado` totals
- `ibs_cbs_is_valor_total` (`vNFTot`)

#### 2.1.5 Transporte, cobrança, pagamento

Transporte:
- `modalidade_frete` REQ: `0` remetente/emitente, `1` destinatário, `2` terceiros, `3` próprio remetente, `4` próprio destinatário, `9` sem frete.
- Transportador: `cnpj_transportador` / `cpf_transportador`, `nome_transportador`, `inscricao_estadual_transportador`, `endereco_transportador`, `municipio_transportador`, `uf_transportador`.
- Veículo: `veiculo_placa`, `veiculo_uf`, `veiculo_rntc`.
- `volumes[]`: `quantidade`, `especie`, `marca`, `numero`, `peso_liquido`, `peso_bruto`, `lacres[{numero}]`.

Cobrança:
- Fatura: `numero_fatura`, `valor_original_fatura`, `valor_desconto_fatura`, `valor_liquido_fatura`.
- `duplicatas[]`: `{ numero: "001", data_vencimento: "YYYY-MM-DD", valor }`. Numbers have 3 digits and are sequential.

Pagamento:
- **`formas_pagamento[]`** (tag `pag`, 0-100 entries):

| Field | Notes |
|---|---|
| `indicador_pagamento` | `0` à vista, `1` a prazo |
| `forma_pagamento` (`tPag`) | `01` dinheiro, `02` cheque, `03` cartão crédito, `04` cartão débito, `05` cartão loja, `10`/`11`/`12`/`13` vales, `14` duplicata mercantil, `15` boleto, `16` depósito, `17` PIX dinâmico, `18` transferência/carteira digital, `19` fidelidade/cashback, `90` sem pagamento, `99` outros (+`descricao_pagamento`). The catalogue enum was truncated in my extract after 19, so check 20/21/22 there. `90` appears in the official example for a non-paid operation. |
| `valor_pagamento` | |
| `data_pagamento`, `cnpj_transacional`, `uf_transacional` | |
| `tipo_integracao` | `1` TEF/e-commerce integrated (then `cnpj_credenciadora` + `numero_autorizacao` are required), `2` POS |
| `bandeira_operadora` | `01` Visa, `02` Mastercard, `03` Amex, `06` Elo, ... `99` |
| `numero_autorizacao`, `cnpj_beneficiario`, `id_terminal_pagamento` | |

- `valor_troco`

#### 2.1.6 Item fields (`items[]`, 1-990 entries)

Product:

| Field | Type | Notes |
|---|---|---|
| `numero_item` | Int REQ | 1-based, sequential |
| `codigo_produto` | String[1-60] REQ | |
| `descricao` | String[1-120] REQ | |
| `codigo_ncm` | Int[2,8] REQ | 8 digits normally |
| `cest` | Int[7] | ST goods |
| `codigo_beneficio_fiscal` | String | `cBenef`. The example uses `"SEM CBENEF"` |
| `codigo_barras_comercial` / `codigo_barras_tributavel` | | GTIN or `"SEM GTIN"` |
| `cfop` | Int[4] REQ | e.g. 5102 (intra-state sale), 6102 (inter-state) |
| `unidade_comercial` | String[1-6] REQ | |
| `quantidade_comercial` | Decimal[11.0-4] REQ | |
| `valor_unitario_comercial` | Decimal[11.0-10] REQ | |
| `valor_bruto` | Decimal[13.2] | must equal qty × unit (auto if omitted) |
| `unidade_tributavel` / `quantidade_tributavel` / `valor_unitario_tributavel` | | default to the comercial values |
| `valor_frete`, `valor_seguro`, `valor_desconto`, `valor_outras_despesas` | | item-level (summed into totals) |
| `inclui_no_total` | | `1` (default) / `0` |
| `pedido_compra`, `numero_item_pedido_compra` | | |
| `informacoes_adicionais_item` | String[≤500] | |
| `valor_total_item` | RT | `vItem` |

ICMS (field names appear in the catalogue's description column with a `:` prefix):

| Field | Notes |
|---|---|
| `icms_origem` | REQ (not for MEI). `0` nacional, `1` estrangeira importação direta, `2` estrangeira mercado interno, `3`-`8` see catalogue |
| `icms_situacao_tributaria` | REQ. **Regime Normal CST:** `00`, `02`, `10`, `10_partilha`, `15`, `20`, `20_partilha`, `30`, `40`, `41`, `41_st`, `50`, `51`, `53`, `60`, `60_st`, `61`, `70`, `90`, `90_partilha`. **Simples Nacional CSOSN (same field):** `101` com crédito, `102` sem crédito, `103` isenção faixa, `201`, `202`, `203` (com ST), `300` imune, `400` não tributada, `500` ICMS cobrado anteriormente por ST, `900` outras. Required companion fields vary per CST; Focus blog link in the catalogue. |
| `icms_modalidade_base_calculo` | `0` MVA %, `1` pauta, `2` preço tabelado máx, `3` valor da operação |
| `icms_base_calculo`, `icms_reducao_base_calculo`, `icms_aliquota` (without FCP), `icms_valor` | |
| ST | `icms_modalidade_base_calculo_st`, `icms_margem_valor_adicionado_st`, `icms_reducao_base_calculo_st`, `icms_base_calculo_st`, `icms_aliquota_st`, `icms_valor_st` |
| Simples credit (CSOSN 101/201/900) | `icms_aliquota_credito_simples` (`pCredSN`), `icms_valor_credito_simples` (`vCredICMSSN`) |
| Diferimento (51/90) | `icms_percentual_diferimento`, `icms_valor_operacao`, `icms_valor_diferido` |
| Desoneração | `icms_valor_desonerado`, `icms_motivo_desoneracao`, `icms_deducao_desoneracao` |
| FCP | `fcp_percentual`, `fcp_base_calculo`, `fcp_valor` (+ `_st`, `_retido_st` variants) |
| Inter-state to end consumer (DIFAL) | `icms_base_calculo_uf_destino`, `fcp_percentual_uf_destino`, `icms_aliquota_interna_uf_destino`, `icms_aliquota_interestadual`, `icms_percentual_partilha` (default 100), `icms_valor_uf_destino`, `icms_valor_uf_remetente`, `fcp_valor_uf_destino` |
| 60/500 efetivo | `icms_base_calculo_retido_st`, `icms_aliquota_final`, `icms_valor_substituto`, `icms_valor_retido_st`, `icms_reducao_base_calculo_efetiva`, `icms_base_calculo_efetiva`, `icms_aliquota_efetiva`, `icms_valor_efetivo` |

IPI:

| Field | Notes |
|---|---|
| `ipi_situacao_tributaria` | `00`-`05`, `49` (entradas), `50`-`55`, `99` (saídas) |
| `ipi_codigo_enquadramento_legal` | Int[3]. **Required whenever IPI is sent**; use `999` if not applicable |
| `ipi_base_calculo`, `ipi_aliquota`, `ipi_valor` | |
| `ipi_quantidade_total`, `ipi_valor_por_unidade_tributavel` | pauta |
| `ipi_cnpj_produtor`, `ipi_codigo_selo_controle`, `ipi_quantidade_selo_controle` | |

PIS / COFINS (identical shape; replace `pis_` with `cofins_`):

| Field | Notes |
|---|---|
| `pis_situacao_tributaria` | REQ. `01`-`09`, `49`, `50`-`56`, `60`-`67`, `70`-`75`, `98`, `99` (e.g. `01` alíquota básica, `04` monofásica, `06` alíquota zero, `07` isenta, `08` sem incidência, `09` suspensão, `49` outras saídas, `99` outras) |
| `pis_base_calculo`, `pis_aliquota_porcentual`, `pis_valor` | percentage-based |
| `pis_quantidade_vendida`, `pis_aliquota_valor` | quantity-based (CST 03) |
| `pis_*_st`, `inclui_pis_st_no_total` | ST |

Other taxes:
- **II (import):** `ii_base_calculo`, `ii_despesas_aduaneiras`, `ii_valor`, `ii_valor_iof`, plus `documentos_importacao[]` with `adicoes[]`.
- **ISSQN (conjugada):** `issqn_base_calculo`, `issqn_aliquota`, `issqn_valor`, `issqn_codigo_municipio`, `issqn_item_lista_servico` (NN.NN), `issqn_indicador_exigibilidade`, etc.

**IBS/CBS/IS (Reforma Tributária, item level, all `RT`).** `ibs_cbs_situacao_tributaria` and `ibs_cbs_classificacao_tributaria` are flagged REQ in the catalogue. That means required when the RT group is sent, which is mandatory in 2026 for Regime Normal per the NT. **UNCONFIRMED:** Focus' exact enforcement date and whether Simples Nacional emitters may omit the group; check the Focus RT guide.

| Field | Tag | Notes |
|---|---|---|
| `ibs_cbs_situacao_tributaria` | CST | String[3], e.g. `"000"`, `"200"`, `"410"` |
| `ibs_cbs_classificacao_tributaria` | cClassTrib | String[6], e.g. `"000001"`, `"200038"` |
| `ibs_cbs_indicacao_doacao` | indDoacao | `1` if doação |
| `ibs_cbs_base_calculo` | vBC | |
| `ibs_uf_aliquota` | pIBSUF | **in percent**: 2026 test rate 0.1 means 0.1% |
| `ibs_uf_percentual_reducao_aliquota`, `ibs_uf_aliquota_efetiva`, `ibs_uf_valor` | | |
| `ibs_uf_percentual_diferimento`, `ibs_uf_valor_diferido`, `ibs_uf_percentual_devolvido`, `ibs_uf_valor_tributo_devolvido` | | |
| `ibs_mun_aliquota`, `ibs_mun_percentual_reducao_aliquota`, `ibs_mun_aliquota_efetiva`, `ibs_mun_valor` | | (2026: municipal rate 0) |
| `ibs_mun_*diferimento*`, `ibs_mun_*devolvido*` | | |
| `ibs_valor_total` | vIBS | |
| `cbs_aliquota` | pCBS | percent: 2026 test rate 0.9 |
| `cbs_percentual_reducao_aliquota`, `cbs_aliquota_efetiva`, `cbs_valor` | | |
| `cbs_percentual_diferimento`, `cbs_valor_diferido`, `cbs_percentual_devolvido`, `cbs_valor_tributo_devolvido` | | |
| `ibs_cbs_situacao_tributaria_regular`, `ibs_cbs_classificacao_tributaria_regular`, `ibs_aliquota_efetiva_regular_uf/_municipio`, `cbs_aliquota_efetiva_regular`, `*_valor_tributo_regular*` | | regular-tax group (gTribRegular) |
| `ibs_aliquota_competencia_uf/_municipio`, `cbs_aliquota_compra_governamental`, `*_valor_tributo_calculado*` | | compras governamentais (with header `tipo_compra_governamental`, `perc_reducao_aliquota_compra_governamental`, `tipo_operacao_governamental`) |
| `credito_presumido_oper_*`, `ibs_percentual_credito_presumido`, `ibs_valor_credito_presumido`, `cbs_credito_percentual`, `cbs_valor_credito_presumido`, `*_condicao_suspensiva` | | crédito presumido |
| `mono_ad_rem_*`, `mono_ad_valorem_*`, `mono_total_ibs_item`, `mono_total_cbs_item` | | fuel monofásico |
| `ibs_valor_transferido`, `cbs_valor_transferido`, `data_competencia_apuracao`, `ibs/cbs_valor_ajuste_competencia`, `ibs/cbs_valor_estorno_credito` | | transfer / adjust / estorno groups |
| `alczfm_cbs_*`, `credito_presumido_zfm_*`, `credito_presumido_ibs_zfm_classificacao` | | ZFM |
| `is_situacao_tributaria` (REQ RT), `is_classificacao_tributaria` (REQ RT), `is_base_calculo`, `is_aliquota`, `is_aliquota_especifica`, `is_unidade_tributavel`, `is_quantidade_tributavel`, `is_valor` | | Imposto Seletivo. Only for IS goods (REQ only when the IS group is used) |
| `chave_acesso_dfe_referenciado`, `numero_item_dfe_referenciado` | | item-level DF-e reference (credit/debit notes) |

#### 2.1.7 Example request (Simples Nacional sale, CSOSN 102, intra-state, with IBS/CBS 2026 test rates)

```json
POST /v2/nfe?ref=inv000123
{
  "natureza_operacao": "Venda de mercadoria",
  "data_emissao": "2026-10-15T10:00:00-03:00",
  "data_entrada_saida": "2026-10-15T10:00:00-03:00",
  "tipo_documento": 1,
  "local_destino": 1,
  "finalidade_emissao": 1,
  "consumidor_final": 0,
  "presenca_comprador": 2,
  "cnpj_emitente": "12345678000123",
  "inscricao_estadual_emitente": "123456789",
  "regime_tributario_emitente": 1,
  "nome_destinatario": "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL",
  "cnpj_destinatario": "99887766000155",
  "indicador_inscricao_estadual_destinatario": 1,
  "inscricao_estadual_destinatario": "140212370",
  "logradouro_destinatario": "Rua das Flores",
  "numero_destinatario": "123",
  "bairro_destinatario": "Centro",
  "municipio_destinatario": "São Paulo",
  "codigo_municipio_destinatario": "3550308",
  "uf_destinatario": "SP",
  "cep_destinatario": "01311000",
  "email_destinatario": "compras@cliente.com.br",
  "modalidade_frete": 9,
  "valor_produtos": 200.00,
  "valor_total": 200.00,
  "formas_pagamento": [
    { "indicador_pagamento": 0, "forma_pagamento": "17", "valor_pagamento": 200.00 }
  ],
  "items": [
    {
      "numero_item": 1,
      "codigo_produto": "SKU-1",
      "descricao": "Produto exemplo",
      "codigo_ncm": "49111090",
      "cfop": "5102",
      "unidade_comercial": "UN",
      "quantidade_comercial": 2,
      "valor_unitario_comercial": 100.00,
      "valor_bruto": 200.00,
      "unidade_tributavel": "UN",
      "quantidade_tributavel": 2,
      "valor_unitario_tributavel": 100.00,
      "inclui_no_total": 1,
      "icms_origem": 0,
      "icms_situacao_tributaria": "102",
      "pis_situacao_tributaria": "07",
      "cofins_situacao_tributaria": "07",
      "ibs_cbs_situacao_tributaria": "000",
      "ibs_cbs_classificacao_tributaria": "000001",
      "ibs_cbs_base_calculo": 200.00,
      "ibs_uf_aliquota": 0.1,
      "ibs_uf_valor": 0.20,
      "ibs_mun_aliquota": 0,
      "ibs_mun_valor": 0,
      "ibs_valor_total": 0.20,
      "cbs_aliquota": 0.9,
      "cbs_valor": 1.80
    }
  ]
}
```

Regime Normal item with ICMS 00 + IPI + PIS/COFINS 01:
```json
{
  "icms_origem": 0, "icms_situacao_tributaria": "00", "icms_modalidade_base_calculo": 3,
  "icms_base_calculo": 200.00, "icms_aliquota": 18, "icms_valor": 36.00,
  "ipi_situacao_tributaria": "50", "ipi_codigo_enquadramento_legal": "999",
  "ipi_base_calculo": 200.00, "ipi_aliquota": 5, "ipi_valor": 10.00,
  "pis_situacao_tributaria": "01", "pis_base_calculo": 200.00, "pis_aliquota_porcentual": 1.65, "pis_valor": 3.30,
  "cofins_situacao_tributaria": "01", "cofins_base_calculo": 200.00, "cofins_aliquota_porcentual": 7.6, "cofins_valor": 15.20
}
```

Rates are percentages: 18 means 18%. The official full example has `ibs_uf_aliquota: "0.1000"` with `ibs_uf_aliquota_efetiva: "0.0400"` after a 60% reduction. The `inclui_no_total=1` items feed `valor_produtos`. `valor_total` must match what the API recomputes, or SEFAZ rejects with 598 "Total da NF difere do somatório".

### 2.2 POST responses

```json
// 202 async
{ "cnpj_emitente": "12345678000123", "ref": "referencia_000899_nfe", "status": "processando_autorizacao" }

// 201 sync authorized
{
  "cnpj_emitente": "12345678000123", "ref": "referencia_000899_nfe", "status": "autorizado",
  "status_sefaz": "100", "mensagem_sefaz": "Autorizado o uso da NF-e",
  "chave_nfe": "NFe41190612345678000123550010000000221923094166",
  "numero": "22", "serie": "1",
  "caminho_xml_nota_fiscal": "/arquivos/12345678000123/201906/XMLs/41190612345678000123550010000000221923094166-nfe.xml",
  "caminho_danfe": "/arquivos/12345678000123/201906/DANFEs/41190612345678000123550010000000221923094166.pdf"
}
// 422 validation: {"codigo":"erro_validacao_schema","mensagem":"...","erros":[{"mensagem":"...","campo":"tipo_documento"}]}
```

`chave_nfe` carries the `NFe` prefix. The 44-digit key is `chave_nfe.slice(3)`. NF-e recebidas use the bare 44 digits.

### 2.3 GET /v2/nfe/REF[?completa=1]

| Field | Notes |
|---|---|
| `cnpj_emitente`, `ref` | |
| `status` | `processando_autorizacao` \| `autorizado` \| `cancelado` \| `erro_autorizacao` \| `denegado` |
| `status_sefaz`, `mensagem_sefaz` | cStat / xMotivo (`100` authorized, `135` event registered, `598` rejection...) |
| `chave_nfe`, `numero`, `serie` | when authorized |
| `caminho_xml_nota_fiscal`, `caminho_danfe` (+ `caminho_danfe_etiqueta`) | |
| `caminho_xml_cancelamento` | when cancelled |
| `caminho_xml_carta_correcao`, `caminho_pdf_carta_correcao`, `numero_carta_correcao` | when a CC-e exists |
| `erros[]` | on `erro_autorizacao`: `[{codigo, mensagem}]` |
| `protocolo` | present in the `completa` example |
| `tentativa_anterior` | `{status, serie, numero, chave_nfe, caminho_xml_nota_fiscal, caminho_xml_cancelamento}` after automatic contingency (SVC) re-send |
| with `completa=1` | `requisicao_nota_fiscal` (the full note echoed in API field names, items under `itens`), `protocolo_nota_fiscal` (`{versao, ambiente, versao_aplicativo, chave_nfe, data_recebimento, numero_protocolo, digest_value, status, motivo}`), `requisicao_cancelamento`, `protocolo_cancelamento`, `requisicao_carta_correcao`, `protocolo_carta_correcao` |

Status semantics:
- `erro_autorizacao`: you may re-POST the same ref.
- `denegado`: number and key are consumed. You cannot re-send, and must store the XML like an authorized note.

Examples:
```json
{ "status":"erro_autorizacao","status_sefaz":"598","mensagem_sefaz":"Rejeição: Total da NF difere do somatório dos valores que compõe o valor total da NF",
  "erros":[{"codigo":"","mensagem":"Total da NF difere do somatório dos valores que compõe o valor total da NF"}], "cnpj_emitente":"...","ref":"..." }
{ "status":"cancelado","status_sefaz":"135","mensagem_sefaz":"Evento registrado e vinculado a NF-e","chave_nfe":"NFe...","numero":"22","serie":"1",
  "caminho_xml_nota_fiscal":"/arquivos/.../...-nfe.xml","caminho_danfe":"/arquivos/.../....pdf","caminho_xml_cancelamento":"/arquivos/.../...-can.xml" }
```

404: `{"codigo":"nao_encontrado","mensagem":"Nota fiscal não encontrada."}`

### 2.4 DELETE /v2/nfe/REF (cancel)

- Synchronous.
- Body: `{ "justificativa": "Erro na emissão da nota fiscal" }`. **15-255 characters**, required.
- Allowed within 24 h of emission. Some UFs allow longer.
- Only works on `autorizado` notes. Otherwise it returns `422 {"codigo":"nfe_nao_autorizada"}`.

Response 200:
```json
{ "status": "cancelado", "status_sefaz": "135", "mensagem_sefaz": "Evento registrado e vinculado a NF-e",
  "caminho_xml_cancelamento": "/arquivos/.../...-can.xml" }
```
On failure, `status` is `erro_cancelamento`, with SEFAZ's code and message.

### 2.5 Carta de correção: POST /v2/nfe/REF/carta_correcao

- Synchronous.
- Body: `{ "correcao": "texto 15-1000 chars", "data_evento": "optional ISO datetime" }`.
- Up to 20 corrections; the last one prevails.
- Cannot change:
  - tax amounts or bases
  - emitente/destinatário identity
  - emission or exit dates

Response 200:
```json
{ "status": "autorizado", "status_sefaz": "135", "mensagem_sefaz": "Evento registrado e vinculado a NF-e",
  "caminho_xml_carta_correcao": "/arquivos/...", "caminho_pdf_carta_correcao": "/arquivos/...", "numero_carta_correcao": 1 }
```
`status` is `autorizado` or `erro_autorizacao`.

### 2.6 Inutilização: POST /v2/nfe/inutilizacao

- Synchronous.
- Body: `{ "cnpj", "serie", "numero_inicial", "numero_final", "justificativa" (≥15) }`.
- Response: `{status: "autorizado"|"erro_autorizacao", status_sefaz: 102, mensagem_sefaz, serie, numero_inicial, numero_final, modelo: 55, cnpj, caminho_xml, protocolo_sefaz}`.
- Normally you never need it, because the API manages numbering.

---

## 3. NFS-e municipal (`/v2/nfse`)

Sources: `/reference/emitir_nfse.md`, `consultar_nfse.md`, `cancelar_nfse.md`, plus the legacy field list. Each prefeitura has quirks; check Focus' "municípios integrados" page for your city. Municipalities migrating to the national standard must use NFS-e Nacional (section 4).

**A company cannot have `habilita_nfse` and `habilita_nfsen_producao` both on.** Decide per company which API it uses.

| Method | Path | |
|---|---|---|
| POST | `/v2/nfse?ref=REF` | Pre-validation is synchronous (400/422). If accepted: **201** with `processando_autorizacao`, then async. |
| GET | `/v2/nfse/REF` | |
| DELETE | `/v2/nfse/REF` | Synchronous. Body `{justificativa}` 15-255 chars. Some prefeituras do not allow webservice cancel. |
| POST | `/v2/nfse/REF/hook` | re-fire webhook |
| | e-mail re-send | also exists |

### 3.1 Request body (nested objects)

Root:

| Field | Notes |
|---|---|
| `data_emissao` | REQ. ISO 8601. Some cities drop the time |
| `natureza_operacao` | REQ, default `"1"`. `1` tributação no município, `2` fora do município, `3` isenção, `4` imune, `5` exig. suspensa judicial, `6` exig. suspensa administrativa |
| `regime_especial_tributacao` | `1` ME municipal, `2` estimativa, `3` sociedade de profissionais, `4` cooperativa, `5` MEI-SN, `6` ME/EPP-SN |
| `optante_simples_nacional` | boolean REQ |
| `incentivador_cultural` | boolean, default false |
| `codigo_obra`, `art` | construção civil |
| `numero_nfse_substituido`, `numero_rps_substituido`, `serie_rps_substituido`, `tipo_rps_substituido` | substitution |

`prestador`:

| Field | Notes |
|---|---|
| `cnpj` | REQ |
| `inscricao_municipal` | REQ |
| `codigo_municipio` | IBGE 7. The legacy docs mark it REQ; a 400 "prestador.codigo_municipio não informado" exists |

`tomador`:

| Field | Notes |
|---|---|
| `cpf` \| `cnpj` | one of them |
| `nif`, `motivo_ausencia_nif` (`0`/`1`/`2`) | RT, foreign tomador |
| `inscricao_municipal` | |
| `razao_social` | ≤115 |
| `telefone` | ≤11 digits |
| `email` | ≤80 |
| `endereco { logradouro, tipo_logradouro, numero, complemento, bairro, codigo_municipio, uf, cep }` | |

`servico`:

| Field | Notes |
|---|---|
| `valor_servicos` | REQ |
| `valor_deducoes`, `valor_pis`, `valor_cofins`, `valor_inss`, `valor_ir`, `valor_csll` | |
| `iss_retido` | boolean REQ |
| `valor_iss`, `valor_iss_retido`, `outras_retencoes` | some cities compute these themselves |
| `base_calculo` | defaults to `valor_servicos` |
| `aliquota` | ISS rate. **UNCONFIRMED unit**: legacy examples use `3` / `"2.92"` (percent); the new OpenAPI example shows `0.05`. Behaviour appears municipality-dependent, so test per city in homologação. |
| `desconto_incondicionado`, `desconto_condicionado` | |
| `item_lista_servico` | REQ. LC 116 code, e.g. `"0107"` / `"17.09"`; some cities now use the national list |
| `codigo_cnae` | 7 digits |
| `codigo_tributario_municipio` | city table. The new OpenAPI example uses `codigo_tributacao_municipio` but the schema and legacy docs say `codigo_tributario_municipio`. **Use `codigo_tributario_municipio`.** |
| `discriminacao` | REQ |
| `codigo_municipio` | REQ. IBGE code of the place of service |
| `percentual_total_tributos`, `fonte_total_tributos` | |
| **RT:** `codigo_nbs`, `codigo_indicador_operacao`, `ibs_cbs_classificacao_tributaria`, `ibs_cbs_situacao_tributaria`, `ibs_cbs_base_calculo`, `ibs_uf_aliquota`, `ibs_mun_aliquota`, `cbs_aliquota`, `ibs_uf_valor`, `ibs_mun_valor`, `cbs_valor` | Many cities ignore these during the transition |

`intermediario` (optional, ignored where unsupported):
- `cpf` / `cnpj`
- `nif`, `motivo_ausencia_nif`
- `inscricao_municipal`
- `razao_social`

Example (legacy docs):
```json
POST /v2/nfse?ref=12345
{
  "data_emissao": "2017-09-21T22:15:00",
  "natureza_operacao": "1",
  "optante_simples_nacional": true,
  "prestador": { "cnpj": "18765499000199", "inscricao_municipal": "12345", "codigo_municipio": "3516200" },
  "tomador": {
    "cnpj": "07504505000132",
    "razao_social": "Acras Tecnologia da Informação LTDA",
    "email": "contato@focusnfe.com.br",
    "endereco": { "logradouro": "Rua Dias da Rocha Filho", "numero": "999", "complemento": "Prédio 04 - Sala 34C",
                  "bairro": "Alto da XV", "codigo_municipio": "4106902", "uf": "PR", "cep": "80045165" }
  },
  "servico": {
    "aliquota": 3,
    "discriminacao": "Nota fiscal referente a serviços prestados",
    "iss_retido": false,
    "item_lista_servico": "0107",
    "codigo_tributario_municipio": "620910000",
    "codigo_municipio": "3516200",
    "valor_servicos": 1.0
  }
}
```

### 3.2 Responses

POST 201:
```json
{ "cnpj_prestador": "12345678000123", "ref": "123456", "numero_rps": "1", "serie_rps": "1", "tipo_rps": "1", "status": "processando_autorizacao" }
```

GET `/v2/nfse/REF` fields:

| Field | Notes |
|---|---|
| `cnpj_prestador`, `ref`, `numero_rps`, `serie_rps`, `tipo_rps` | |
| `status` | `processando_autorizacao` \| `autorizado` \| `erro_autorizacao` \| `cancelado` \| `substituido` (see `numero_nfse_substituta`) |
| `numero` | NFS-e number |
| `codigo_verificacao` | |
| `data_emissao` | |
| `url` | public mirror (prefeitura or Focus) |
| `url_danfse` | absolute S3 PDF; only some cities |
| `caminho_xml_nota_fiscal` | relative |
| `caminho_xml_cancelamento` | |
| `numero_nfse_substituida`, `numero_nfse_substituta` | |
| `erros[]` | `{codigo, mensagem, correcao}` |

```json
{ "cnpj_prestador":"12345678000123","ref":"123456","numero_rps":"1","serie_rps":"1","tipo_rps":"1","status":"autorizado",
  "numero":"1","codigo_verificacao":"ABC123","data_emissao":"2025-01-01T10:00:00-03:00",
  "url":"https://api.focusnfe.com.br/notas_fiscais_servico/chave_nfse.html",
  "caminho_xml_nota_fiscal":"/arquivos/12345678901_123/202501/XMLsNFSe/chave_nfse.xml",
  "url_danfse":"https://focusnfe.s3.sa-east-1.amazonaws.com/arquivos/12345678901_123/202501/DANFSEs/chave_nfse.pdf" }
{ "status":"erro_autorizacao", "erros":[{"codigo":"L99","mensagem":"Regime Especial de Tributação ausente/inválido","correcao":"Corrija o Regime Especial de Tributação"}], ... }
```

DELETE 200:
- `{"status":"cancelado"}`, or
- `{"status":"erro_cancelamento","erros":[{"codigo":"V999","mensagem":"NFSe fora do prazo de cancelamento permitido","correcao":null}]}`
- Not authorized: `400 {"codigo":"nfe_nao_autorizada"}`.

Other errors:
- `422 {"codigo":"erro_validacao","mensagem":"O emitente da nota fiscal é diferente do usado no primeiro envio"}`
- `422 {"codigo":"nfe_autorizada"}`
- `422 em_processamento`

---

## 4. NFS-e Nacional (padrão nacional / DPS): `/v2/nfsen`

Sources: `/reference/emitir_dps_nacional.md`, `consultar_nfse_nacional.md`, `cancelar_nfse_nacional.md`, full field list `https://campos.focusnfe.com.br/nfse_nacional/EmissaoDPSXml.html`.

| Method | Path | |
|---|---|---|
| POST | `/v2/nfsen?ref=REF` | 400/422 pre-validation sync; otherwise **202** `processando_autorizacao` (+ `protocolo`), then async |
| GET | `/v2/nfsen/REF` | |
| DELETE | `/v2/nfsen/REF` | Synchronous. Body `{justificativa}` |
| POST | `/v2/nfsen/REF/hook` | re-fire webhook |

Key differences from municipal NFS-e:
- **Flat body**, with suffixes `_prestador` / `_tomador` / `_intermediario` / `_destinatario` / `_obra` / `_evento` / `_imovel` instead of nested objects.
- National codes replace the city ones: `codigo_tributacao_nacional_iss` (cTribNac, 6 digits, e.g. `"010701"`) replaces `item_lista_servico`; optional `codigo_tributacao_municipal_iss` (3 digits) and `codigo_nbs` (9 digits).
- Simples is an enum (`codigo_opcao_simples_nacional`), not a boolean.
- The national environment computes ISS. Send `tributacao_iss` (and, for municipalities outside the national system, `percentual_aliquota_relativa_municipio`).

### 4.1 Main fields

DPS header:

| Field | Notes |
|---|---|
| `data_emissao` | REQ. `AAAA-MM-DDThh:mm:ssTZD` |
| `serie_dps` | Int[5] REQ. API range 00001-49999 |
| `numero_dps` | Int[15] REQ |
| `data_competencia` | REQ. `YYYY-MM-DD` |
| `emitente_dps` | REQ. `1` prestador (default), `2` tomador, `3` intermediário |
| `codigo_municipio_emissora` | Int[7] REQ |

Prestador:

| Field | Notes |
|---|---|
| `cnpj_prestador` \| `cpf_prestador` \| `nif_prestador` (+`motivo_ausencia_nif_prestador`) | REQ, one of them |
| `inscricao_municipal_prestador`, `razao_social_prestador` | |
| `codigo_municipio_prestador`, `cep_prestador`, `logradouro_prestador`, `numero_prestador`, `complemento_prestador`, `bairro_prestador` | address |
| `telefone_prestador`, `email_prestador` | |
| `codigo_opcao_simples_nacional` | REQ. `1` não optante, `2` MEI, `3` ME/EPP |
| `regime_tributario_simples_nacional` | `1` SN apura federal+ISS, `2` federal via SN + ISS fora, `3` tudo fora do SN |
| `regime_especial_tributacao` | REQ. `0` nenhum, `1` ato cooperado, `2` estimativa, `3` ME municipal, `4` notário, `5` profissional autônomo, `6` sociedade de profissionais, `9` outros |

Tomador:

| Field | Notes |
|---|---|
| `cnpj_tomador` \| `cpf_tomador` \| `nif_tomador` | `motivo_ausencia_nif_tomador` is flagged REQ when using NIF |
| `inscricao_municipal_tomador`, `razao_social_tomador` | |
| `codigo_municipio_tomador`, `cep_tomador`, `logradouro_tomador`, `numero_tomador`, `complemento_tomador`, `bairro_tomador` | address |
| `codigo_pais_ext_tomador`, `cep_ext_tomador`, `nome_cidade_ext_tomador`, `regiao_ext_tomador` | foreign address |
| `telefone_tomador`, `email_tomador` | |

Service:

| Field | Notes |
|---|---|
| `codigo_municipio_prestacao` | REQ |
| `codigo_pais_prestacao` | only outside Brazil |
| `codigo_tributacao_nacional_iss` | REQ |
| `codigo_tributacao_municipal_iss`, `codigo_nbs`, `codigo_interno_contribuinte` | |
| `descricao_servico` | REQ, ≤1000 |
| `informacoes_complementares` | ≤2000 |
| `pedido_compra`, `itens_pedido_compra[{numero_item_compra}]` | RT |

Values:

| Field | Notes |
|---|---|
| `valor_servico` | REQ |
| `desconto_incondicionado`, `desconto_condicionado` | |
| `percentual_deducao_servico` / `valor_deducao_servico` / `documentos[]` | deduction documents |
| `valor_recebido_intermediario` | |

ISSQN:

| Field | Notes |
|---|---|
| `tributacao_iss` | REQ. `1` tributável, `2` imunidade, `3` exportação, `4` não incidência |
| `tipo_imunidade`, `codigo_pais_exportacao` | |
| `tipo_exigibilidade_suspensao`, `numero_processo_suspensao` | |
| `numero_beneficio_municipal`, `valor_reducao_base_calculo` / `percentual_reducao_base_calculo` | |
| `tipo_retencao_iss` | `1` não retido, `2` retido pelo tomador, `3` retido pelo intermediário |
| `percentual_aliquota_relativa_municipio` | pAliq. **Percent.** Only needed when the incidence municipality is not in the national system |

Federal:

| Field | Notes |
|---|---|
| `situacao_tributaria_pis_cofins` | CST `00`-`09`, ... |
| `base_calculo_pis_cofins`, `aliquota_pis`, `aliquota_cofins`, `valor_pis`, `valor_cofins` | |
| `tipo_retencao_pis_cofins` | `0`-`9` |
| `valor_cp`, `valor_irrf` | |
| `valor_csll` | holds PIS+COFINS+CSLL retained, unified after the reform |

Approximate taxes:
- `valor_total_tributos_federais` / `_estaduais` / `_municipais`
- `percentual_total_tributos_*`
- `indicador_total_tributacao`
- `percentual_total_tributos_simples_nacional`

Also available:
- Substitution: `chave_nfse_substituida`, `codigo_justificativa_substituicao` (`01`-`05`, `99`), `motivo_substituicao`.
- Comércio exterior: `modo_prestacao`, `vinculo_negocio`, `codigo_moeda`, `valor_servico_ext`, `mecanismo_comercio_ext_*`, `movimentacao_temporaria_bens`, `mdic`, ...
- Obra (`*_obra`, `codigo_cib_obra` RT), evento (`*_evento`).

### 4.2 IBS/CBS (RT) fields in NFS-e Nacional

The national environment calculates the IBS/CBS amounts. Focus exposes **no rate or value fields** for nfsen, only classification, diferimento and context:

| Field | Notes |
|---|---|
| `finalidade_emissao` | REQ RT. `0` NFS-e regular |
| `consumidor_final` | REQ RT. `0`/`1` |
| `indicador_destinatario` | REQ RT. `0` tomador is the destinatário, `1` different (then the `*_destinatario` fields) |
| `ibs_cbs_situacao_tributaria` | REQ RT. CST, 3 digits |
| `ibs_cbs_classificacao_tributaria` | REQ RT. cClassTrib, 6 digits |
| `codigo_indicador_operacao` | RT. cIndOp, 6 digits |
| `indicador_operacao_zfm_alc`, `tipo_operacao_governamental`, `tipo_ente_governamental`, `chaves_nfse_referenciadas[{chave_nfse}]` | |
| `ibs_cbs_credito_codigo_classificacao`, `ibs_cbs_situacao_tributaria_regular`, `ibs_cbs_classificacao_tributaria_regular` | |
| `ibs_uf_percentual_diferimento`, `ibs_mun_percentual_diferimento`, `cbs_percentual_diferimento` | |
| `documentos_referenciados[]` | reembolso / repasse docs excluded from the base |
| `*_imovel` | services on real estate |

### 4.3 Example and responses

```json
POST /v2/nfsen?ref=srv000045
{
  "data_emissao": "2026-10-15T09:00:00-0300",
  "data_competencia": "2026-10-15",
  "serie_dps": 1,
  "numero_dps": 45,
  "emitente_dps": 1,
  "codigo_municipio_emissora": 4106902,
  "cnpj_prestador": "18765499000199",
  "inscricao_municipal_prestador": "12345",
  "codigo_opcao_simples_nacional": 3,
  "regime_tributario_simples_nacional": 1,
  "regime_especial_tributacao": 0,
  "cnpj_tomador": "07504505000132",
  "razao_social_tomador": "Cliente LTDA",
  "codigo_municipio_tomador": 4106902,
  "cep_tomador": "80045165",
  "logradouro_tomador": "Rua Dias da Rocha Filho",
  "numero_tomador": "999",
  "bairro_tomador": "Alto da XV",
  "email_tomador": "financeiro@cliente.com.br",
  "codigo_municipio_prestacao": 4106902,
  "codigo_tributacao_nacional_iss": "010701",
  "codigo_nbs": "115013000",
  "descricao_servico": "Desenvolvimento de software sob encomenda",
  "valor_servico": 1500.00,
  "tributacao_iss": 1,
  "tipo_retencao_iss": 1,
  "finalidade_emissao": 0,
  "consumidor_final": 0,
  "indicador_destinatario": 0,
  "ibs_cbs_situacao_tributaria": "000",
  "ibs_cbs_classificacao_tributaria": "000001"
}
```

The `codigo_nbs` value is illustrative. The official minimal example omits the RT fields entirely.

Responses:
- POST 202: `{"cnpj_prestador":"...","ref":"123456","status":"processando_autorizacao"}`. The schema also lists `protocolo`.
- 422: `{"codigo":"erro_validacao","mensagem":"Já existe um DPS com esta referência."}`.

GET `/v2/nfsen/REF`: same shape as municipal NFS-e.
- `status`, `numero`, `codigo_verificacao`, `data_emissao`
- `url`: national portal, `https://www.nfse.gov.br/consultapublica/?tpc=1&chave=<50-digit chave>`
- `caminho_xml_nota_fiscal`, `caminho_xml_cancelamento`, `url_danfse`
- `numero_rps` / `serie_rps` / `tipo_rps`
- `erros[{codigo, mensagem}]`, e.g. `E0014` duplicate DPS série/número

The 50-digit chave is in `url` and in the XML file name (`NFS<chave>-nfse.xml`). There is no dedicated `chave` field in the documented response (**UNCONFIRMED**; it may exist).

DELETE: body `{"justificativa":"Emissão em duplicidade"}`.
- Schema text: "necessária se o código de cancelamento for 4". No cancellation-code field is documented, so **always send a 15-255 char justificativa**.
- Responses: `{"status":"cancelado"}` / `{"status":"erro_cancelamento","erros":[...]}`.

---

## 5. Webhooks (gatilhos): `/v2/hooks`

Sources: `/reference/criar_webhook.md` (+ listar/consultar/excluir), `/reference/webhooks.md`, guide "Utilizando Webhooks", and the legacy docs (payload and authorization details, which the new reference omits).

| Method | Path | |
|---|---|---|
| POST | `/v2/hooks` | create |
| GET | `/v2/hooks` | list (for the token) |
| GET | `/v2/hooks/{id}` | get |
| DELETE | `/v2/hooks/{id}` | delete. Returns the hook + `"deleted": true` |
| POST | `/v2/{nfe\|nfse\|nfsen\|cte\|nfcom}/REF/hook`, `/v2/nfes_recebidas/CHAVE/hook` | re-fire the notification to all matching hooks. Empty body OK. Returns the array of hooks fired (or `[]`). |

Create body:
```json
{
  "cnpj": "12345678000123",
  "event": "nfe",
  "url": "https://books-api.weldsuite.org/webhooks/focusnfe/nfe",
  "authorization": "Bearer 9f0c...secret",
  "authorization_header": "Authorization"
}
```

| Field | Notes |
|---|---|
| `cnpj` \| `cpf` | Mutually exclusive. **Omit both to get a hook for every emission made with that token.** |
| `event` | REQ. `nfe`, `nfse`, `nfsen`, `nfe_recebida`, `nfe_recebida_falha_consulta`, `nfsen_recebida`, `cte_recebida`, `inutilizacao`, `cte`, `mdfe`, `nfcom`, `dce`, `nfce_contingencia`, `nfce_consulta_automatica` (legacy docs also list `nfse_recebida`) |
| `url` | REQ |
| `authorization` | optional. Value sent back on every delivery |
| `authorization_header` | optional. Header **name** used for `authorization`. Default `Authorization`. E.g. set `X-ApiKey` to receive `X-ApiKey: <authorization>` |

Response 200:
```json
{ "id": "Vj5rmkBq", "url": "...", "authorization": null, "authorization_header": null, "event": "nfe", "cnpj": "12345678000123" }
```
Legacy docs say GET also returns:
- `count_since`, `request_count`, `error_count`, `success_count`
- `empresa_id`, `nome`

**Limit: max 5 hooks per company per event.** The legacy status table also shows `400 "Já existe um gatilho para este evento."`. The two are contradictory, so expect duplicate-URL protection.

### 5.1 Delivery to your URL

- Delivery is an HTTP **POST** with a JSON body, **one document per call**.
- The body is **the same object as the document's GET** (non-`completa`).

NF-e (`event: nfe`) payload:
```json
{
  "cnpj_emitente": "07504505000132",
  "ref": "teste_webhooks",
  "status": "autorizado",
  "status_sefaz": "100",
  "mensagem_sefaz": "Autorizado o uso da NF-e",
  "chave_nfe": "NFe77777075045050001329999930000002999999991249",
  "numero": "1",
  "serie": "1",
  "caminho_xml_nota_fiscal": "/arquivos_development/99999999999972/201313/XMLs/...-nfe.xml",
  "caminho_danfe": "/arquivos_development/99999999999972/201313/DANFEs/....pdf"
}
```

NFS-e / NFS-e Nacional payload: `{ cnpj_prestador, ref, numero_rps, serie_rps, status, numero, codigo_verificacao, data_emissao, url, caminho_xml_nota_fiscal, erros[{codigo,mensagem,correcao}] }`, i.e. the GET `/v2/nfse[n]/REF` shape.

Events that fire:
- **NF-e:** authorization success, authorization error, inutilização, and contingency re-send in another environment.
- **NFS-e / NFS-e Nacional:** success, error.
- **Recebidas:** a new received document (NFe, CTe, NFSe), and a failure fetching new NF-e (`nfe_recebida_falha_consulta`).
- **Cancellation:** **UNCONFIRMED** whether a cancel done via the API also fires the hook. Cancel is synchronous, so you already have the result.
- **`nfe_recebida` payload: UNCONFIRMED.** Presumably the NF-e recebida summary object from section 6 (`chave_nfe`, `versao`, `situacao`, `manifestacao_destinatario`, ...). Verify with `POST /v2/nfes_recebidas/CHAVE/hook` in homologação.

Retries:
- Triggered by a non-2xx response or a connection failure.
- Schedule: 1 min, 30 min, 1 h, 3 h, 24 h, then the API gives up. The new guide says "up to 48 h" overall.
- Afterwards you must reconcile with GET.
- Reputation: a webhook failing mostly for 7 days is **auto-disabled**. Fast, consistent endpoints get priority.
- Answer **200/202 immediately** and process async (queue).

### 5.2 Authenticating incoming webhooks

- There is **no HMAC signature**. The only mechanism is the static secret you set in `authorization` (+ optional `authorization_header`), echoed as a request header on each delivery.
- Recommended:
  1. Generate a random secret per workspace or company.
  2. Register it.
  3. Constant-time compare the header in the Worker.
  4. Reject anything else.
- Alternative: put a Basic `user:pass` string in `authorization` (`"Basic base64(user:pass)"`).
- Treat the body as a hint: idempotently re-`GET /v2/nfe/REF` (or nfse/nfsen) with the company token to confirm the status before booking. This guards against spoofing and gives the authoritative payload.
- Include the workspace/company in the URL path, or rely on `cnpj_emitente` / `cnpj_prestador` + `ref`, to route.

---

## 6. NF-e recebidas (MD-e, inbound): `/v2/nfes_recebidas`

Sources: `/reference/consultar_nfes_recebidas.md`, `consultar_nfe_recebida_individual*.md`, `manifestar_nfe_recebida.md`, legacy docs.

Setup: the company needs `habilita_manifestacao: true` (Empresas API), a valid A1 certificate, and optionally `data_inicio_recebimento_nfe` (earlier documents are ignored and not billed; this cannot be changed once set).

| Method | Path | |
|---|---|---|
| GET | `/v2/nfes_recebidas?cnpj=CNPJ[&versao=N][&pendente=1][&pendente_ciencia=1]` | list. **Max 100 per call** |
| GET | `/v2/nfes_recebidas/CHAVE[?cnpj=][&completa=1]` | one note (summary, or full if `completa=1` and the full XML is available) |
| GET | `/v2/nfes_recebidas/CHAVE.json[?completa=1]` | same, as JSON |
| GET | `/v2/nfes_recebidas/CHAVE.xml` | XML (`nfeProc`) |
| GET | `/v2/nfes_recebidas/CHAVE.pdf` | DANFe via **302 → pre-signed URL** (drop auth on the follow-up GET) |
| GET | `/v2/nfes_recebidas/CHAVE/cancelamento.xml` | cancellation XML if it exists |
| GET | `/v2/nfes_recebidas/CHAVE/carta_correcao.xml` | last CC-e XML |
| POST | `/v2/nfes_recebidas/CHAVE/manifesto` | manifest (sync) |
| GET | `/v2/nfes_recebidas/CHAVE/manifesto` | last valid manifest (legacy docs) |
| POST | `/v2/nfes_recebidas/CHAVE/hook` | re-fire `nfe_recebida` webhook |

`CHAVE` is the bare 44-digit key, without the `NFe` prefix.

### 6.1 Incremental sync with `versao`

- Every received note has a `versao` number. It is unique per CNPJ and **bumped on any change** (full XML arrives after ciência, CC-e, cancellation).
- Store one high-water mark per CNPJ.
- Call `GET ?cnpj=X&versao=<last>`.
- Response headers:
  - `X-Total-Count`: total matching, beyond the 100 returned
  - `X-Max-Version`: use it as the next `versao`
- Loop while `X-Total-Count > 100`.

### 6.2 List item / summary fields

| Field | Notes |
|---|---|
| `nome_emitente`, `documento_emitente` | supplier CNPJ/CPF |
| `cnpj_destinatario` | your CNPJ |
| `chave_nfe` | 44 digits |
| `valor_total` | string |
| `data_emissao` | |
| `situacao` | `autorizada` \| `cancelada` \| `denegada` |
| `manifestacao_destinatario` | `null`/`nulo` \| `ciencia` \| `confirmacao` \| `desconhecimento` \| `nao_realizada` |
| `nfe_completa` | bool. Full XML available? Typically only after ciência |
| `tipo_nfe` | `"1"` saída / `"0"` entrada |
| `versao` | number |
| `digest_value` | |
| `numero_carta_correcao`, `carta_correcao`, `data_carta_correcao` | |
| `data_cancelamento`, `justificativa_cancelamento` | |
| with `completa=1` | `requisicao_nota_fiscal { ... full note in API field names, itens[] ... }` |

```json
[{
  "nome_emitente": "Empresa emitente Ltda.", "documento_emitente": "12345678000123",
  "chave_nfe": "41171179060190000182550010000002661875685069", "valor_total": "24560.00",
  "data_emissao": "2017-11-07T01:00:00-02:00", "situacao": "autorizada", "manifestacao_destinatario": "ciencia",
  "nfe_completa": true, "tipo_nfe": "1", "versao": 73, "digest_value": "/C5IuK5fCNVQV2rbwV0d8W12zsk=",
  "numero_carta_correcao": "1", "carta_correcao": "Algum texto da carta de correção.", "data_carta_correcao": "2017-11-07T14:31:48-02:00",
  "data_cancelamento": "2017-11-07T14:45:14-02:00", "justificativa_cancelamento": "Nota cancelada por algum motivo"
}]
```

Query filters:
- `pendente=1`: no final manifest yet (none, or only ciência).
- `pendente_ciencia=1`: no ciência yet.

### 6.3 Manifestação: POST /v2/nfes_recebidas/CHAVE/manifesto

Body:
- `{ "tipo": "ciencia" | "confirmacao" | "desconhecimento" | "nao_realizada", "justificativa": "..." }`
- `justificativa` is required for `nao_realizada`, 15-255 chars.

Meaning of each `tipo`:
- `ciencia`: operation known, outcome unknown. It usually unlocks the full XML.
- `confirmacao`: operation performed.
- `desconhecimento`: the company does not recognise the note.
- `nao_realizada`: operation known but not performed.

Responses (sync, HTTP 200 in both cases; check `status`):
```json
{ "status": "evento_registrado", "status_sefaz": "135", "mensagem_sefaz": "Evento registrado e vinculado a NF-e",
  "protocolo": "891170005150285", "tipo": "nao_realizada", "justificativa": "Fornecedor cancelou a operação devido a falta dos produtos em estoque" }
{ "status": "erro", "status_sefaz": "573", "mensagem_sefaz": "Rejeicao: Duplicidade de evento", "tipo": "confirmacao" }
```
The schema also lists `data_manifesto`.

Errors:
- `400 manifestacao_nao_aplicavel`
- `400 manifestacao_ja_vinculada`
- `400 requisicao_invalida` (missing tipo / justificativa < 15 / CNPJ not enabled for MD-e)
- `403 permissao_negada`
- `404 nao_encontrada`

---

## 7. Empresas API (`/v2/empresas`), summary

Sources: `/reference/criar_empresa.md`, `listar_empresas.md`, `atualizar_empresa.md`, `excluir_empresa.md`, guide "Como cadastrar uma empresa".

Basics:
- Production only. Authenticate with the **Token Master** (account token).
- `POST ?dry_run=1` simulates without saving.
- Store the returned numeric `id`.
- The body is a **flat JSON object**. Legacy prose mentions a `{empresa:{...}}` wrapper, but every example, old and new, is flat.

| Method | Path | |
|---|---|---|
| POST | `/v2/empresas[?dry_run=1]` | create |
| GET | `/v2/empresas[?cnpj=|cpf=][&offset=N]` | list. 50 per page, `X-Total-Count` header |
| GET | `/v2/empresas/{id}` | get. **Includes `token_producao` and `token_homologacao`** |
| PUT | `/v2/empresas/{id}` | update (partial fields OK) |
| DELETE | `/v2/empresas/{id}` | delete |

### 7.1 Create / update fields

Identity and address:
- `nome`, `nome_fantasia`, `cnpj` | `cpf`
- `inscricao_estadual`, `inscricao_municipal`
- `regime_tributario`: `1` SN, `2` SN excesso, `3` normal, `4` MEI
- `logradouro`, `numero`, `complemento`, `bairro`, `municipio`, `uf`, `cep`
- `telefone`, `email`

Certificate:
- **`arquivo_certificado_base64`**: the A1 `.pfx`/`.p12` as base64.
- **`senha_certificado`**.
- `certificado_especifico`: default false. A certificate upload then propagates to all companies with the same CNPJ root (matriz + filiais).
- Responses expose `certificado_valido_de`, `certificado_valido_ate` and `certificado_cnpj`. Use them for expiry alerts.
- Certificate errors are `422 erro_validacao` with `campo: "arquivo_certificado_base64"`: wrong password/format, CNPJ mismatch, expired.

Feature flags:
- `habilita_nfe`, `habilita_nfce`
- `habilita_nfse` (municipal) **xor** `habilita_nfsen_producao`; `habilita_nfsen_homologacao`
- `habilita_manifestacao` (NF-e recebidas), `habilita_manifestacao_cte`
- `habilita_nfsen_recebidas_producao/_homologacao`
- `habilita_cte`, `habilita_mdfe`, `habilita_nfcom`, `habilita_dce`

Numbering:
- `proximo_numero_nfe_producao/_homologacao`, `serie_nfe_producao/_homologacao` (default série 1)
- Same pattern for nfse (RPS), nfsen (DPS), nfce, cte, mdfe, ...

Behaviour:
- `nfe_sincrono`, `nfe_sincrono_homologacao` (sync NF-e)
- `enviar_email_destinatario`, `enviar_email_homologacao`
- `discrimina_impostos` (Lei da Transparência totals)
- `mostrar_danfse_badge` (false = white label)
- `orientacao_danfe` and the DANFe display flags
- `arquivo_logo_base64` (PNG ≤200×200)

NFS-e without certificate:
- `login_responsavel`, `senha_responsavel` (prefeitura credentials for some cities)
- `nome_responsavel`, `cpf_responsavel`

MD-e:
- `data_inicio_recebimento_nfe`, `_cte`, `_nfsen` (immutable once set)
- `habilita_filtro_mde_destinatario_empresa`

Also available:
- `cpf_cnpj_contabilidade` (required by some UFs, e.g. BA)
- NFC-e CSC (`csc_nfce_producao`, `id_token_nfce_producao`, ...)
- Custom SMTP (`smtp_*`)

Create example:
```json
POST /v2/empresas
{
  "nome": "Nome da empresa Ltda", "nome_fantasia": "Nome Fantasia", "cnpj": "12345678000123",
  "inscricao_estadual": 1234, "inscricao_municipal": 46532, "regime_tributario": 1,
  "logradouro": "Rua João da Silva", "numero": "153", "complemento": "Loja 1", "bairro": "Vila Isabel",
  "municipio": "Curitiba", "uf": "PR", "cep": 80210000, "telefone": "4130333333", "email": "test@example.com",
  "habilita_nfe": true, "habilita_nfsen_producao": true, "habilita_nfsen_homologacao": true, "habilita_manifestacao": true,
  "discrimina_impostos": true, "enviar_email_destinatario": true,
  "arquivo_certificado_base64": "MIIj4gIBAzCC...", "senha_certificado": "123456"
}
```
Response 200 is the full company object, including `id`, `codigo_municipio`, `codigo_uf`, the `habilita_*` flags, `certificado_*`, `token_producao`, `token_homologacao`, ...

Multi-tenant model for WeldSuite:
1. Create the company with the master token.
2. Fetch `GET /v2/empresas/{id}` to get the per-company tokens.
3. Store them encrypted (WeldPass/secret store).
4. Use the per-company token for all document calls.

---

## 8. Things I could not confirm / conflicts in the docs

1. **`items` vs `itens`** in the NF-e request. Requests documented as `items` (OpenAPI + legacy examples); responses and the field catalogue use `itens`. It is unknown whether `itens` is accepted on input.
2. **NFS-e municipal `servico.aliquota` unit** (percent `3` vs fraction `0.05`) appears to depend on the municipality. Also `codigo_tributario_municipio` (schema) vs `codigo_tributacao_municipio` (one new example).
3. **Webhook payload for `nfe_recebida` / `nfsen_recebida`** is not documented in the new reference. Presumably the summary object. **Whether cancellations trigger the `nfe` / `nfse` hooks** is also not stated.
4. **Webhook security** is a static header only (`authorization` / `authorization_header`). No HMAC signature or source IP list is documented.
5. **Hook limits**: "max 5 per company per event" vs a legacy 400 "Já existe um gatilho para este evento".
6. **Download auth** for `/arquivos/...` paths is not stated. Recebidas `.pdf` redirects to a pre-signed URL, and auth must not be forwarded.
7. **NFS-e Nacional cancel**: the justificativa is "required if cancellation code = 4", but no code field is documented. Always send one.
8. **NFS-e Nacional chave**: no dedicated field in the documented GET response. It is embedded in `url` and in the XML file name.
9. **IBS/CBS enforcement** in Focus for NF-e (dates, Simples Nacional exemption) is not stated in the API reference. The fields exist and are flagged REQ within the RT group. The Focus RT guide lives at https://focusnfe.com.br/guides/reforma-tributaria/ (not read).
10. The `forma_pagamento` enum beyond code 19 was truncated in my extraction. The documented codes include `90` (sem pagamento) and `99` (outros); check https://campos.focusnfe.com.br/nfe/NotaFiscalXML.html for 20-22.
11. The HTTP code for a sync-authorized NF-e is `201`, and for async `202`. The legacy docs said `201` for "accepted". Treat any 2xx as accepted and rely on `status`.
