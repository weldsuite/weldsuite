import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { FieldGrid } from '@weldsuite/ui/components/field-grid';
import { Input } from '@weldsuite/ui/components/input';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import { SSO_SAML_METADATA_MAX_BYTES, type SsoProtocol } from '@weldsuite/app-api-client/schemas/sso';
import { useI18n } from '@/lib/i18n/provider';
import { useSaveSsoOidcConnection } from '@/hooks/queries/use-sso-queries';
import { CopyField } from './copy-field';
import { ssoErrorMessage } from './sso-errors';
import { InlineError } from './sso-parts';
import {
  samlFormValues,
  samlInputFrom,
  samlIssues,
  type SamlFormValues,
  type SamlIssueCode,
  type SsoOidcConnection,
} from './sso-view';

/** A file's text (FileReader: works where `Blob.text` doesn't). */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsText(file);
  });
}

interface ProtocolChoiceProps {
  value: SsoProtocol;
  onChange: (protocol: SsoProtocol) => void;
}

/** OpenID Connect or SAML, for a connection that doesn't exist yet. */
export function SsoProtocolChoice({ value, onChange }: Readonly<ProtocolChoiceProps>) {
  const { t } = useI18n();
  const copy = t.settings.sso.weldid.connection;
  const options: { value: SsoProtocol; label: string; hint: string }[] = [
    { value: 'oidc', label: copy.protocolOidc, hint: copy.protocolOidcHint },
    { value: 'saml', label: copy.protocolSaml, hint: copy.protocolSamlHint },
  ];
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{copy.protocol}</legend>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next === 'saml' ? 'saml' : 'oidc')}
        className="grid gap-2 sm:grid-cols-2"
      >
        {options.map((option) => (
          <label
            key={option.value}
            htmlFor={`sso-protocol-${option.value}`}
            className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary"
          >
            <RadioGroupItem id={`sso-protocol-${option.value}`} value={option.value} className="mt-0.5" />
            <span className="space-y-1">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="block text-sm text-muted-foreground">{option.hint}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </fieldset>
  );
}

interface SamlFormProps {
  connection: SsoOidcConnection | null;
  onSaved: () => void;
  onCancel?: () => void;
}

/**
 * Create a SAML connection from the identity provider's metadata (a URL or
 * a file), or change a saved one: new metadata, the name, whether to trust
 * its emails.
 */
export function SsoSamlConnectionForm({ connection, onSaved, onCancel }: Readonly<SamlFormProps>) {
  const { t } = useI18n();
  const ts = t.settings.sso;
  const copy = ts.weldid.connection;
  const save = useSaveSsoOidcConnection();
  const [error, setError] = useState<unknown>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const schema = useMemo(() => {
    const messages: Record<SamlIssueCode, string> = {
      required: ts.validation.required,
      httpsUrl: ts.validation.httpsUrl,
      metadataRequired: copy.metadataRequired,
    };
    return z
      .object({
        displayName: z.string(),
        source: z.enum(['url', 'file']),
        metadataUrl: z.string(),
        metadataXml: z.string(),
        trustEmails: z.boolean(),
      })
      .superRefine((values, ctx) => {
        for (const issue of samlIssues(values, connection)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.field], message: messages[issue.code] });
        }
      });
  }, [ts, copy, connection]);

  const form = useForm<SamlFormValues>({
    resolver: zodResolver(schema),
    defaultValues: samlFormValues(connection),
  });
  const source = form.watch('source');

  useEffect(() => {
    form.reset(samlFormValues(connection));
    setFileName(null);
    setFileError(null);
  }, [connection, form]);

  const chooseFile = async (file: File | undefined) => {
    setFileError(null);
    setFileName(null);
    form.setValue('metadataXml', '');
    if (!file) return;
    if (file.size > SSO_SAML_METADATA_MAX_BYTES) {
      setFileError(copy.metadataFileTooLarge);
      return;
    }
    try {
      const text = await readFileText(file);
      form.setValue('metadataXml', text, { shouldValidate: true });
      setFileName(file.name);
    } catch {
      setFileError(copy.metadataFileUnreadable);
    }
  };

  const submit = async (values: SamlFormValues) => {
    setError(null);
    const input = samlInputFrom(values, connection);
    if (connection && Object.keys(input).length === 0) {
      onSaved();
      return;
    }
    try {
      await save.mutateAsync(input);
      let message = copy.samlCreated;
      if (connection) message = input.metadataUrl ? copy.metadataRefetched : copy.saved;
      toast.success(message);
      onSaved();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} noValidate className="space-y-4">
        {!connection && <p className="text-sm text-muted-foreground">{copy.samlDescription}</p>}
        <FormField
          control={form.control}
          name="displayName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{copy.displayName}</FormLabel>
              <FormControl>
                <Input {...field} placeholder={copy.displayNamePlaceholder} autoComplete="off" className="max-w-sm" />
              </FormControl>
              <FormDescription>{copy.displayNameHint}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="source"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{copy.metadataSource}</FormLabel>
              <FormControl>
                <RadioGroup
                  value={field.value}
                  onValueChange={(next) => field.onChange(next === 'file' ? 'file' : 'url')}
                  className="flex flex-wrap gap-4"
                >
                  <label htmlFor="sso-metadata-url" className="flex items-center gap-2 text-sm">
                    <RadioGroupItem id="sso-metadata-url" value="url" />
                    {copy.metadataFromUrl}
                  </label>
                  <label htmlFor="sso-metadata-file" className="flex items-center gap-2 text-sm">
                    <RadioGroupItem id="sso-metadata-file" value="file" />
                    {copy.metadataFromFile}
                  </label>
                </RadioGroup>
              </FormControl>
            </FormItem>
          )}
        />
        {/* Both stay mounted (the other one hidden): a field that unmounts
            loses its value in react-hook-form, and its rule would then fail. */}
        <div hidden={source !== 'url'}>
          <FormField
            control={form.control}
            name="metadataUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{copy.metadataUrl}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type="url"
                    inputMode="url"
                    placeholder={copy.metadataUrlPlaceholder}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </FormControl>
                <FormDescription>{copy.metadataUrlHint}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <div hidden={source !== 'file'}>
          <FormField
            control={form.control}
            name="metadataXml"
            render={() => (
              <FormItem>
                <FormLabel>{copy.metadataFile}</FormLabel>
                <FormControl>
                  <Input
                    type="file"
                    accept=".xml,application/xml,text/xml,application/samlmetadata+xml"
                    onChange={(event) => void chooseFile(event.target.files?.[0])}
                    className="max-w-md"
                  />
                </FormControl>
                <FormDescription>
                  {fileName ? copy.metadataFileChosen.replace('{name}', fileName) : copy.metadataFileHint}
                </FormDescription>
                {fileError && <p className="text-sm font-medium text-destructive">{fileError}</p>}
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="trustEmails"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start gap-3">
              <FormControl>
                <Checkbox checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />
              </FormControl>
              <div className="space-y-1">
                <FormLabel>{copy.trustEmails}</FormLabel>
                <FormDescription>{copy.samlTrustEmailsHint}</FormDescription>
              </div>
            </FormItem>
          )}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {connection ? copy.save : copy.create}
          </Button>
          {onCancel && (
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              {t.common.actions.cancel}
            </Button>
          )}
        </div>
        {error !== null && <InlineError>{ssoErrorMessage(error, ts.errors, true, 'saml')}</InlineError>}
      </form>
    </Form>
  );
}

/** A saved SAML connection: the identity provider's side, as WeldID read it from the metadata. */
export function SsoSamlConnectionSummary({ connection }: Readonly<{ connection: SsoOidcConnection }>) {
  const { t, language } = useI18n();
  const copy = t.settings.sso.weldid.connection;
  const saml = connection.saml;
  const date = (value: string | null) => {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(language);
  };
  return (
    <FieldGrid
      fields={[
        { label: copy.displayName, value: connection.displayName },
        { label: copy.protocol, value: copy.protocolSaml },
        { label: copy.idpEntityId, value: saml?.idpEntityId ? <span className="break-all">{saml.idpEntityId}</span> : null },
        { label: copy.idpSsoUrl, value: saml?.idpSsoUrl ? <span className="break-all">{saml.idpSsoUrl}</span> : null },
        {
          label: copy.idpMetadata,
          value: saml?.idpMetadataUrl ? <span className="break-all">{saml.idpMetadataUrl}</span> : copy.idpMetadataUploaded,
        },
        {
          label: copy.certificates,
          value:
            saml && saml.idpCertificates.length > 0 ? (
              <ul className="space-y-1">
                {saml.idpCertificates.map((certificate) => (
                  <li key={certificate.sha256}>
                    <span className="break-all font-mono text-[12px]">{certificate.sha256}</span>
                    {certificate.notAfter && (
                      <span className="block text-muted-foreground">
                        {copy.certificateExpires.replace('{date}', date(certificate.notAfter) ?? '')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null,
        },
        { label: copy.trustEmails, value: connection.trustEmails ? copy.trustEmailsOn : copy.trustEmailsOff },
      ]}
    />
  );
}

/** What the admin registers at the identity provider: the entity ID, the reply URL, or our metadata URL. */
export function SsoSamlRegisterPanel({ connection }: Readonly<{ connection: SsoOidcConnection }>) {
  const { t } = useI18n();
  const copy = t.settings.sso.weldid.connection;
  const saml = connection.saml;
  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{copy.spTitle}</p>
        <p className="text-sm text-muted-foreground">{copy.spDescription}</p>
      </div>
      {saml ? (
        <>
          <CopyField label={copy.spEntityId} value={saml.entityId} />
          <CopyField label={copy.spAcsUrl} value={saml.acsUrl} />
          <CopyField label={copy.spMetadataUrl} value={saml.metadataUrl} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{copy.redirectPending}</p>
      )}
    </div>
  );
}
