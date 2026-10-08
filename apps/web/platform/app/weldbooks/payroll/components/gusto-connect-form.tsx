import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useCreateGustoConnection } from '@/hooks/queries/use-weldbooks-assets-queries';
import { useI18n } from '@/lib/i18n/provider';
import { errorMessage } from '../../fixed-assets/text';

interface ConnectValues {
  accessToken: string;
  companyId: string;
  environment: 'production' | 'demo';
}

/**
 * Connect Gusto with an access token the customer creates in Gusto. The token
 * is typed into a password field, sent once and cleared; nothing on this page
 * ever shows it again (the API only says whether one is stored).
 */
export function GustoConnectForm({ onConnected }: Readonly<{ onConnected?: () => void }>) {
  const { t } = useI18n();
  const tg = t.weldbooksUs.assets.payroll.gusto.connect;
  const connect = useCreateGustoConnection();
  const [error, setError] = useState<string | null>(null);

  const schema = useMemo(
    () =>
      z.object({
        accessToken: z.string().trim().min(10, tg.tokenInvalid).max(4000, tg.tokenInvalid),
        companyId: z.string().trim().min(1, tg.companyRequired).max(100, tg.companyRequired),
        environment: z.enum(['production', 'demo']),
      }),
    [tg],
  );
  const form = useForm<ConnectValues>({
    resolver: zodResolver(schema),
    defaultValues: { accessToken: '', companyId: '', environment: 'production' },
  });
  const errors = form.formState.errors;

  const submit = async (values: ConnectValues) => {
    setError(null);
    try {
      await connect.mutateAsync({
        provider: 'gusto',
        accessToken: values.accessToken.trim(),
        companyId: values.companyId.trim(),
        environment: values.environment,
      });
      // The token is gone from the form the moment it has been sent.
      form.reset({ accessToken: '', companyId: '', environment: 'production' });
      toast.success(tg.connected);
      onConnected?.();
    } catch (err) {
      form.setValue('accessToken', '');
      setError(errorMessage(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{tg.title}</CardTitle>
        <CardDescription>{tg.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(submit)} className="space-y-4" noValidate data-testid="gusto-connect-form">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="gusto-token">{tg.accessToken}</Label>
              <Input
                id="gusto-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore
                {...form.register('accessToken')}
              />
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {tg.accessTokenHelp}
              </p>
              {errors.accessToken ? (
                <p className="text-sm text-destructive" role="alert">
                  {errors.accessToken.message}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gusto-company">{tg.companyId}</Label>
              <Input id="gusto-company" autoComplete="off" {...form.register('companyId')} />
              <p className="text-xs text-muted-foreground">{tg.companyIdHelp}</p>
              {errors.companyId ? (
                <p className="text-sm text-destructive" role="alert">
                  {errors.companyId.message}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gusto-environment">{tg.environment}</Label>
              <Controller
                control={form.control}
                name="environment"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="gusto-environment">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="production">{tg.environments.production}</SelectItem>
                      <SelectItem value="demo">{tg.environments.demo}</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert" data-testid="gusto-connect-error">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={connect.isPending} data-testid="gusto-connect-submit">
            {connect.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {connect.isPending ? tg.connecting : tg.connect}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
