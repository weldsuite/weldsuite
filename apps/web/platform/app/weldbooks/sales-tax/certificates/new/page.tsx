import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { useCreateExemptionCertificate } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { SalesTaxSetupGate, useSalesTaxSetupAccess } from '../../setup/setup-gate';
import { useSetupTexts } from '../../setup/setup-texts';
import { CertificateForm } from '../certificate-form';
import { emptyCertificateForm, toCreateCertificateInput } from '../certificate-model';

function NewCertificate() {
  const { t } = useSetupTexts();
  const tf = t.certificates.form;
  const navigate = useNavigate();
  const { canCreate } = useSalesTaxSetupAccess();
  const { today } = useWeldbooksFormat();
  const create = useCreateExemptionCertificate();
  // The customer's own Exemptions tab links here with `?partyId=`.
  const search = useSearch({ strict: false }) as { partyId?: string };
  const partyId = search.partyId ?? '';

  if (!canCreate) return <p className="p-6 text-sm text-muted-foreground">{t.common.noAccess}</p>;

  const back = partyId
    ? ({ to: '/weldbooks/customers/$id', params: { id: partyId } } as const)
    : ({ to: '/weldbooks/sales-tax/certificates' } as const);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
      <div className="space-y-1">
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link {...back}>
            <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
            {t.certificates.detail.back}
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold">{tf.addTitle}</h1>
        <p className="text-sm text-muted-foreground">{tf.addSubtitle}</p>
      </div>
      <CertificateForm
        mode="create"
        initial={emptyCertificateForm(partyId, today())}
        submitting={create.isPending}
        submitError={create.isError ? (create.error instanceof Error && create.error.message ? create.error.message : tf.saveError) : null}
        onCancel={() => void navigate(back)}
        onSubmit={async (values) => {
          try {
            const created = await create.mutateAsync(toCreateCertificateInput(values));
            toast.success(t.certificates.detail.created);
            void navigate({ to: '/weldbooks/sales-tax/certificates/$id', params: { id: created.id } });
          } catch {
            // The error shows under the form (create.error).
          }
        }}
      />
    </div>
  );
}

/** Add an exemption certificate: the form, behind the US and permission gate. */
export default function NewExemptionCertificatePage() {
  return (
    <SalesTaxSetupGate>
      <NewCertificate />
    </SalesTaxSetupGate>
  );
}
