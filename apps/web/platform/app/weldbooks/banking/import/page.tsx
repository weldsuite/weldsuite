import { useState, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Badge } from '@weldsuite/ui/components/badge';
import { ArrowLeft, Upload, FileText, CheckCircle2, AlertCircle } from 'lucide-react';
import { useAccountingBankAccounts } from '@/hooks/queries/use-accounting-queries';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

type Step = 'select' | 'upload' | 'result';

export default function BankImportPage() {
  const navigate = useNavigate();
  const { data: bankAccountsData } = useAccountingBankAccounts();
  const bankAccounts = bankAccountsData?.data ?? [];
  const qc = useQueryClient();
  const { t } = useI18n();
  const st = useTranslations();
  const tbp = t.accounting.bankingPages;

  const [step, setStep] = useState<Step>('select');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [importResult, setImportResult] = useState<any>(null);

  const importMutation = useMutation({
    mutationFn: (data: { bankAccountId: string; content: string; fileName: string }) =>
      accountingApi.importBankTransactions(data),
    onSuccess: (result) => {
      setImportResult(result?.data);
      setStep('result');
      qc.invalidateQueries({ queryKey: ['accounting', 'bank-transactions'] });
      qc.invalidateQueries({ queryKey: ['accounting', 'bank-accounts'] });
    },
  });

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (evt) => {
      setFileContent(evt.target?.result as string);
    };
    reader.readAsText(file);
  }, []);

  const handleImport = () => {
    if (!selectedAccountId || !fileContent) return;
    importMutation.mutate({
      bankAccountId: selectedAccountId,
      content: fileContent,
      fileName,
    });
  };

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/weldbooks/banking' })}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-semibold">{tbp.importTitle}</h1>
      </div>

      {step === 'select' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tbp.step1Title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>{tbp.bankAccount}</Label>
              <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                <SelectTrigger>
                  <SelectValue placeholder={tbp.selectBankAccount} />
                </SelectTrigger>
                <SelectContent>
                  {bankAccounts.map((ba: any) => (
                    <SelectItem key={ba.id} value={ba.id}>
                      {ba.name} — {ba.iban}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={() => setStep('upload')}
              disabled={!selectedAccountId}
            >
              {tbp.next}
            </Button>
          </CardContent>
        </Card>
      )}

      {step === 'upload' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tbp.step2Title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {tbp.uploadDescription}
            </p>
            <div className="border-2 border-dashed rounded-lg p-8 text-center">
              <input
                type="file"
                accept=".sta,.mt940,.940,.xml,.csv,.txt"
                onChange={handleFileSelect}
                className="hidden"
                id="bank-file-input"
              />
              <label
                htmlFor="bank-file-input"
                className="cursor-pointer flex flex-col items-center gap-2"
              >
                <Upload className="h-8 w-8 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  {tbp.clickToSelect}
                </span>
              </label>
            </div>
            {fileName && (
              <div className="flex items-center gap-2 text-sm">
                <FileText className="h-4 w-4" />
                <span>{fileName}</span>
                <Badge variant="outline">{(fileContent.length / 1024).toFixed(1)} KB</Badge>
              </div>
            )}
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep('select')}>{tbp.back}</Button>
              <Button
                onClick={handleImport}
                disabled={!fileContent || importMutation.isPending}
              >
                {importMutation.isPending ? tbp.importing : tbp.import}
              </Button>
            </div>
            {importMutation.isError && (
              <p className="text-sm text-destructive flex items-center gap-1">
                <AlertCircle className="h-4 w-4" />
                {tbp.importFailed.replace('{error}', (importMutation.error as any)?.message || st('sweep.weldbooks.common.unknownError'))}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {step === 'result' && importResult && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              {tbp.importCompleteTitle}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">{tbp.formatDetected}</span>
                <Badge variant="outline" className="ml-2">{importResult.format}</Badge>
              </div>
              <div>
                <span className="text-muted-foreground">{tbp.totalParsed}</span>
                <span className="ml-2 font-medium">{importResult.totalParsed}</span>
              </div>
              <div>
                <span className="text-muted-foreground">{tbp.imported}</span>
                <span className="ml-2 font-medium">{importResult.imported}</span>
              </div>
              <div>
                <span className="text-muted-foreground">{tbp.duplicatesSkipped}</span>
                <span className="ml-2 font-medium">{importResult.duplicates}</span>
              </div>
              <div>
                <span className="text-muted-foreground">{tbp.autoReconciled}</span>
                <span className="ml-2 font-medium">{importResult.autoReconciled}</span>
              </div>
            </div>
            {importResult.errors?.length > 0 && (
              <div className="mt-2">
                <p className="text-sm font-medium text-destructive">{tbp.parseErrors}</p>
                {importResult.errors.map((err: any, i: number) => (
                  <p key={i} className="text-xs text-muted-foreground">
                    {err.line ? st('sweep.weldbooks.bankImport.lineLabel', { line: err.line }) : ''}{err.message}
                  </p>
                ))}
              </div>
            )}
            <div className="flex gap-3 pt-2">
              <Button variant="outline" onClick={() => { setStep('select'); setImportResult(null); setFileContent(''); setFileName(''); }}>
                {tbp.importAnother}
              </Button>
              <Button onClick={() => navigate({ to: '/weldbooks/banking' })}>
                {tbp.done}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
