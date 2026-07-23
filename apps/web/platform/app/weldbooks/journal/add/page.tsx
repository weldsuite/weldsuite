import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { Plus, Trash2, ArrowLeft } from 'lucide-react';
import {
  useCreateJournalEntry,
  useAccountingAccounts,
} from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';

interface JournalLine {
  accountId: string;
  description: string;
  debit: string;
  credit: string;
}

const emptyLine = (): JournalLine => ({
  accountId: '',
  description: '',
  debit: '',
  credit: '',
});

export default function AddJournalEntryPage() {
  const navigate = useNavigate();
  const createEntry = useCreateJournalEntry();
  const { data: accountsData } = useAccountingAccounts();
  const accounts = accountsData?.data ?? [];
  const { t } = useI18n();
  const tj = t.accounting.journalEntry;

  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<JournalLine[]>([emptyLine(), emptyLine()]);

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01;

  const updateLine = (idx: number, field: keyof JournalLine, value: string) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  };

  const addLine = () => setLines((prev) => [...prev, emptyLine()]);

  const removeLine = (idx: number) => {
    if (lines.length <= 2) return;
    setLines((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isBalanced) return;
    const validLines = lines.filter((l) => l.accountId && (Number(l.debit) || Number(l.credit)));
    await createEntry.mutateAsync({
      date,
      description,
      reference,
      lines: validLines.map((l) => ({
        accountId: l.accountId,
        description: l.description,
        debit: l.debit || '0',
        credit: l.credit || '0',
      })),
    });
    navigate({ to: '/weldbooks/journal' });
  };

  const fmt = (n: number) =>
    new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(n);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/weldbooks/journal' })}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-semibold">{tj.newEntry}</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tj.entryDetails}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>{tj.date}</Label>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label>{tj.reference}</Label>
                <Input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder={tj.referencePlaceholder}
                />
              </div>
              <div className="space-y-2 md:col-span-1">
                <Label>{tj.description}</Label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={tj.descriptionPlaceholder}
                  rows={1}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">{tj.journalLines}</CardTitle>
            <Button type="button" variant="outline" size="sm" onClick={addLine}>
              <Plus className="h-4 w-4 mr-1" />
              {tj.addLine}
            </Button>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[250px]">{tj.account}</TableHead>
                  <TableHead>{tj.description}</TableHead>
                  <TableHead className="w-[140px]">{tj.debit}</TableHead>
                  <TableHead className="w-[140px]">{tj.credit}</TableHead>
                  <TableHead className="w-[50px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line, idx) => (
                  <TableRow key={idx}>
                    <TableCell>
                      <Select
                        value={line.accountId}
                        onValueChange={(v) => updateLine(idx, 'accountId', v)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={tj.selectAccount} />
                        </SelectTrigger>
                        <SelectContent>
                          {accounts.map((acc: any) => (
                            <SelectItem key={acc.id} value={acc.id}>
                              {acc.code} — {acc.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input
                        value={line.description}
                        onChange={(e) => updateLine(idx, 'description', e.target.value)}
                        placeholder={tj.linePlaceholder}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={line.debit}
                        onChange={(e) => updateLine(idx, 'debit', e.target.value)}
                        placeholder="0.00"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={line.credit}
                        onChange={(e) => updateLine(idx, 'credit', e.target.value)}
                        placeholder="0.00"
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeLine(idx)}
                        disabled={lines.length <= 2}
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell colSpan={2} className="text-right font-medium">
                    {tj.totals}
                  </TableCell>
                  <TableCell className="font-semibold">{fmt(totalDebit)}</TableCell>
                  <TableCell className="font-semibold">{fmt(totalCredit)}</TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>

            {!isBalanced && totalDebit + totalCredit > 0 && (
              <p className="text-destructive text-sm mt-2">
                {tj.notBalanced.replace('{amount}', fmt(Math.abs(totalDebit - totalCredit)))}
              </p>
            )}
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate({ to: '/weldbooks/journal' })}
          >
            {tj.cancel}
          </Button>
          <Button type="submit" disabled={!isBalanced || createEntry.isPending}>
            {createEntry.isPending ? tj.creating : tj.createEntry}
          </Button>
        </div>
      </form>
    </div>
  );
}
