import Link from '@/components/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import type { NewAppPageData } from './data';
import { NewAppForm } from './new-app-form';

export function NewAppPage(_props: Readonly<NewAppPageData>) {
  return (
    <PageContent>
      <PageBody width="narrow" className="space-y-4">
        <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
          <Link href="/apps">
            <ArrowLeft className="h-4 w-4" />
            Back to App Catalog
          </Link>
        </Button>

        <PageHeading
          title="New app"
          description="Add a new entry to the App Catalog. It will not be visible in the App Store until you publish it."
        />

        <NewAppForm />
      </PageBody>
    </PageContent>
  );
}
