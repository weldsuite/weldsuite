# WeldBooks BR: Brazilian tax reference data (research as of 2026-10-15)

Confidence legend used throughout:

- **[V]** verified against an official source, or against 2+ independent sources that agree
- **[S]** single secondary source, or my reading of a secondary source; plausible but re-check before shipping
- **[U]** unverified or conflicting; do not hard-code without checking the primary text

Access note: planalto.gov.br and sped.rfb.gov.br refused connections from the research
environment (socket hang-up), so LC 123 / LC 116 / RIR text was cross-checked through mirrors
(legis.senado.leg.br, buscadorncm, legjur/modeloinicial transcriptions) rather than read on Planalto.
Re-confirm the statutory wording on Planalto before treating any article number here as final.

---

## 1. Simples Nacional (LC 123/2006, wording by LC 155/2016, in force 2018 to 2026)

Sources:
- Annex tables (mirror of LC 123 Anexos): https://buscadorncm.com.br/simples-nacional/anexo-i , `/anexo-ii`, `/anexo-iii`, `/anexo-iv`, `/anexo-v`
- Senado consolidated Anexo III (shows the 2027+ CBS/IBS versions inserted by LC 214/2025): https://legis.senado.leg.br/norma/40180341/publicacao/40181117
- ISS-cap footnotes cross-check: https://jornalcontabil.com.br/noticia/simples-nacional-tabelas-2019-2/ , https://saipos.com/fiscal/simples-nacional/anexo-iv-simples-nacional

All five annex tables below matched across the mirror and a second source **[V]**.

### 1.1 Effective-rate formula (art. 18 §1-A) [V]

```
aliquota_efetiva = (RBT12 * aliquota_nominal - parcela_deduzir) / RBT12
tributo_x        = receita_mes * aliquota_efetiva * percentual_reparticao_x
```

RBT12 = gross revenue of the 12 months before the assessment month. For a company in its first
months of activity, RBT12 is annualised (art. 18 §2: average monthly revenue × 12). **[V, rule well known; §2 wording not re-read on Planalto]**

### 1.2 Anexo I: Comércio

| Faixa | RBT12 (R$) | Alíquota nominal | Parcela a deduzir (R$) |
|---|---|---|---|
| 1 | até 180.000,00 | 4,00% | 0 |
| 2 | 180.000,01 a 360.000,00 | 7,30% | 5.940,00 |
| 3 | 360.000,01 a 720.000,00 | 9,50% | 13.860,00 |
| 4 | 720.000,01 a 1.800.000,00 | 10,70% | 22.500,00 |
| 5 | 1.800.000,01 a 3.600.000,00 | 14,30% | 87.300,00 |
| 6 | 3.600.000,01 a 4.800.000,00 | 19,00% | 378.000,00 |

| Faixa | IRPJ | CSLL | COFINS | PIS/Pasep | CPP | ICMS |
|---|---|---|---|---|---|---|
| 1 | 5,50% | 3,50% | 12,74% | 2,76% | 41,50% | 34,00% |
| 2 | 5,50% | 3,50% | 12,74% | 2,76% | 41,50% | 34,00% |
| 3 | 5,50% | 3,50% | 12,74% | 2,76% | 42,00% | 33,50% |
| 4 | 5,50% | 3,50% | 12,74% | 2,76% | 42,00% | 33,50% |
| 5 | 5,50% | 3,50% | 12,74% | 2,76% | 42,00% | 33,50% |
| 6 | 13,50% | 10,00% | 28,27% | 6,13% | 42,10% | – |

### 1.3 Anexo II: Indústria

| Faixa | RBT12 (R$) | Alíquota nominal | Parcela a deduzir (R$) |
|---|---|---|---|
| 1 | até 180.000,00 | 4,50% | 0 |
| 2 | 180.000,01 a 360.000,00 | 7,80% | 5.940,00 |
| 3 | 360.000,01 a 720.000,00 | 10,00% | 13.860,00 |
| 4 | 720.000,01 a 1.800.000,00 | 11,20% | 22.500,00 |
| 5 | 1.800.000,01 a 3.600.000,00 | 14,70% | 85.500,00 |
| 6 | 3.600.000,01 a 4.800.000,00 | 30,00% | 720.000,00 |

| Faixa | IRPJ | CSLL | COFINS | PIS/Pasep | CPP | IPI | ICMS |
|---|---|---|---|---|---|---|---|
| 1 | 5,50% | 3,50% | 11,51% | 2,49% | 37,50% | 7,50% | 32,00% |
| 2 | 5,50% | 3,50% | 11,51% | 2,49% | 37,50% | 7,50% | 32,00% |
| 3 | 5,50% | 3,50% | 11,51% | 2,49% | 37,50% | 7,50% | 32,00% |
| 4 | 5,50% | 3,50% | 11,51% | 2,49% | 37,50% | 7,50% | 32,00% |
| 5 | 5,50% | 3,50% | 11,51% | 2,49% | 37,50% | 7,50% | 32,00% |
| 6 | 8,50% | 7,50% | 20,96% | 4,54% | 23,50% | 35,00% | – |

### 1.4 Anexo III: services (incl. Fator R ≥ 28% for Anexo V activities)

| Faixa | RBT12 (R$) | Alíquota nominal | Parcela a deduzir (R$) |
|---|---|---|---|
| 1 | até 180.000,00 | 6,00% | 0 |
| 2 | 180.000,01 a 360.000,00 | 11,20% | 9.360,00 |
| 3 | 360.000,01 a 720.000,00 | 13,50% | 17.640,00 |
| 4 | 720.000,01 a 1.800.000,00 | 16,00% | 35.640,00 |
| 5 | 1.800.000,01 a 3.600.000,00 | 21,00% | 125.640,00 |
| 6 | 3.600.000,01 a 4.800.000,00 | 33,00% | 648.000,00 |

| Faixa | IRPJ | CSLL | COFINS | PIS/Pasep | CPP | ISS |
|---|---|---|---|---|---|---|
| 1 | 4,00% | 3,50% | 12,82% | 2,78% | 43,40% | 33,50% |
| 2 | 4,00% | 3,50% | 14,05% | 3,05% | 43,40% | 32,00% |
| 3 | 4,00% | 3,50% | 13,64% | 2,96% | 43,40% | 32,50% |
| 4 | 4,00% | 3,50% | 13,64% | 2,96% | 43,40% | 32,50% |
| 5 | 4,00% | 3,50% | 12,82% | 2,78% | 43,40% | 33,50% (*) |
| 6 | 35,00% | 15,00% | 16,03% | 3,47% | 30,50% | – |

**(*) ISS cap, Anexo III faixa 5 [V]:** the effective ISS share is capped at 5%. The excess moves
proportionally to the federal taxes of the same faixa. In practice, when the effective rate is
above **14,92537%** (= 5% / 33,5%):

| Tributo | Share |
|---|---|
| ISS | fixed **5,00%** (absolute percentage of revenue) |
| IRPJ | (aliq_efetiva − 5%) × 6,02% |
| CSLL | (aliq_efetiva − 5%) × 5,26% |
| COFINS | (aliq_efetiva − 5%) × 19,28% |
| PIS/Pasep | (aliq_efetiva − 5%) × 4,18% |
| CPP | (aliq_efetiva − 5%) × 65,26% |

(6,02 + 5,26 + 19,28 + 4,18 + 65,26 = 100.)

### 1.5 Anexo IV: construction, cleaning, security, law firms (art. 18 §5-C). CPP is not in the DAS.

| Faixa | RBT12 (R$) | Alíquota nominal | Parcela a deduzir (R$) |
|---|---|---|---|
| 1 | até 180.000,00 | 4,50% | 0 |
| 2 | 180.000,01 a 360.000,00 | 9,00% | 8.100,00 |
| 3 | 360.000,01 a 720.000,00 | 10,20% | 12.420,00 |
| 4 | 720.000,01 a 1.800.000,00 | 14,00% | 39.780,00 |
| 5 | 1.800.000,01 a 3.600.000,00 | 22,00% | 183.780,00 |
| 6 | 3.600.000,01 a 4.800.000,00 | 33,00% | 828.000,00 |

| Faixa | IRPJ | CSLL | COFINS | PIS/Pasep | ISS |
|---|---|---|---|---|---|
| 1 | 18,80% | 15,20% | 17,67% | 3,83% | 44,50% |
| 2 | 19,80% | 15,20% | 20,55% | 4,45% | 40,00% |
| 3 | 20,80% | 15,20% | 19,73% | 4,27% | 40,00% |
| 4 | 17,80% | 19,20% | 18,90% | 4,10% | 40,00% |
| 5 | 18,80% | 19,20% | 18,08% | 3,92% | 40,00% (*) |
| 6 | 53,50% | 21,50% | 20,55% | 4,45% | – |

**(*) ISS cap, Anexo IV faixa 5 [V]:** when the effective rate is above **12,5%** (= 5% / 40%):
ISS fixed 5%; IRPJ = (ef − 5%) × 31,33%; CSLL = (ef − 5%) × 32,00%; COFINS = (ef − 5%) × 30,13%;
PIS = (ef − 5%) × 6,54%. (Sum = 100.)

CPP for Anexo IV companies is paid outside the DAS, at the normal 20% employer rate on payroll (art. 18 §5-C and art. 13 VI) **[V, well established]**.

### 1.6 Anexo V: intellectual / technical services with Fator R < 28%

| Faixa | RBT12 (R$) | Alíquota nominal | Parcela a deduzir (R$) |
|---|---|---|---|
| 1 | até 180.000,00 | 15,50% | 0 |
| 2 | 180.000,01 a 360.000,00 | 18,00% | 4.500,00 |
| 3 | 360.000,01 a 720.000,00 | 19,50% | 9.900,00 |
| 4 | 720.000,01 a 1.800.000,00 | 20,50% | 17.100,00 |
| 5 | 1.800.000,01 a 3.600.000,00 | 23,00% | 62.100,00 |
| 6 | 3.600.000,01 a 4.800.000,00 | 30,50% | 540.000,00 |

| Faixa | IRPJ | CSLL | COFINS | PIS/Pasep | CPP | ISS |
|---|---|---|---|---|---|---|
| 1 | 25,00% | 15,00% | 14,10% | 3,05% | 28,85% | 14,00% |
| 2 | 23,00% | 15,00% | 14,10% | 3,05% | 27,85% | 17,00% |
| 3 | 24,00% | 15,00% | 14,92% | 3,23% | 23,85% | 19,00% |
| 4 | 21,00% | 15,00% | 15,74% | 3,41% | 23,85% | 21,00% |
| 5 | 23,00% | 12,50% | 14,10% | 3,05% | 23,85% | 23,50% |
| 6 | 35,00% | 15,50% | 16,44% | 3,56% | 29,50% | – |

No ISS-cap footnote exists for Anexo V. Its maximum faixa-5 effective rate (21,275%) × 23,5% stays at 5,0%. **[V]**

### 1.7 Fator R (art. 18 §§5-J, 5-M, 24)

- `r = folha_salarios_12m / RBT12`, threshold **28%** **[V]**
- "Folha de salários" (art. 18 §24) = salaries, pró-labore, amounts paid to individuals for services, 13º, FGTS, and employer social-security contribution (CPP/INSS patronal) of the previous 12 months **[V via 2 secondary sources]**
- **§5-J (Anexo V → Anexo III):** the services in §5-I are taxed in **Anexo III when r ≥ 28%**, otherwise Anexo V. The §5-I list **[S, from memory of LC 155 text; re-check on Planalto]**:
  I medicina (incl. laboratorial) e enfermagem; II medicina veterinária; III odontologia e prótese dentária; IV psicologia, psicanálise, terapia ocupacional, acupuntura, podologia, fonoaudiologia, clínicas de nutrição, de vacinação e bancos de leite; V serviços de comissaria, despachantes, tradução e interpretação; VI arquitetura, engenharia, medição, cartografia, topografia, geologia, geodésia, testes, suporte e análises técnicas e tecnológicas, pesquisa, design, desenho e agronomia; VII representação comercial e demais atividades de intermediação de negócios e serviços de terceiros; VIII perícia, leilão e avaliação; IX auditoria, economia, consultoria, gestão, organização, controle e administração; X jornalismo e publicidade; XI agenciamento, exceto de mão de obra; XII other intellectual / technical / scientific / sporting / artistic / cultural services (regulated profession or not) not taxed in Anexos III or IV.
- **§5-M (Anexo III → Anexo V):** when r < 28%, the Anexo III activities in **§5-B incisos XVI, XVIII, XIX, XX and XXI** are taxed in Anexo V. Inciso XVI = fisioterapia **[V, transcribed by rotinafiscal.com.br]**. XVIII–XXI are, per my reading of the LC 147/2014 text, arquitetura e urbanismo; medicina/enfermagem; odontologia/prótese; psicologia etc. **[U]**. XVII (corretagem de seguros) is **not** in the list, so it stays in Anexo III regardless of r **[S]**. §5-M may have a further inciso. **[U: confirm on Planalto]**
- The practical implementation guide is Res. CGSN 140/2018 art. 25 (activity → annex mapping) and art. 26 (fator r) **[S]**.

### 1.8 Limits and sublimit

| Item | Value | Basis | Confidence |
|---|---|---|---|
| EPP ceiling | R$ 4.800.000,00 / year | LC 123 art. 3 II | [V] |
| ME ceiling | R$ 360.000,00 / year | art. 3 I | [V] |
| ICMS/ISS sublimit | R$ 3.600.000,00 | art. 13-A | [V] |
| Above sublimit | ICMS and ISS paid outside the DAS under normal state/municipal rules; federal taxes stay in the DAS using faixa 6 percentages | art. 13-A | [V] |
| Excess tolerance | Exceeding the limit/sublimit by ≤ 20% means exclusion (or ICMS/ISS leaving the DAS) only from 1 January of the next year; > 20% means from the following month | art. 3 §§9-A, 10; art. 20 §1 | [S] |

### 1.9 MEI (2026)

| Item | Value | Confidence |
|---|---|---|
| Annual revenue limit | **R$ 81.000,00** (R$ 6.750/month proportional in the opening year). No increase enacted as of Oct 2026 | [V] |
| MEI Caminhoneiro limit | R$ 251.600,00 (LC 188/2021) | [S] |
| 2026 minimum wage | **R$ 1.621,00** (Decreto 12.797/2025, DOU 24/12/2025; daily R$ 54,04, hourly R$ 7,37) | [V] |
| INSS (5% of SM) | R$ 81,05 | [V] |
| DAS-MEI comércio/indústria (INSS + R$1 ICMS) | **R$ 82,05** | [V] |
| DAS-MEI serviços (INSS + R$5 ISS) | **R$ 86,05** | [V] |
| DAS-MEI comércio + serviços | **R$ 87,05** | [V] |
| MEI Caminhoneiro (INSS 12% = R$ 194,52) | R$ 195,52 / 199,52 / 200,52 | [S] |
| Due date | day 20 of the following month | [V] |

Sources: https://www.infinitepay.io/blog/valor-das-mei-2026 , https://jornalcontabil.com.br/noticia/veja-quais-serao-os-valores-de-contribuicao-do-mei-em-2026/ , https://www.fiergs.org.br/sites/default/files/paragraph--files/informe_contrab_-_01.2026.pdf (decree number), https://www.congressoemfoco.com.br/noticia/115146/governo-oficializa-reajuste-do-salario-minimo-para-r-1-621-em-2026

Caution: some outlets published R$ 82,35 to R$ 87,35 (based on the R$ 1.627 PLDO projection). Those figures are wrong; the decree fixed R$ 1.621.

### 1.10 Mandatory invoice text for ME/EPP optantes

Source: https://www.rotinafiscal.com.br/operacoes-fiscais/nota-fiscal-simples-nacional (citing Res. CGSN 140/2018), https://portal.fazenda.rj.gov.br/icms/simples-nacional/credito-de-icms/

- In "Informações Complementares" (or the invoice body):
  - `DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL` **[V]**
  - `NÃO GERA DIREITO A CRÉDITO FISCAL DE IPI` **[V]**
- **ICMS credit for the buyer (LC 123 art. 23; Res. CGSN 140/2018 arts. 60–62)** **[V]**. This applies when goods are sold to a non-Simples buyer for commercialisation or industrialisation:
  `PERMITE O APROVEITAMENTO DO CRÉDITO DE ICMS NO VALOR DE R$ ...; CORRESPONDENTE À ALÍQUOTA DE ...%, NOS TERMOS DO ART. 23 DA LEI COMPLEMENTAR Nº 123, DE 2006`
- Credit % = the ICMS share of the effective rate for the faixa, based on the RBT12 of the **month before** the operation: `aliq_efetiva × %ICMS (Anexo I or II)` **[V]**
- No credit when the buyer is also a Simples optante, or the ICMS is fixed-value, etc. **[S]**
- Article numbers: the identification expressions are in Res. CGSN 140 art. 59 (paragraph not confirmed), and the credit expression in art. 60 **[S]**. Res. CGSN 191/2026 (DOU 10/08/2026) amended art. 59 on national-standard NFS-e issuance. Re-read the consolidated art. 59 before final wording **[U]**.
- NF-e tags for Simples: `CRT=1` (Simples Nacional), `CRT=4` (MEI, since NT 2024.001) **[S, from memory]**. Credit fields: `pCredSN` / `vCredICMSSN` in `ICMSSN101/201/900` **[V, standard NF-e layout]**.

### 1.11 Simples from 2027 (tax reform)

LC 214/2025 inserted 2027+ versions of the annexes: PIS/COFINS replaced by **CBS** in the DAS, and IBS appears gradually. Senado Anexo III example: 2027–2028 faixa 1 is IRPJ 4,00 / CSLL 3,50 / CBS 15,43 / CPP 43,40 / ISS 33,50 / IBS 0,17, and faixa 6's nominal rate drops to **32,90%** in 2027–2028, returning to 33,00% from 2029. See the source for all years and annexes **[V for Anexo III, other annexes not extracted]**.

From 2027 a Simples optante may elect to pay IBS/CBS in the **regular regime** (outside the DAS) so its customers get full credits (see §5.6).

---

## 2. ICMS

### 2.1 Modal (general) internal rate per UF, 2026

Sources: https://simtax.com.br/tabela-icms-2026-aliquotas-de-todos-estados-atualizada/ , https://inventti.com.br/sefaz-alagoas-aumenta-aliquota-geral-do-icms-para-205-a-partir-de-01-04-2026/ , plus the 2026 tables at contmatic, tributodevido and mobills (they agree except where flagged).
**No single official consolidated table exists. Each rate lives in the state's ICMS law/RICMS.**

| UF | IBGE code | Modal rate | General FCP add-on | Notes / confidence |
|---|---|---|---|---|
| RO | 11 | 19,5% | – | [V] (one older table shows 17,5%) |
| AC | 12 | 19% | – | [V] |
| AM | 13 | 20% | – | [V] (ZFM special rules) |
| RR | 14 | 20% | – | [V] |
| PA | 15 | 19% | – | [V] |
| AP | 16 | 18% | – | [V] |
| TO | 17 | 20% | – | [V] |
| MA | 21 | 23% | – | [V] (since Feb 2025; some outdated tables show 22% or 20%) |
| PI | 22 | 22,5% | – | [V] (some tables show 21%, the pre-2025 rate) |
| CE | 23 | 20% | – | [V] |
| RN | 24 | 20% | – | [V] (since 2025) |
| PB | 25 | 20% | – | [V] |
| PE | 26 | 20,5% | – | [V] |
| AL | 27 | **20,5% from 01/04/2026** (19% until 31/03/2026) | +1% FECOEP? | Rate [V]. Whether the 1% FECOEP is **on top** (21,5% effective, as simtax says) is **[U]** |
| SE | 28 | 19% | +1% FECOEP (20% effective) | [S] tables split between "19%" and "20% incl. FECOEP" |
| BA | 29 | 20,5% | – | [V] |
| MG | 31 | 18% | – (2% FEM on listed goods only) | [V] (RICMS/MG Anexo I item 7.1) |
| ES | 32 | 17% | – | [V] |
| RJ | 33 | 20% | **+2% FECP** (22% effective) | [V] Lei 2.657/96 art. 14 I + LC RJ 210/2023 |
| SP | 35 | 18% | – | [V] RICMS/SP art. 52 I |
| PR | 41 | 19,5% | – | [V] (some tables show 19%) |
| SC | 42 | 17% | – | [V] |
| RS | 43 | 17% | – | [V] |
| MS | 50 | 17% | – | [V] (one table shows 19%, isolated) |
| MT | 51 | 17% | – | [V] |
| GO | 52 | 19% | – | [V] |
| DF | 53 | 20% | – | [V] (one table shows 18%, outdated) |

FCP/FECP note: most states charge an FCP of 1–2% only on **specific goods** (beverages, tobacco, cosmetics, fuels, energy, telecom...). Model FCP as a per-UF, per-NCM table (NF-e fields `pFCP`/`vFCP`, `pFCPST`, `pFCPUFDest`). Only RJ (2%) and AL/SE (1%) apply a broad general add-on per the sources above. **[S]**

### 2.2 Interstate rates [V]

| Rule | Rate | Basis |
|---|---|---|
| General interstate rate | **12%** | Res. Senado 22/1989 |
| Origin S/SE **except ES** (SP, RJ, MG, PR, SC, RS) → destination N, NE, CO **or ES** | **7%** | Res. Senado 22/1989 |
| Imported goods (or with import content > 40%) not further industrialised, or after industrialisation in Brazil | **4%** | Res. Senado 13/2012 (exceptions: goods without national similar on the CAMEX list, natural gas, goods made under PPB) |

All other combinations (e.g. N/NE/CO/ES → anywhere, or S/SE → S/SE) use 12%. To a non-contributor end
consumer in another UF, the destination DIFAL applies (EC 87/2015, LC 190/2022).

### 2.3 IBGE UF codes [V]

11 RO, 12 AC, 13 AM, 14 RR, 15 PA, 16 AP, 17 TO, 21 MA, 22 PI, 23 CE, 24 RN, 25 PB, 26 PE, 27 AL, 28 SE, 29 BA, 31 MG, 32 ES, 33 RJ, 35 SP, 41 PR, 42 SC, 43 RS, 50 MS, 51 MT, 52 GO, 53 DF.
(There is no 30, 34, 36–40, 44–49. Same codes as NF-e `cUF`.) Source: IBGE DTB, https://www.ibge.gov.br/explica/codigos-dos-municipios.php

---

## 3. Federal regimes (Lucro Presumido / Lucro Real)

Sources: Lei 9.249/1995 arts. 15 and 20; Lei 9.430/1996 arts. 3–4; Lei 9.718/1998 art. 13 (as amended by Lei 12.814/2013); LC 224/2025.
LC 224 summaries: https://www.calculadoracontabil.com.br/blog/lucro-presumido-lc-224-2026-maioracao-presuncao , https://www.dpc.com.br/lei-complementar-no-224-2025-ajustes-no-lucro-presumido/ , https://www.omie.com.br/blog/trf3-suspende-adicional-lucro-presumido-lc-224-2025/

### 3.1 Presumption percentages (base rates, before LC 224) [V, long-standing]

| Activity | IRPJ | CSLL |
|---|---|---|
| Fuel resale (combustíveis derivados de petróleo, álcool, gás natural) | 1,6% | 12% |
| Sale of goods (comércio), industry, cargo transport, construction with full material supply, real-estate sale activity, hospital services (when an *sociedade empresária* meeting Anvisa rules) | 8% | 12% |
| Passenger transport (other than cargo) | 16% | 12% |
| Services by companies with annual revenue ≤ R$ 120.000 (except regulated professions, hospital, transport) | 16% | 32% |
| Services in general, incl. regulated professions, intermediação de negócios, administration/rental/cession of assets, construction labour-only, factoring | 32% | 32% |
| Financial institutions (where allowed) | 16% | 12% |

### 3.2 LC 224/2025: +10% presumption on revenue above R$ 5 million [V]

- **Published 26/12/2025.** Regulated by Decreto 12.808/2025 and IN RFB 2.305/2025 and **IN RFB 2.306/2026** (art. 15).
- The presumption percentages are **multiplied by 1,10** (not +10 pp): 8% becomes 8,8%, 32% becomes 35,2%, 12% becomes 13,2%, 1,6% becomes 1,76%, 16% becomes 17,6%.
- They apply **only to the portion of annual gross revenue above R$ 5.000.000**, controlled quarterly at **R$ 1.250.000 per quarter**, cumulative within the year. IN 2.306/2026 lets unused quarterly room carry forward and lets overpayments be offset within the year.
- **Effective dates:** IRPJ from **01/01/2026**; CSLL from **01/04/2026** (90-day rule), so the 2026 CSLL threshold covers three quarters (R$ 3.750.000).
- Multi-activity companies allocate the excess proportionally to each activity's revenue share.
- **Litigation:** individual injunctions suspended it for the plaintiffs (1ª Vara Federal Resende MS 5000259-79.2026.4.02.5116, Jan 2026; TRF-3), and ADIs are pending at the STF with no merit ruling found. **The rule is in force for everyone else.** Build it as a configurable flag. **[V for existence, status may change]**
- Some sources wrongly describe it as "+10 percentage points". Ignore those.

### 3.3 Rates [V]

| Tax | Rate | Notes |
|---|---|---|
| IRPJ | 15% | on presumed/real profit |
| IRPJ adicional | 10% | on profit above **R$ 20.000 × months** (R$ 60.000/quarter; R$ 240.000/year) |
| CSLL | 9% | general (banks 15–20%, not relevant here) |
| PIS cumulative (Lucro Presumido) | 0,65% | Lei 9.715/1998 / 9.718/1998 |
| COFINS cumulative (Lucro Presumido) | 3,00% | Lei 9.718/1998 |
| PIS non-cumulative (Lucro Real) | 1,65% | Lei 10.637/2002, with credits |
| COFINS non-cumulative (Lucro Real) | 7,60% | Lei 10.833/2003, with credits |
| Lucro Presumido revenue ceiling | **R$ 78.000.000** in the prior year (or R$ 6,5 million × months in activity) | Lei 9.718 art. 13 (Lei 12.814/2013). LC 224 did not change it per the sources found |

2026 test year: PIS/COFINS stay fully due. The 1% CBS/IBS is offsettable against them or waived (see §5).

---

## 4. Withholdings on services paid by a PJ (retenções na fonte)

### 4.1 IRRF [V for rates; article list from RIR/2018]

| Service | Rate | Basis |
|---|---|---|
| Professional services (list below) | **1,5%** | RIR/2018 (Dec. 9.580/2018) art. 714 |
| Cleaning, conservation, security, surveillance, labour hire (*locação de mão de obra*) | **1,0%** | art. 716 |
| Commissions, brokerage, representation | 1,5% | art. 718 |
| Advertising services (propaganda), on the agency's remuneration | 1,5% | art. 719 |
| Dispensation | IRRF ≤ **R$ 10,00** is not withheld/paid | Lei 9.430/1996 art. 67 |

Professional services in art. 714 §1 (classic list, from memory of the RIR text **[S]**): administration of goods or business; advocacia; clinical laboratory analysis; technical analysis; arquitetura; technical consulting and advisory; social assistance; auditoria; appraisal and expert reports (avaliação e perícia); biology and biomedicine; cálculo em geral; consultoria; contabilidade; technical drawing; economia; preparation of projects; engenharia (except construction of roads, bridges, buildings); ensino e treinamento; estatística; fisioterapia; fonoaudiologia; geologia; leilão; medicina (except hospitals, clinics with inpatient care, etc.); nutrition; odontologia; organisation of fairs, congresses and seminars; pesquisa; planejamento; programação; prótese; psicologia; química; radiologia; relações públicas; despachante; terapêutica ocupacional; tradução; urbanismo; veterinária.

**Simples Nacional providers are exempt from IRRF on services** (IN RFB 765/2007; LC 123 art. 13 §1 treatment). The payee states its optante status on the invoice **[S]**.

**2026 change? No.** Lei 15.270/2025 (IR reform) created the IRPF exemption up to R$ 5.000/month (with a reduction band to R$ 7.350), the minimum IRPF on high incomes, and **10% IRRF on dividends above R$ 50.000/month** per payer to individuals, from Jan 2026. It did **not** change PJ-to-PJ service withholding (1,5% / 1%). Source: fenacon.org.br Receita guidance on dividends; consultant Q&A at portalspedbrasil **[S, no official RFB note found that says "no change"]**.

### 4.2 CSRF: PIS + COFINS + CSLL = 4,65% [V]

- **Basis:** Lei 10.833/2003 arts. 30–36; IN SRF 459/2004
- **Rates:** CSLL 1% + COFINS 3% + PIS 0,65% = **4,65%** (single DARF code 5952, or split codes)
- **Services in scope (art. 30):** limpeza, conservação, manutenção, segurança, vigilância, transporte de valores and locação de mão de obra; assessoria creditícia, mercadológica, gestão de crédito, seleção e riscos; administração de contas a pagar e a receber; and professional services (*serviços profissionais*); plus card-administration fees and some others in art. 30 §§ (e.g. payments for services by card-acquirer entities) **[S for the extras]**
- **Threshold:** since Lei 13.137/2015 (changing art. 31 §3), retention is **dispensed when the amount to withhold is ≤ R$ 10,00** (except DARF via Siafi). The old R$ 5.000 payment threshold no longer exists.
- **Exemption:** not applied to payments to **Simples Nacional optantes** (art. 32 / IN 459 art. 3) **[V]**
- 2027: PIS/COFINS are extinguished, so the CSRF in its current form ends with them. The CBS has no equivalent PJ-to-PJ withholding (split payment is a different mechanism). Plan for CSLL-only (1%) withholding from 2027 **[U, no explicit rule found; re-check before 2027]**.

### 4.3 INSS retention 11% (cessão de mão de obra / empreitada) [V]

- **Basis:** Lei 8.212/1991 art. 31; IN RFB 2.110/2022 (retention chapter)
- **Rate:** **11%** of the invoice's gross value (labour portion; deductions for materials/equipment if contractually separated). **3,5%** for providers under CPRB (payroll desoneração, Lei 12.546 art. 7 §6). CPRB is being phased out 2025–2027 by Lei 14.973/2024, so check the provider's status **[S]**.
- **Scope:** services performed by *cessão de mão de obra* or *empreitada* (list in IN 2.110: cleaning, security, construction, maintenance, etc.)
- **Simples Nacional:** Simples providers are generally **not** subject to the 11% retention, **except** those taxed under **Anexo IV** (construction, cleaning, surveillance... whose CPP is outside the DAS), who **are** subject to it (LC 123 art. 18 §5-C and IN 2.110) **[V]**
- Dispensation: retention below R$ 10 is not collected (IN 2.110) **[S]**

### 4.4 ISS retido (LC 116/2003) [V]

- **Art. 6 caput:** municipalities may by law make the *tomador* responsible
- **Art. 6 §2 II (national rule):** the PJ buyer (even if immune/exempt) is responsible for ISS on list subitems **3.05, 7.02, 7.04, 7.05, 7.09, 7.10, 7.12, 7.16, 7.17, 7.19, 11.02, 17.05, 17.10** (7.14 and 7.15 were removed). §2 I: services imported from abroad.
- **Art. 3** defines **where** ISS is due. As a rule it is the provider's establishment, but the incisos list exceptions due at the place of performance, e.g. 3.05 (scaffolding, tents), 7.02/7.04/7.05/7.09/7.10/7.11/7.12/7.16/7.17/7.18/7.19 (construction, demolition, cleaning, landscaping, waste), 11.01–11.04 (parking, security, storage), 12.x (events), 16.01/16.02 (transport), 17.05 (labour hire), 17.10 (event planning), 20.x (ports/airports), plus LC 157/2016 additions (card plans, leasing, health plans; partly suspended by STF ADI 5835). Retention is therefore usually by the municipality of performance. **[S for the exact inciso list; re-read art. 3]**
- ISS rate range: 2% minimum (art. 8-A), 5% maximum (art. 8 II)
- **Simples provider:** ISS is withheld at the provider's **effective ISS rate** for its faixa, stated on the invoice (LC 123 art. 21 §4). If not stated, **5%**; for a company in its first month of activity, 2% **[S]**.
- Municipal laws frequently widen retention (e.g. São Paulo CPOM for out-of-town providers). Model per municipality.

---

## 5. Tax reform: CBS/IBS (LC 214/2025), status as of 15/10/2026

Sources:
- LC 214 art. 12 (text via modeloinicial): https://modeloinicial.com.br/lei/LCP-214-2025/lei-complementar-214/art-12
- LC 214 art. 348: https://modeloinicial.com.br/lei/LCP-214-2025/lei-complementar-214/art-348
- CGIBS note on Ato Conjunto RFB/CGIBS 1/2025: https://www.cgibs.gov.br/comite-gestor-e-receita-federal-garantem-prazo-de-adaptacao-e-transicao-segura-para-contribuintes-do-ibs-e-da-cbs-em-2026
- Ato Conjunto RFB/CGIBS 4/2026: https://anfarmag.org.br/conteudos/ato-conjunto-rfb-cgibs-no-4-2026/ , https://www.contabeis.com.br/artigos/78468/novas-datas-ibs-e-cbs-nas-notas-fiscais-entenda-o-cronograma/
- Ato Técnico Conjunto 1/2026: https://taxradar.app/blog/reforma-tributaria/ato-tecnico-conjunto-1-adiamento-validacoes-ibs-cbs , https://ibslab.com.br/perguntas/campos-ibs-cbs-documentos-fiscais
- RFB Simples 2027 news (29/09/2026): https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/setembro/simples-nacional-2027-entenda-os-novos-prazos-e-faca-sua-escolha-com-consciencia-e-tranquilidade
- CBS 2027 rate process: https://www.contabeis.com.br/noticias/79294/tcu-tem-ate-30-de-outubro-para-calcular-aliquota-da-cbs , https://www.oam.adv.br/2026/09/receita-entrega-calculo-da-cbs-ao-tcu-mas-aliquota-para-2027-segue-indefinida/
- CST/cClassTrib list: https://nfe.io/docs/documentacao/reforma-tributaria/conceitos-funcionais/tabelas-de-referencia/tabela-referencia-cst-classificacao-tributaria-ibs-cbs/
- vBC formula: https://ajuda.sankhya.com.br/hc/pt-br/articles/36172922695703 , https://www.contabeis.com.br/artigos/78804/base-calculo-ibs-cbs-nf-e-guia-nt-2025-002-agosto-2026/

### 5.1 2026 test-year rates [V]

| Tax | 2026 rate | Basis |
|---|---|---|
| CBS (federal) | **0,9%** | LC 214 art. 346 |
| IBS (state portion, IBS-UF) | **0,1%** | LC 214 art. 343 ("alíquota estadual de 0,1%") |
| IBS (municipal portion, IBS-Mun) | **0,0%** (field filled with 0,00, mandatory) | art. 343 sets only a state rate; NT 2025.002 requires `pIBSMun = 0` |

So yes: in 2026 the whole 0,1% IBS is state (IBS-UF), and IBS-Mun is 0%. **[V]**
Art. 348 III: the test rates apply also to reduced-rate operations (with the reductions) and specific regimes (except fuels), and **do not apply to Simples Nacional optantes** in 2026.

### 5.2 Payable or informational? [V]

- **LC 214 art. 348 §1:** payment of 2026 IBS/CBS is **waived (dispensado)** for taxpayers who **comply with the accessory obligations** (i.e. correctly fill the fields on the DF-e).
- Art. 348 I/II: any amount actually paid is offset against PIS/COFINS of the same period; any excess is offset against other federal taxes or refunded within 60 days.
- Art. 348 §2: PIS/COFINS remain fully due in 2026.
- Art. 348 §§3–4: a taxpayer assessed for missing IBS/CBS accessory info gets **60 days** to cure; curing extinguishes the penalty.
- Ato Conjunto RFB/CGIBS **1/2025** (22–23/12/2025): no financial collection in 2026; the calculation is informational if obligations are met; **penalties for the new accessory obligations are waived until the 1st day of the 4th month after publication of the common IBS/CBS regulation** (which depended on PLP 108/2024).
- Practical: **do not add the 1% to the invoice total (vNF)** in 2026; IBS/CBS are shown "por fora" and not charged **[S, per NT guidance summaries]**.

### 5.3 Who must fill the fields, and from when (Ato Conjunto RFB/CGIBS 4/2026, DOU 31/07/2026) [V via 2 sources]

| Document / taxpayer | Mandatory from |
|---|---|
| NF-e (mod. 55) and NFC-e (mod. 65), regular regime (Lucro Real/Presumido) | **03/08/2026** |
| NFS-e (ISS services, general rule) | **01/10/2026** (postponed from 03/08) |
| NFS-e special groups (digital platforms, subitems 1.03, 1.05, 1.09, 16.01, intangibles outside the ISS list, condominium charges, leases/cessions, residual group) | **01/12/2026** **[S, one source]** |
| NF-e for monophasic operations (fuels) | 01/01/2027 |
| **Simples Nacional optantes (and MEI)** | **01/01/2027** (art. 1 §1 of Ato Conjunto 4/2026) |
| CT-e, NFCom, others | own schedules (NT 2026.002 for CT-e/NFCom). Date not confirmed **[U]** |

History: the fields were technically available from Jan 2026 (Comunicado Conjunto 01/2025 / Ato Conjunto 1/2025 said "from 01/01/2026, no penalties"). Ato Conjunto 4/2026 set the enforceable dates above.

**Ato Técnico Conjunto RFB/CGIBS 1/2026 (Aug 2026)** postponed only the **automatic rejection** of documents missing IBS/CBS info, not the obligation. CGIBS clarified on 06/08/2026 that the obligation was not suspended. For NFS-e, missing fields do not cause rejection until 31/12/2026 (Comitê Gestor da NFS-e) **[S]**.

### 5.4 NF-e fields (NT 2025.002, group UB "IBSCBS") [S: verify against the current XSD PL_010x]

Version note: secondary sources cite NT 2025.002 **v1.30 to v1.32** (late 2025) and **v1.51 (Aug 2026)**. Use the latest from https://www.nfe.fazenda.gov.br (the portal page did not load in this research) **[U]**.

Item level, `det/imposto/IBSCBS`:

```
IBSCBS
  CST            3 digits (IBS/CBS CST)
  cClassTrib     6 digits (first 3 = CST)
  gIBSCBS                      (ad valorem group)
    vBC                        base de cálculo
    gIBSUF   { pIBSUF, [gDif {pDif, vDif}], [gDevTrib {vDevTrib}], [gRed {pRedAliq, pAliqEfet}], vIBSUF }
    gIBSMun  { pIBSMun, [gDif], [gDevTrib], [gRed], vIBSMun }
    vIBS                       = vIBSUF + vIBSMun
    gCBS     { pCBS, [gDif], [gDevTrib], [gRed], vCBS }
    [gTribRegular ...]         (regular-taxation shadow values when CST indicates)
    [gIBSCredPres / gCBSCredPres]
    [gTribCompraGov]
  | gIBSCBSMono               (monophasic, fuels; alternative to gIBSCBS)
  | gTransfCred / gCredPresIBSZFM (special CSTs)
```

Totals, `total/IBSCBSTot`:

```
IBSCBSTot
  vBCIBSCBS
  gIBS { gIBSUF {vDif, vDevTrib, vIBSUF}, gIBSMun {vDif, vDevTrib, vIBSMun}, vIBS, vCredPres, vCredPresCondSus }
  gCBS { vDif, vDevTrib, vCBS, vCredPres, vCredPresCondSus }
  [gMono {...}]
total/vNFTot   (total including IBS/CBS/IS; in 2026 IBS/CBS do not compose vNF)
```

Tag names above come from my knowledge of NT 2025.002 cross-checked with the ACBr property paths (`gIBSCBS.vBC`, `gIBSUF.pIBSUF/vIBSUF`, `gIBSMun.pIBSMun/vIBSMun`, `gCBS.pCBS/vCBS`, `IBSCBSTot.vBCIBSCBS`, `gIBS.gIBSUFTot.vIBSUF`, `vNFTot`). The ACBr article prefixes total subgroups with "...Tot", so the exact total subgroup names are **[U]**.

CST IBS/CBS codes (official table, nfe.io copy dated 2026-01-07) **[V]**:

| CST | Description |
|---|---|
| 000 | Tributação integral |
| 010 | Tributação com alíquotas uniformes – operações do FGTS |
| 011 | Tributação com alíquotas uniformes |
| 200 | Alíquota zero ou reduzida |
| 210 | Alíquota reduzida com redutor de base de cálculo |
| 220 | Alíquota fixa |
| 221 | Alíquota fixa proporcional |
| 400 | Isenção |
| 410 | Imunidade e não incidência |
| 510 | Diferimento |
| 550 | Suspensão |
| 620 | Tributação monofásica |
| 800 | Transferência de crédito |
| 810 | Ajustes |
| 820 | Tributação em declaração de regime específico |
| 830 | Exclusão de base de cálculo (later addition, cited as "18 CSTs, 000–830") **[S]** |

The default cClassTrib is **000001**: "Situações tributadas integralmente pelo IBS e CBS" (CST 000). Examples: 200003 (cesta básica, Anexo I LC 214), 200047 (bares e restaurantes, -40%), 410004 (exportações), 620001 (combustíveis monofásicos). The table is versioned (161 cClassTrib codes as of 22/06/2026) and must be loaded from the portal, not hard-coded.

Warning: several blogs publish **fake CST lists** (e.g. "110 Tributação plena", "001/002/070"). Ignore them.

### 5.5 Taxable base (vBC) in 2026 [V for law; S for NF-e formula]

**LC 214 art. 12:** the base is the operation value, including (§1) adjustments, interest/fines/charges, conditional discounts, freight charged by the seller, other taxes and public prices (except those in §2), and insurance and fees.

**Excluded (§2):**
- I: IBS and CBS themselves (calculated "por fora")
- II: **IPI**
- III: **unconditional discounts** (descontos incondicionais)
- IV: reimbursements for operations on behalf of third parties (when documents are in the third party's name)
- V: **from 01/01/2026 to 31/12/2032: ICMS, ISS, COFINS and PIS** (CF arts. 155 II, 156 III, 195 I b and IV, 239) on the operation
- VI: the CF art. 149-A contribution (COSIP, municipal street-lighting)

**NF-e validation formula (NT 2025.002 rule, cited as UB16-10; mismatch triggers rejection) [S]:**

```
vBC = vProd + vServ + vFrete + vSeg + vOutro + vII
      - vDesc - vPIS - vCOFINS - vICMS - vICMSUFDest - vFCP - vFCPUFDest - vICMSMono - vISSQN
      (+ vIS when Imposto Seletivo applies)
```

- PIS-ST/COFINS-ST are not subtracted when they compose vNF (`indSomaPISST=1` / `indSomaCOFINSST=1`)
- IPI is excluded by law but does not appear in the formula above as a separate subtraction because vProd does not include IPI. **Check the current NT on whether `vIPI` / `vIPIDevol` is handled explicitly** **[U]**
- ICMS-ST: not subtracted in the cited formula **[U]**
- Sefaz-SP (Consulta 32.303/2025) held that IBS/CBS are **not** included in the ICMS base in 2026 (state view only) **[S]**

NFS-e (Padrão Nacional, DPS): has an equivalent `IBSCBS` group. The base excludes ISS, PIS and COFINS per art. 12 §2 V **[S]**.

### 5.6 Simples Nacional and the 2027 transition [V]

- In 2026 the test rates do not apply to Simples (art. 348 III c). Simples fields become mandatory from **01/01/2027**.
- From **2027**, CBS (and IBS from 2029, small amounts earlier) are collected **inside the DAS** by default (new annex percentages). Alternatively, the company may opt to pay **IBS/CBS under the regular regime** (outside the DAS, full credit for customers).
- **Res. CGSN 194 (DOU 28/09/2026)**: the window to opt into Simples for 2027 is **01/09–15/10/2026**; the **IBS/CBS regular-regime option (for Jan–Jun 2027) runs 01/09–30/10/2026**; cancellation runs 03/11–20/12/2026. A new window is expected in March 2027 for the second half **[S]**. (Older articles cite Res. CGSN 186/2026 with a 30/09 deadline; the 28/09 RFB news supersedes them.)

### 5.7 2027 onward [V unless noted]

| Item | Rule |
|---|---|
| **PIS/COFINS** | **Extinguished from 01/01/2027** (EC 132 ADCT art. 126; LC 214 revocations) |
| **CBS 2027–2028** | Reference rate **minus 0,1 pp** (LC 214) |
| **CBS reference rate 2027** | **Not yet fixed.** RFB sent its calculation to the TCU on 14/09/2026; TCU computes by **30/10/2026**; the **Senado** fixes it by **15/12/2026** (if late, the TCU figure applies provisionally) **[S on the fallback]**. Estimates: 9,21% (Res. CGSN 14/2026 budget parameter, with IBS for a 27,91% total); ROIT 9,43%. **Not official.** |
| **IBS 2027–2028** | **0,05% state + 0,05% municipal** (LC 214 art. 344) **[S, from memory; not re-read]** |
| IBS 2029–2032 | gradual increase while ICMS/ISS fall (10%/20%/30%/40% of reference), full from 2033 |
| **IPI 2027** | Rates **reduced to zero** for all products **except** those with industrialisation incentivised in the Zona Franca de Manaus (EC 132 ADCT art. 126 III). A decree implementing it is reported (contmatic) |
| Imposto Seletivo | starts 2027 |
| ICMS/ISS | unchanged until 2028; phased out 2029–2032; extinct 2033 |

---

## 6. Identifiers

### 6.1 Alphanumeric CNPJ [V, official RFB FAQ]

Source: https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/perguntas-e-respostas/cnpj/cnpj-alfanumerico.pdf (IN RFB 2.119/2022 as amended by IN RFB 2.229/2024; Nota Técnica COCAD/SUARA/RFB 49/2024)

- **Start:** new registrations from **July 2026**. Secondary reports say systems went live on 27/07/2026 and the first alphanumeric CNPJ was issued on 31/07/2026 **[S]**. Existing CNPJs never change. Numeric and alphanumeric coexist; a new registration may still randomly get an all-numeric number.
- **Format:** 14 positions, `XX.XXX.XXX/XXXX-DV`. Positions 1–12 (root 1–8 + order 9–12) are `[0-9A-Z]` (**uppercase only**); positions 13–14 (DVs) are **always numeric**. The mask is unchanged.
- **DV algorithm (module 11):**
  1. Convert each character: `value = ASCII(char) − 48` (digits 0–9 map to 0–9, `A`=17 ... `Z`=42).
  2. DV1: weights over the 12 characters, assigned **from the right starting at 2 up to 9, then restarting at 2** (left to right: 5 4 3 2 9 8 7 6 5 4 3 2). Sum the products; `r = sum mod 11`; **DV = 0 if r < 2 (r = 0 or 1), else 11 − r**.
  3. DV2: same over the 13 characters (12 + DV1), weights 6 5 4 3 2 9 8 7 6 5 4 3 2.
  - The r<2 → 0 rule is the standard CNPJ rule. The RFB FAQ example does not hit it, so it is not stated there explicitly **[V, standard]**.
- **Official worked example:** `12.ABC.345/01DE-??` gives values 1 2 17 18 19 3 4 5 0 1 20 21. DV1 sum = 459, 459 mod 11 = 8, DV1 = 3. DV2 sum = 424, 424 mod 11 = 6, DV2 = 5. Result: **`12.ABC.345/01DE-35`**. Re-computed independently: 35 ✔. A numeric check, `11.222.333/0001-81`, also validates ✔.
- Test tool: Simulador Nacional de CNPJ, https://servicos.receitafederal.gov.br/servico/cnpj-alfa/simular
- Impact: CNPJ columns must be `varchar(14)`, no numeric casts, and regexes must change from `\d{14}` to `^[0-9A-Z]{12}[0-9]{2}$`. Some letter combinations are blocked by RFB (it says validate all 26 letters).

### 6.2 CPF DV [V, standard algorithm; verified on 111.444.777-35 and 529.982.247-25]

- 11 digits: 9 base + 2 DVs
- DV1: weights 10, 9, ..., 2 on digits 1–9; `r = sum mod 11`; DV1 = 0 if r < 2 else 11 − r
- DV2: weights 11, 10, ..., 2 on digits 1–9 + DV1; same rule
- Reject all-same-digit numbers (000.000.000-00 ... 999.999.999-99) even though they pass the math

### 6.3 Inscrição Estadual

Format, length and check-digit algorithm are **per state** (27 different rules, some with several DVs, e.g. SP has 12 digits with 2 DVs at positions 9 and 12; producers in SP start with "P"). "ISENTO" is a valid value in NF-e for non-contributors. Use a vetted per-UF validator library (the SINTEGRA rules). Not detailed here, per the brief.

---

## 7. SPED ECD (Escrituração Contábil Digital)

Sources:
- Field lists (transcription of the RFB Manual de Orientação do Leiaute 9): https://www.vriconsulting.com.br/utilidades/util_guias.php?idguiaCapitulo=13 (each register at `.../guias/guiasIndex.php?idGuia=N`; ids: 0000=644, 0007=646, I010=663, I030=667, I050=669, I051=670, I052=671, I150=675, I155=676, I200=678, I250=679, I350=682, I355=683, J005=690, J100=691, J150=692, J900=697, J930=698, 9900=714)
- Version: https://documentacao.senior.com.br/exigenciaslegais/noticias/federal/2026/2026-01-13-sped-ecd-ato-declaratorio-cofis-n-01-2026-atualizacao-do-manual-da-ecd-leiaute-9-ja-esta-disponivel-para-2026 , COAD news on PGE 10.4.x
- Official manual download (could not be reached from here): http://sped.rfb.gov.br/pasta/show/1569

### 7.1 Version for the 2026 delivery (ano-calendário 2025) [V]

- **Leiaute 9.** I010 field `COD_VER_LC` = **`9.00`** (code used since AC 2020/2021, confirmed for AC 2024; AC 2025 still leiaute 9).
- Manual updated by **ADE Cofis nº 01/2026** (Jan 2026), mainly for **alphanumeric CNPJ** support. It does not alter AC 2025 files already in preparation.
- PGE (validator program) **10.4.0 / 10.4.1**, valid for AC 2025 and 2026 special situations. Leiaute code ≠ PGE version.
- File format: one register per line, fields delimited by `|`, line starts and ends with `|`; dates `ddmmaaaa`; decimals with comma and no thousand separator; encoding ISO-8859-1 (Latin-1) **[V, standard SPED rule]**.
- Due date: last business day of **June** of the following year (IN RFB 2.003/2021, as amended) **[S]**.

### 7.2 Register field lists (order as per the leiaute 9 manual)

Type legend: C = text, N = numeric. "Obr" = mandatory.

#### 0000 – Abertura do arquivo e identificação da pessoa jurídica [V]

| # | Field | Type/size | Obr | Values |
|---|---|---|---|---|
| 01 | REG | C 4 | S | `0000` |
| 02 | LECD | C 4 | S | `LECD` |
| 03 | DT_INI | N 8 | S | ddmmaaaa |
| 04 | DT_FIN | N 8 | S | |
| 05 | NOME | C | S | razão social |
| 06 | CNPJ | N 14 (becomes alphanumeric with ADE 01/2026) | S | in an SCP file, the ostensive partner's CNPJ |
| 07 | UF | C 2 | S | |
| 08 | IE | C | N | |
| 09 | COD_MUN | N 7 | N | IBGE municipality code |
| 10 | IM | C | N | |
| 11 | IND_SIT_ESP | N 1 | N | 1 cisão, 2 fusão, 3 incorporação, 4 extinção |
| 12 | IND_SIT_INI_PER | N 1 | S | 0 normal, 1 abertura, 2 resultante de cisão/fusão/remanescente de cisão/incorporação, 3 início de obrigatoriedade no ano |
| 13 | IND_NIRE | N 1 | S | 0 no NIRE, 1 has NIRE |
| 14 | IND_FIN_ESC | N 1 | S | 0 original, 1 substituta |
| 15 | COD_HASH_SUB | C 40 | N | hash of the substituted ECD |
| 16 | IND_GRANDE_PORTE | N 1 | S | 1 = subject to independent audit (assets > R$ 240 million or revenue > R$ 300 million), else 0 |
| 17 | TIP_ECD | N 1 | S | 0 not an SCP participant, 1 ostensive partner of SCP, 2 SCP's own ECD |
| 18 | COD_SCP | N 14 | N | CNPJ of the SCP |
| 19 | IDENT_MF | C 1 | S | S/N functional currency |
| 20 | IND_ESC_CONS | C 1 | S | S/N consolidated bookkeeping |
| 21 | IND_CENTRALIZADA | N 1 | S | 0 centralised, 1 decentralised |
| 22 | IND_MUDANC_PC | N 1 | S | 0 no change, 1 chart of accounts changed |
| 23 | COD_PLAN_REF | C 2 | N | 1 PJ geral Lucro Real; 2 PJ geral Lucro Presumido; 3 financeiras LR; 4 seguradoras LR; 5 imunes/isentas geral; 6 imunes/isentas financeiras; 7 imunes/isentas seguradoras; 8 EFPC; 9 partidos políticos; 10 financeiras LP |

#### 0001 – Abertura do Bloco 0 [V]
`|0001|IND_DAD|`, where IND_DAD is 0 = block has data, 1 = no data.

#### 0007 – Outras inscrições cadastrais [V]
| # | Field | Notes |
|---|---|---|
| 01 | REG | `0007` |
| 02 | COD_ENT_REF | 00 none; 01 Bacen; 02 Susep; 03 CVM; 04 ANTT; 05 TSE; or UF code (AC..TO) for the state tax authority |
| 03 | COD_INSCR | registration number at that entity (optional) |

At least one 0007 is required. Use `|0007|00||` when there is none.

#### 0990 – Encerramento do Bloco 0 [V]
`|0990|QTD_LIN_0|`

#### I001 – Abertura do Bloco I [V]
`|I001|IND_DAD|` (0 = has data)

#### I010 – Identificação da escrituração contábil [V]
| # | Field | Values |
|---|---|---|
| 01 | REG | `I010` |
| 02 | IND_ESC | G Diário geral (no auxiliary); R Diário com escrituração resumida; A Diário auxiliar; B Balancetes diários e balanços; Z Razão auxiliar (I500–I555) |
| 03 | COD_VER_LC | `9.00` |

Example: `|I010|G|9.00|`

#### I030 – Termo de abertura do livro [V]
| # | Field | Type/size | Obr | Notes |
|---|---|---|---|---|
| 01 | REG | C 4 | S | `I030` |
| 02 | DNRC_ABERT | C 17 | S | `TERMO DE ABERTURA` |
| 03 | NUM_ORD | N | S | book sequence number (> 0) |
| 04 | NAT_LIVR | C 80 | S | book nature, e.g. `DIARIO GERAL` |
| 05 | QTD_LIN | N | S | total lines of the file (= 9999.QTD_LIN) |
| 06 | NOME | C | S | = 0000.NOME |
| 07 | NIRE | N 11 | N | first 2 digits must match the UF |
| 08 | CNPJ | N 14 | S | = 0000.CNPJ |
| 09 | DT_ARQ | N 8 | N | date of filing of the articles (atos constitutivos) |
| 10 | DT_ARQ_CONV | N 8 | N | date of filing of conversion from sociedade simples |
| 11 | DESC_MUN | C | N | municipality |
| 12 | DT_EX_SOCIAL | N 8 | S | fiscal year-end date |

#### I050 – Plano de contas [V]
| # | Field | Type/size | Obr | Values |
|---|---|---|---|---|
| 01 | REG | C 4 | S | `I050` |
| 02 | DT_ALT | N 8 | S | date of inclusion/alteration |
| 03 | COD_NAT | C 2 | S | 01 ativo; 02 passivo; 03 patrimônio líquido; 04 contas de resultado; 05 contas de compensação; 09 outras |
| 04 | IND_CTA | C 1 | S | S sintética, A analítica |
| 05 | NIVEL | N | S | ≥ 1 |
| 06 | COD_CTA | C | S | |
| 07 | COD_CTA_SUP | C | conditional | required if NIVEL > 1; must be a synthetic I050 |
| 08 | CTA | C | S | account name |

#### I051 – Plano de contas referencial (child of analytical I050) [V]
| # | Field | Notes |
|---|---|---|
| 01 | REG | `I051` |
| 02 | COD_CCUS | cost centre (must exist in I100); optional |
| 03 | COD_CTA_REF | referential account code from the table selected in 0000.COD_PLAN_REF |

(In leiaute ≤ 7 there was a COD_ENT_REF field here. It moved to 0000.COD_PLAN_REF in leiaute 8. Don't emit it.)

#### I052 – Indicação dos códigos de aglutinação (child of analytical I050) [V]
| # | Field | Notes |
|---|---|---|
| 01 | REG | `I052` |
| 02 | COD_CCUS | optional |
| 03 | COD_AGL | aggregation code used in J100/J150 |

#### I150 – Saldos periódicos: identificação do período [V]
`|I150|DT_INI|DT_FIN|`. Monthly periods: DT_INI = 1st of the month (or file start), DT_FIN = last day of the month (or file end).

#### I155 – Detalhe dos saldos periódicos [V]
| # | Field | Type | Obr |
|---|---|---|---|
| 01 | REG | `I155` | S |
| 02 | COD_CTA | C (analytical I050) | S |
| 03 | COD_CCUS | C | N |
| 04 | VL_SLD_INI | N 19,2 | S |
| 05 | IND_DC_INI | C 1 D/C | S (even when zero) |
| 06 | VL_DEB | N 19,2 | S |
| 07 | VL_CRED | N 19,2 | S |
| 08 | VL_SLD_FIN | N 19,2 | S |
| 09 | IND_DC_FIN | C 1 D/C | S (even when zero) |

Additional fields **only if 0000.IDENT_MF = S**, declared through register **I020** (not part of the base layout): 10 VL_SLD_INI_MF, 11 IND_DC_INI_MF, 12 VL_DEB_MF, 13 VL_CRED_MF, 14 VL_SLD_FIN_MF, 15 IND_DC_FIN_MF.

#### I200 – Lançamento contábil [V]
| # | Field | Type | Obr | Values |
|---|---|---|---|---|
| 01 | REG | `I200` | S | |
| 02 | NUM_LCTO | C | S | unique entry id |
| 03 | DT_LCTO | N 8 | S | within file period |
| 04 | VL_LCTO | N 19,2 | S | = sum of debit (= sum of credit) I250 |
| 05 | IND_LCTO | C 1 | S | N normal; E encerramento de contas de resultado; X extemporâneo |
| 06 | DT_LCTO_EXT | N 8 | conditional | required if IND_LCTO = X; empty otherwise |

Additional field if IDENT_MF = S (via I020): 07 VL_LCTO_MF.

#### I250 – Partidas do lançamento [V]
| # | Field | Type | Obr | Notes |
|---|---|---|---|---|
| 01 | REG | `I250` | S | |
| 02 | COD_CTA | C | S | analytical account |
| 03 | COD_CCUS | C | N | |
| 04 | VL_DC | N 19,2 | S | |
| 05 | IND_DC | C 1 | S | D/C |
| 06 | NUM_ARQ | C | N | document number / archive location |
| 07 | COD_HIST_PAD | C | N | from I075 |
| 08 | HIST | C (up to 65535) | N* | narrative. In practice required unless COD_HIST_PAD fully describes it |
| 09 | COD_PART | C | N | participant from 0150 (only when 0180 relationship exists) |

Additional fields if IDENT_MF = S (via I020): 10 VL_DC_MF, 11 IND_DC_MF.

#### I350 – Saldos das contas de resultado antes do encerramento: data [V]
`|I350|DT_RES|`, the date of the result calculation (e.g. 31122025). One per closing date.

#### I355 – Detalhe dos saldos das contas de resultado antes do encerramento [V]
| # | Field | Notes |
|---|---|---|
| 01 | REG | `I355` |
| 02 | COD_CTA | analytical result account (COD_NAT 04) |
| 03 | COD_CCUS | optional |
| 04 | VL_CTA | N 19,2 balance before closing entry |
| 05 | IND_DC | D/C |

Additional fields if IDENT_MF = S: 06 VL_CTA_MF, 07 IND_DC_MF.

#### I990 – Encerramento do Bloco I [V]
`|I990|QTD_LIN_I|`

#### J001 – Abertura do Bloco J [V]
`|J001|IND_DAD|`

#### J005 – Demonstrações contábeis [V]
| # | Field | Type | Obr | Notes |
|---|---|---|---|---|
| 01 | REG | `J005` | S | |
| 02 | DT_INI | N 8 | S | day after the previous balance-sheet date |
| 03 | DT_FIN | N 8 | S | |
| 04 | ID_DEM | N 1 | S | 1 = statements of the PJ itself (head office + branches); 2 = consolidated or of other PJ |
| 05 | CAB_DEM | C 65535 | conditional | header text; required if ID_DEM = 2 |

#### J100 – Balanço Patrimonial [V]
| # | Field | Type | Obr | Values |
|---|---|---|---|---|
| 01 | REG | `J100` | S | |
| 02 | COD_AGL | C | S | |
| 03 | IND_COD_AGL | C 1 | S | T totalizador, D detalhe |
| 04 | NIVEL_AGL | N | S | ≥ 1 |
| 05 | COD_AGL_SUP | C | conditional | required if NIVEL_AGL > 1 |
| 06 | IND_GRP_BAL | C 1 | S | A ativo; P passivo e PL |
| 07 | DESCR_COD_AGL | C | S | |
| 08 | VL_CTA_INI | N 19,2 | S | opening balance |
| 09 | IND_DC_CTA_INI | C 1 | S | D/C |
| 10 | VL_CTA_FIN | N 19,2 | S | closing balance |
| 11 | IND_DC_CTA_FIN | C 1 | S | D/C |
| 12 | NOTA_EXP_REF | C 12 | N | explanatory note reference |

#### J150 – Demonstração do Resultado do Exercício [V]
| # | Field | Type | Obr | Values |
|---|---|---|---|---|
| 01 | REG | `J150` | S | |
| 02 | NU_ORDEM | N | S | display order |
| 03 | COD_AGL | C | S for D lines (table says N; manual says inform for every line) | |
| 04 | IND_COD_AGL | C 1 | S | T / D |
| 05 | NIVEL_AGL | N | S | |
| 06 | COD_AGL_SUP | C | N/conditional | |
| 07 | DESCR_COD_AGL | C | S | |
| 08 | VL_CTA_INI | N 19,2 | N | prior period's closing value of the line |
| 09 | IND_DC_CTA_INI | C 1 | N | D/C |
| 10 | VL_CTA_FIN | N 19,2 | S | value before closing |
| 11 | IND_DC_CTA_FIN | C 1 | S | D/C |
| 12 | IND_GRP_DRE | C 1 | S | D = reduces profit (despesa), R = increases profit (receita) |
| 13 | NOTA_EXP_REF | C 12 | N | |

#### J900 – Termo de encerramento [V]
| # | Field | Type | Obr |
|---|---|---|---|
| 01 | REG | `J900` | S |
| 02 | DNRC_ENCER | C 21 `TERMO DE ENCERRAMENTO` | S |
| 03 | NUM_ORD | N (= I030.NUM_ORD) | S |
| 04 | NAT_LIVRO | C 80 (= I030.NAT_LIVR) | S |
| 05 | NOME | C | S |
| 06 | QTD_LIN | N (= 9999.QTD_LIN) | S |
| 07 | DT_INI_ESCR | N 8 | S |
| 08 | DT_FIN_ESCR | N 8 | S |

#### J930 – Identificação dos signatários [V]
| # | Field | Type | Obr | Notes |
|---|---|---|---|---|
| 01 | REG | `J930` | S | |
| 02 | IDENT_NOM | C | S | name |
| 03 | IDENT_CPF_CNPJ | N 11/14 | S | |
| 04 | IDENT_QUALIF | C | S | qualification description from the table |
| 05 | COD_ASSIN | C 3 | S | qualification code |
| 06 | IND_CRC | C | conditional | CRC number; required if COD_ASSIN = 900 |
| 07 | EMAIL | C 60 | conditional (900) | |
| 08 | FONE | C 14 | conditional (900) | |
| 09 | UF_CRC | C 2 | conditional (900) | |
| 10 | NUM_SEQ_CRC | C | N (warning if empty for 900) | CRC regularity certificate, format UF/ano/número |
| 11 | DT_CRC | N 8 | N (warning) | certificate expiry |
| 12 | IND_RESP_LEGAL | C 1 | S | S/N, the signatory validated as the company's legal representative |

COD_ASSIN table: 001 PJ (e-CNPJ/e-PJ); 203 Diretor; 204 Conselheiro de Administração; 205 Administrador; 206 Administrador do Grupo; 207 Administrador de Sociedade Filiada; 220 Administrador Judicial PF; 222 Administrador Judicial PJ (profissional responsável); 223 Administrador Judicial/Gestor; 226 Gestor Judicial; 309 Procurador; 312 Inventariante; 313 Liquidante; 315 Interventor; 401 Titular PF EIRELI; 801 Empresário; **900 Contador/Contabilista**; 940 Auditor Independente; 999 Outros. (910/920 are referenced by validation rules for the substitution-term signatories **[U]**.) A minimum of one accountant (900) and one legal representative (IND_RESP_LEGAL = S) is required.

#### J990 – Encerramento do Bloco J [V]
`|J990|QTD_LIN_J|`

#### 9001 / 9900 / 9990 / 9999 [V]
- `|9001|IND_DAD|`
- `|9900|REG_BLC|QTD_REG_BLC|`: one line per register type present in the file (including 9900 itself, 9990 and 9999), REG_BLC unique
- `|9990|QTD_LIN_9|`
- `|9999|QTD_LIN|`: total lines of the file

### 7.3 Minimum file structure for a basic ECD (book G)

```
0000, 0001, 0007, 0990,
I001, I010, I030, I050 (+I051 per analytical account if COD_PLAN_REF set, +I052),
I150/I155 (one I150 per month), I200/I250, I350/I355 (before each closing), I990,
J001, J005, J100, J150, J900, J930 (≥2), J990,
9001, 9900..., 9990, 9999
```

Notes:
- Blocks C (recovered prior ECD) and K (consolidation) are generated/required by the PGE in specific cases. Block C is filled by the PGE when the prior ECD is imported. Emitting `C001` with IND_DAD = 1 and `C990` is common practice **[U: confirm whether the PGE requires C001/C990 in an imported file]**.
- 0020 (decentralised), 0035 (SCP), 0150/0180 (participants), I012/I015 (auxiliary books), I020 (additional fields), I053 (subcontas, Lei 12.973), I075 (standard narratives), I100 (cost centres), I157 (balance transfers on chart change), J210/J215 (DLPA/DMPL), J800/J801 (notes / substitution term), J932/J935 (auditors) are optional or conditional.
- Since leiaute 9, the **DLPA/DMPL (J210)** is expected for most companies (Lei 6.404). Check whether your target customers need it **[S]**.

---

## 8. Pix static BR Code (EMV MPM)

Source: BCB **Manual de Padrões para Iniciação do Pix, versão 2.10.0** (PDF created 19/08/2026), §2.6 "Iniciação via QR Code estático", https://www.bcb.gov.br/content/estabilidadefinanceira/pix/Regulamento_Pix/II_ManualdePadroesparaIniciacaodoPix.pdf . Text was extracted from the PDF locally **[V]**. Merchant Name/City length limits come from the EMV MPM / BR Code manual (https://www.bcb.gov.br/content/estabilidadefinanceira/spb_docs/ManualBRCode.pdf) **[V via EMV spec + 2 secondary sources]**.

### 8.1 Field layout (TLV: ID 2 digits + length 2 digits + value)

| ID | Name | Size | Use | Value / rule |
|---|---|---|---|---|
| 00 | Payload Format Indicator | 02 | M | `01` |
| 01 | Point of Initiation Method | 02 | O | `12` = must not be paid more than once. Omit (or `11`) for a reusable static QR |
| 26 | Merchant Account Information (Pix) | ≤ 99 | M | template, below |
| 26-00 | GUI | 14 | M | `br.gov.bcb.pix` (lowercase in the BCB example) |
| 26-01 | chave | 01..77 | M | Pix key: CPF/CNPJ digits, +55 phone, e-mail, or EVP (UUID, lowercase with hyphens) |
| 26-02 | infoAdicional | 01..72 | O | free text shown to the payer ("description") |
| 26-03 | fss | 08 | O | ISPB of the withdrawal facilitator (Pix Saque only) |
| 52 | Merchant Category Code | 04 | M | `0000` (not informed) |
| 53 | Transaction Currency | 03 | M | `986` (BRL) |
| 54 | Transaction Amount | ≤ 13 | O | e.g. `10.00` (dot decimal). Omit to let the payer type the amount |
| 58 | Country Code | 02 | M | `BR` |
| 59 | Merchant Name | ≤ **25** | M | receiver name (strip accents to be safe) |
| 60 | Merchant City | ≤ **15** | M | city (strip accents) |
| 61 | Postal Code | 08 | O | CEP |
| 62 | Additional Data Field Template | | M | contains 05 |
| 62-05 | Reference Label (txid) | ≤ **25** | M | chars `[a-zA-Z0-9]` only; **`***` when no txid is used** (EMV: "***" means the app obtains it) |
| 63 | CRC16 | 04 | M | hex uppercase, see below |

Length budget (§2.6.1): template 26 is capped at 99 characters, so chave + infoAdicional + fss compete for it. The key is at most 77 (99 − 8 − 14) when nothing else is present; infoAdicional is at most 72. Example from the manual: a 9-char key leaves 64 chars of free text (52 if fss is present).

### 8.2 CRC16 [V]

- **CRC-16/CCITT-FALSE**: polynomial `0x1021`, init `0xFFFF`, no reflection, no final XOR (check value of `"123456789"` = `29B1`)
- Computed over the **entire payload including the literal `6304`** (ID 63 + length 04), then the 4 hex uppercase chars are appended
- Many web generators get this wrong (they exclude `6304`)

### 8.3 Official worked example (BCB manual §2.6.3) [V; CRC re-computed locally = 1D3D ✔]

Receiver "Fulano de Tal", key EVP `123e4567-e12b-12d1-a456-426655440000`, no amount, no txid, no infoAdicional:

```
00 02 01
26 58
   00 14 br.gov.bcb.pix
   01 36 123e4567-e12b-12d1-a456-426655440000
52 04 0000
53 03 986
58 02 BR
59 13 Fulano de Tal
60 08 BRASILIA
62 07
   05 03 ***
63 04 1D3D
```

Payload:
```
00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D
```

Extra example (same key, infoAdicional "Pedido 123", amount 10.00). Generated and CRC'd locally, **not from BCB**:
```
00020126720014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400000210Pedido 123520400005303986540510.005802BR5913Fulano de Tal6008BRASILIA62070503***63040260
```

---

## Open items / could not confirm

1. **LC 123 art. 18 §5-M** full inciso list (beyond inciso I = §5-B XVI, XVIII–XXI) and the exact wording of §5-B XVIII–XXI and §5-I. Planalto was unreachable. **[U]**
2. **Res. CGSN 140 art. 59** paragraph numbers for the mandatory "DOCUMENTO EMITIDO POR ME OU EPP..." text (art. 59 was amended by Res. CGSN 191/2026). **[U]**
3. **ICMS Alagoas:** whether the 1% FECOEP is on top of the new 20,5% (21,5% effective). **Sergipe:** 19% + 1% vs 20%. **[U]**
4. **NT 2025.002:** current version (v1.3x vs v1.51) and exact XML tag names of the total subgroups. Treatment of vIPI and ICMS-ST in the vBC rule. Download the XSD from the NF-e portal. **[U]**
5. **CT-e / NFCom** IBS/CBS mandatory dates. **[U]**
6. **CBS reference rate for 2027:** not set yet (TCU by 30/10/2026, Senado by 15/12/2026). **IBS 2027 split** (0,05% + 0,05%) is from memory of LC 214 art. 344. **[U/S]**
7. **CSRF after PIS/COFINS extinction (2027):** no confirmed rule on what remains (CSLL 1%?). **[U]**
8. **ECD:** whether the import file must carry C001/C990. The precise code meaning of COD_ASSIN 910/920. The 0000.CNPJ field type after ADE Cofis 01/2026. **[U]**
9. **PLP 108/2024** (common IBS/CBS regulation and CGIBS): enactment number/date not verified here. The penalty-waiver clock in Ato Conjunto 1/2025 depends on it. **[U]**
10. **LC 224/2025 litigation:** injunctions are individual; STF ADIs are pending. Re-check status before relying on the +10% in production. **[S]**
