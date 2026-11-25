/** The field groups of the item screen, per item type. */

import { Linking } from 'react-native';
import type { WeldPassItem } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { safeHref } from '@weldsuite/app-api-client/schemas/weldpass-items';

import { FieldRow } from '@/components/FieldRow';
import { Group } from '@/components/Group';
import { TotpCode } from '@/components/TotpCode';
import type { ItemSecrets, SecretField } from '@/hooks/use-item-secrets';
import { useI18n } from '@/lib/i18n';

interface SectionProps {
  item: WeldPassItem;
  secrets: ItemSecrets;
}

/** A secret field: dots until revealed, a show/hide toggle, and optionally copy. */
function SecretRow({
  secrets,
  field,
  label,
  copy = false,
  multiline = false,
  monospace = false,
  testID,
}: Readonly<{
  secrets: ItemSecrets;
  field: SecretField;
  label: string;
  copy?: boolean;
  multiline?: boolean;
  monospace?: boolean;
  testID?: string;
}>) {
  return (
    <FieldRow
      label={label}
      value={secrets.value(field)}
      secret
      shown={secrets.isShown(field)}
      multiline={multiline}
      monospace={monospace}
      onToggle={() => void secrets.toggle(field)}
      onCopy={copy ? () => void secrets.copySecretField(label, field) : undefined}
      testID={testID}
    />
  );
}

export function LoginSection({ item, secrets }: Readonly<SectionProps>) {
  const { t } = useI18n();
  const href = safeHref(item.url);
  const username = item.subtitle ?? '';
  const url = item.url ?? '';
  return (
    <Group>
      <FieldRow
        label={t.item.username}
        value={item.subtitle}
        onCopy={username ? () => void secrets.copyPlain(t.item.username, username) : undefined}
        testID="field-username"
      />
      <SecretRow secrets={secrets} field="password" label={t.item.password} copy monospace testID="field-password" />
      {url ? (
        <FieldRow
          label={t.item.website}
          value={url}
          onOpen={href ? () => void Linking.openURL(href) : undefined}
          onCopy={() => void secrets.copyPlain(t.item.website, url)}
          testID="field-website"
        />
      ) : null}
      {item.hasTotp ? (
        <TotpCode vaultId={item.vaultId} itemId={item.id} onCopy={(code) => void secrets.copyCode(code)} />
      ) : null}
    </Group>
  );
}

export function CardSection({ secrets }: Readonly<SectionProps>) {
  const { t } = useI18n();
  return (
    <Group>
      <SecretRow secrets={secrets} field="cardholder" label={t.item.cardholder} />
      <SecretRow secrets={secrets} field="number" label={t.item.number} copy monospace />
      <SecretRow secrets={secrets} field="expiry" label={t.item.expiry} />
      <SecretRow secrets={secrets} field="cvc" label={t.item.cvc} copy />
    </Group>
  );
}

export function NoteSection({ secrets }: Readonly<SectionProps>) {
  const { t } = useI18n();
  return (
    <Group>
      <SecretRow secrets={secrets} field="content" label={t.item.content} copy multiline />
    </Group>
  );
}

/** Notes, and a login's Android apps once revealed. */
export function NotesSection({ secrets }: Readonly<SectionProps>) {
  const { t } = useI18n();
  const fields = secrets.fields;
  const apps = fields && 'username' in fields ? (fields.apps ?? []) : [];
  return (
    <Group>
      <SecretRow secrets={secrets} field="notes" label={t.item.notes} multiline />
      {apps.length > 0 ? <FieldRow label={t.item.apps} value={apps.join('\n')} multiline /> : null}
    </Group>
  );
}
