/**
 * SPED ECD (Escrituração Contábil Digital), leiaute 9 (COD_VER_LC 9.00): the
 * yearly digital bookkeeping the contador imports into the PGE, signs and
 * transmits. One Livro Diário Geral (book G) for a calendar or fiscal year:
 *
 *   Bloco 0  company identification
 *   Bloco I  chart of accounts (I050, with synthetic parents built from the
 *            dotted codes), monthly balances (I150/I155), journal entries
 *            (I200/I250), result balances before closing (I350/I355)
 *   Bloco J  balance sheet (J100), income statement (J150), closing term and
 *            signatories (J900/J930)
 *   Bloco 9  register counts
 *
 * The referential chart (I051) is left to the contador: mapping each account
 * to the RFB's plano referencial is done in the PGE. When the ledger has no
 * closing entry for the year, one is generated (IND_LCTO "E") that moves the
 * result accounts to retained earnings, as the ECD requires.
 *
 * Fields are separated by "|", dates are ddmmaaaa and amounts use a decimal
 * comma; the caller encodes the text as ISO-8859-1.
 */

export interface EcdAccount {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
}

export interface EcdEntryLine {
  accountCode: string;
  debit: number;
  credit: number;
  description?: string | null;
}

export interface EcdEntry {
  id: string;
  /** yyyy-mm-dd */
  date: string;
  description?: string | null;
  lines: EcdEntryLine[];
  /** A closing entry (encerramento) already in the ledger. */
  closing?: boolean;
}

export interface EcdSignatory {
  name: string;
  /** CPF or CNPJ, digits only. */
  taxId: string;
  /** 900 = contador; 205 administrador, 203 diretor, 801 empresário, ... */
  code: string;
  qualification: string;
  crc?: string;
  crcUf?: string;
  email?: string;
  phone?: string;
  legalRepresentative: boolean;
}

export interface EcdInput {
  /** yyyy-mm-dd, inclusive */
  periodStart: string;
  periodEnd: string;
  company: {
    name: string;
    cnpj: string;
    uf: string;
    ie?: string | null;
    municipalityCode?: string | null;
    municipalityName?: string | null;
    im?: string | null;
    nire?: string | null;
  };
  accounts: EcdAccount[];
  /** Balance per account code at the start of the period, debit positive. */
  openingBalances: Record<string, number>;
  entries: EcdEntry[];
  /** Account the generated closing entry moves the result to. */
  retainedEarningsCode: string;
  signatories: EcdSignatory[];
  /** Book number (I030 NUM_ORD), 1 for the first ECD. */
  bookNumber?: number;
  /** 0 normal start of period, 1 company opened in the period. */
  startSituation?: 0 | 1;
}

export interface EcdResult {
  content: string;
  lineCount: number;
  warnings: string[];
}

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function amount(n: number): string {
  return Math.abs(r2(n)).toFixed(2).replace('.', ',');
}

function dc(balance: number): 'D' | 'C' {
  return balance < 0 ? 'C' : 'D';
}

function ddmmaaaa(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  return `${d}${m}${y}`;
}

/** Field text: no pipes or line breaks. */
function text(value: string | null | undefined): string {
  return (value ?? '').replace(/[|\r\n]+/g, ' ').trim();
}

const SYNTHETIC_NAMES: Record<string, string> = {
  '1': 'ATIVO',
  '1.1': 'ATIVO CIRCULANTE',
  '1.2': 'ATIVO NAO CIRCULANTE',
  '2': 'PASSIVO E PATRIMONIO LIQUIDO',
  '2.1': 'PASSIVO CIRCULANTE',
  '2.2': 'PASSIVO NAO CIRCULANTE',
  '2.3': 'PATRIMONIO LIQUIDO',
  '3': 'RECEITAS',
  '3.1': 'RECEITA OPERACIONAL',
  '3.2': 'OUTRAS RECEITAS',
  '4': 'CUSTOS E DESPESAS',
  '4.1': 'CUSTOS',
  '4.2': 'DESPESAS OPERACIONAIS',
  '4.3': 'DESPESAS FINANCEIRAS E OUTRAS',
  '4.9': 'TRIBUTOS SOBRE O LUCRO',
};

const NATURE_ROOT: Record<EcdAccount['type'], string> = {
  asset: '1',
  liability: '2',
  equity: '2',
  revenue: '3',
  expense: '4',
};

function natureCode(type: EcdAccount['type'] | 'synthetic', code: string): string {
  if (type === 'asset') return '01';
  if (type === 'liability') return '02';
  if (type === 'equity') return '03';
  if (type === 'revenue' || type === 'expense') return '04';
  if (code.startsWith('1')) return '01';
  if (code.startsWith('2.3')) return '03';
  if (code.startsWith('2')) return '02';
  return '04';
}

interface ChartNode {
  code: string;
  name: string;
  level: number;
  parent: string | null;
  synthetic: boolean;
  nature: string;
  type?: EcdAccount['type'];
}

/** The chart with synthetic parents: "1.1.4.01" sits under "1.1.4", "1.1" and "1"; a code without dots under its nature's root. */
function buildChart(accounts: EcdAccount[]): ChartNode[] {
  const nodes = new Map<string, ChartNode>();
  const addSynthetic = (code: string, level: number, parent: string | null) => {
    if (nodes.has(code)) return;
    nodes.set(code, {
      code,
      name: SYNTHETIC_NAMES[code] ?? `GRUPO ${code}`,
      level,
      parent,
      synthetic: true,
      nature: natureCode('synthetic', code),
    });
  };
  for (const account of accounts) {
    const parts = account.code.split('.');
    let parent: string | null;
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i++) {
        addSynthetic(parts.slice(0, i).join('.'), i, i > 1 ? parts.slice(0, i - 1).join('.') : null);
      }
      parent = parts.slice(0, -1).join('.');
    } else {
      parent = NATURE_ROOT[account.type];
      addSynthetic(parent, 1, null);
    }
    nodes.set(account.code, {
      code: account.code,
      name: account.name,
      level: (nodes.get(parent)?.level ?? 0) + 1,
      parent,
      synthetic: false,
      nature: natureCode(account.type, account.code),
      type: account.type,
    });
  }
  const order = (code: string) => code.split('.').map((p) => p.padStart(4, '0')).join('.');
  return [...nodes.values()].sort((a, b) => order(a.code).localeCompare(order(b.code)));
}

function monthsOf(start: string, end: string): Array<{ start: string; end: string }> {
  const months: Array<{ start: string; end: string }> = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const last = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    months.push({ start: first < start ? start : first, end: last > end ? end : last });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

export function buildEcd(input: EcdInput): EcdResult {
  const warnings: string[] = [];
  const lines: string[] = [];
  const counts = new Map<string, number>();
  const emit = (...fields: Array<string | number | null | undefined>) => {
    const reg = String(fields[0]);
    counts.set(reg, (counts.get(reg) ?? 0) + 1);
    lines.push(`|${fields.map((f) => (f === null || f === undefined ? '' : String(f))).join('|')}|`);
  };

  const chart = buildChart(input.accounts);
  const analytical = chart.filter((n) => !n.synthetic);
  const byCode = new Map(chart.map((n) => [n.code, n]));
  const cnpj = input.company.cnpj.replace(/[^0-9A-Z]/gi, '').toUpperCase();
  const start = input.periodStart;
  const end = input.periodEnd;

  // Entries, with a closing entry when the ledger has none.
  const entries = input.entries
    .filter((e) => e.date >= start && e.date <= end)
    .map((e) => ({ ...e, lines: e.lines.filter((l) => byCode.has(l.accountCode) && (l.debit !== 0 || l.credit !== 0)) }))
    .filter((e) => e.lines.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const balanceBeforeClosing = new Map<string, number>();
  for (const node of analytical) balanceBeforeClosing.set(node.code, input.openingBalances[node.code] ?? 0);
  for (const entry of entries.filter((e) => !e.closing)) {
    for (const l of entry.lines) balanceBeforeClosing.set(l.accountCode, (balanceBeforeClosing.get(l.accountCode) ?? 0) + l.debit - l.credit);
  }
  const resultAccounts = analytical.filter((n) => n.nature === '04');
  const hasClosing = entries.some((e) => e.closing);
  if (!hasClosing) {
    if (!byCode.has(input.retainedEarningsCode)) {
      warnings.push(`Retained earnings account ${input.retainedEarningsCode} is not in the chart; no closing entry was generated.`);
    } else {
      const closingLines: EcdEntryLine[] = [];
      let net = 0;
      for (const node of resultAccounts) {
        const balance = r2(balanceBeforeClosing.get(node.code) ?? 0);
        if (balance === 0) continue;
        closingLines.push({ accountCode: node.code, debit: balance < 0 ? -balance : 0, credit: balance > 0 ? balance : 0, description: 'Encerramento do exercício' });
        net += balance;
      }
      if (closingLines.length > 0) {
        closingLines.push({
          accountCode: input.retainedEarningsCode,
          debit: net > 0 ? r2(net) : 0,
          credit: net < 0 ? r2(-net) : 0,
          description: 'Resultado do exercício',
        });
        entries.push({ id: `ENC-${end.slice(0, 4)}`, date: end, description: 'Encerramento do exercício', lines: closingLines, closing: true });
      }
    }
  }

  // Bloco 0
  emit('0000', 'LECD', ddmmaaaa(start), ddmmaaaa(end), text(input.company.name), cnpj, input.company.uf, text(input.company.ie), input.company.municipalityCode ?? '', text(input.company.im), '', input.startSituation ?? 0, input.company.nire ? 1 : 0, 0, '', 0, 0, '', 'N', 'N', 0, 0, '');
  emit('0001', 0);
  emit('0007', input.company.ie ? input.company.uf : '00', text(input.company.ie));
  emit('0990', 4);

  // Bloco I
  const blockIStart = lines.length;
  emit('I001', 0);
  emit('I010', 'G', '9.00');
  emit('I030', 'TERMO DE ABERTURA', input.bookNumber ?? 1, 'DIARIO GERAL', '{QTD_LIN}', text(input.company.name), input.company.nire ?? '', cnpj, '', '', text(input.company.municipalityName), ddmmaaaa(end));
  for (const node of chart) {
    emit('I050', ddmmaaaa(start), node.nature, node.synthetic ? 'S' : 'A', node.level, node.code, node.parent ?? '', text(node.name));
    // Each analytical account is its own detail line in J100 / J150.
    if (!node.synthetic) emit('I052', '', node.code);
  }

  // I150/I155: monthly balances of each analytical account with movement or a balance.
  const running = new Map<string, number>();
  for (const node of analytical) running.set(node.code, input.openingBalances[node.code] ?? 0);
  for (const month of monthsOf(start, end)) {
    const moves = new Map<string, { debit: number; credit: number }>();
    for (const entry of entries) {
      if (entry.date < month.start || entry.date > month.end) continue;
      for (const l of entry.lines) {
        const m = moves.get(l.accountCode) ?? { debit: 0, credit: 0 };
        m.debit += l.debit;
        m.credit += l.credit;
        moves.set(l.accountCode, m);
      }
    }
    const rows: string[][] = [];
    for (const node of analytical) {
      const opening = r2(running.get(node.code) ?? 0);
      const m = moves.get(node.code) ?? { debit: 0, credit: 0 };
      const closing = r2(opening + m.debit - m.credit);
      running.set(node.code, closing);
      if (opening === 0 && m.debit === 0 && m.credit === 0) continue;
      rows.push(['I155', node.code, '', amount(opening), dc(opening), amount(m.debit), amount(m.credit), amount(closing), dc(closing)]);
    }
    if (rows.length === 0) continue;
    emit('I150', ddmmaaaa(month.start), ddmmaaaa(month.end));
    for (const row of rows) emit(...row);
  }

  // I200/I250: the journal.
  for (const entry of entries) {
    const total = r2(entry.lines.reduce((s, l) => s + l.debit, 0));
    const credits = r2(entry.lines.reduce((s, l) => s + l.credit, 0));
    if (total !== credits) warnings.push(`Entry ${entry.id} does not balance (${total.toFixed(2)} / ${credits.toFixed(2)}).`);
    emit('I200', text(entry.id), ddmmaaaa(entry.date), amount(total), entry.closing ? 'E' : 'N', '');
    for (const l of entry.lines) {
      const hist = text(l.description ?? entry.description) || 'Lançamento';
      if (l.debit) emit('I250', l.accountCode, '', amount(l.debit), 'D', '', '', hist, '');
      if (l.credit) emit('I250', l.accountCode, '', amount(l.credit), 'C', '', '', hist, '');
    }
  }

  // I350/I355: result accounts before the closing.
  const resultBalances = resultAccounts
    .map((n) => [n.code, r2(balanceBeforeClosing.get(n.code) ?? 0)] as const)
    .filter(([, balance]) => balance !== 0);
  if (resultBalances.length > 0) {
    emit('I350', ddmmaaaa(end));
    for (const [code, balance] of resultBalances) emit('I355', code, '', amount(balance), dc(balance));
  }
  emit('I990', lines.length - blockIStart + 1);

  // Bloco J: statements, aggregated over the chart (each analytical account is a detail line).
  const blockJStart = lines.length;
  emit('J001', 0);
  emit('J005', ddmmaaaa(start), ddmmaaaa(end), 1, '');
  const opening = (code: string) => input.openingBalances[code] ?? 0;
  const closingBalance = (code: string) => running.get(code) ?? 0;
  const subtreeSum = (node: ChartNode, value: (code: string) => number): number =>
    analytical.filter((a) => a.code === node.code || a.code.startsWith(`${node.code}.`) || (!a.code.includes('.') && a.parent === node.code)).reduce((s, a) => s + value(a.code), 0);
  for (const node of chart.filter((n) => n.nature !== '04')) {
    const ini = r2(subtreeSum(node, opening));
    const fin = r2(subtreeSum(node, closingBalance));
    emit('J100', node.code, node.synthetic ? 'T' : 'D', node.level, node.parent ?? '', node.code.startsWith('1') ? 'A' : 'P', text(node.name), amount(ini), dc(ini), amount(fin), dc(fin), '');
  }
  let order = 1;
  for (const node of chart.filter((n) => n.nature === '04')) {
    const value = r2(subtreeSum(node, (code) => balanceBeforeClosing.get(code) ?? 0));
    emit('J150', order++, node.code, node.synthetic ? 'T' : 'D', node.level, node.parent ?? '', text(node.name), '', '', amount(value), dc(value), value <= 0 ? 'R' : 'D', '');
  }
  emit('J900', 'TERMO DE ENCERRAMENTO', input.bookNumber ?? 1, 'DIARIO GERAL', text(input.company.name), '{QTD_LIN}', ddmmaaaa(start), ddmmaaaa(end));
  if (!input.signatories.some((s) => s.code === '900')) warnings.push('The ECD must be signed by a contador (code 900): add one.');
  if (!input.signatories.some((s) => s.legalRepresentative)) warnings.push('The ECD must be signed by the legal representative: add one.');
  for (const s of input.signatories) {
    emit('J930', text(s.name), s.taxId.replace(/\D/g, ''), text(s.qualification), s.code, s.crc ?? '', s.email ?? '', s.phone ?? '', s.crcUf ?? '', '', '', s.legalRepresentative ? 'S' : 'N');
  }
  emit('J990', lines.length - blockJStart + 1);

  // Bloco 9
  emit('9001', 0);
  const registers = [...counts.keys(), '9900', '9990', '9999'];
  const uniqueRegisters = [...new Set(registers)];
  const countOf = (reg: string) => {
    if (reg === '9900') return uniqueRegisters.length;
    if (reg === '9990' || reg === '9999') return 1;
    return counts.get(reg) ?? 0;
  };
  for (const reg of uniqueRegisters) emit('9900', reg, countOf(reg));
  // 9001 + the 9900 lines + 9990 + 9999
  emit('9990', uniqueRegisters.length + 3);
  emit('9999', lines.length + 1);

  const lineCount = lines.length;
  const content = lines.map((l) => l.replace('{QTD_LIN}', String(lineCount))).join('\r\n') + '\r\n';
  return { content, lineCount, warnings };
}

/** ISO-8859-1 bytes of the file (characters outside Latin-1 become "?"). */
export function encodeLatin1(content: string): Uint8Array {
  const bytes = new Uint8Array(content.length);
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    bytes[i] = code < 256 ? code : 63;
  }
  return bytes;
}
