
import { useState } from "react";
import { useRouter, Link } from '@/lib/router';
import { Button } from "@weldsuite/ui/components/button";
import { ArrowLeft, ShoppingCart } from "lucide-react";
import { DomainAvailabilityChecker, type TransformedDomainResult } from "../../components/domain-availability-checker";
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';

export function DomainSearchClient() {
  const { t } = useI18n();
  const ts = t.host.domainSearch;

  useBreadcrumbs([
    { label: t.host.title, href: '/weldhost' },
    { label: t.host.domains.title, href: '/weldhost/domains' },
    { label: ts.title }
  ]);

  const router = useRouter();
  const [selectedDomains, setSelectedDomains] = useState<TransformedDomainResult[]>([]);

  const handleDomainSelect = (domain: TransformedDomainResult) => {
    // Add domain to selected list
    setSelectedDomains((prev) => [...prev, domain]);
  };

  const handleDomainRemove = (domainName: string) => {
    // Remove domain from selected list
    setSelectedDomains((prev) => prev.filter((d) => d.domain_name !== domainName));
  };

  const handleContinue = () => {
    // Navigate to registration page with the first selected domain
    // (You can modify this to handle multiple domains differently)
    if (selectedDomains.length > 0) {
      const domain = selectedDomains[0];
      const params = new URLSearchParams({
        domain: domain.domain,
        available: domain.available ? 'true' : 'false',
        price: domain.price?.toString() || '',
        premium: domain.premium ? 'true' : 'false',
      });
      router.push(`/weldhost/domains/register?${params.toString()}`);
    }
  };

  return (
    <div className="container mx-auto p-8 max-w-[1400px] space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link href="/weldhost/domains">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{ts.title}</h1>
            <p className="text-muted-foreground mt-1">
              {ts.subtitle}
            </p>
          </div>
        </div>

        {/* Cart button */}
        {selectedDomains.length > 0 && (
          <Button onClick={handleContinue} size="lg">
            <ShoppingCart className="h-4 w-4 mr-0.5" />
            {ts.continueWithCount.replace('{count}', String(selectedDomains.length))}
          </Button>
        )}
      </div>

      <DomainAvailabilityChecker
        showCategories={true}
        onDomainSelect={handleDomainSelect}
        onDomainRemove={handleDomainRemove}
        selectedDomainNames={selectedDomains.map((d) => d.domain_name)}
      />
    </div>
  );
}
