import { Link } from 'react-router-dom';
import { useDeveloperI18n } from '@/lib/i18n';

function Step({
  n,
  title,
  body,
  code,
}: {
  n: number;
  title: string;
  body: string;
  code: string;
}) {
  return (
    <li className="relative pl-10">
      <span className="absolute left-0 top-0 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
        {n}
      </span>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-[var(--code-bg)] p-4 text-xs leading-relaxed text-[var(--code-fg)]">
        {code}
      </pre>
    </li>
  );
}

export function GettingStartedPage() {
  const { t } = useDeveloperI18n();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border px-6 py-5">
        <h1 className="text-xl font-semibold tracking-tight">{t.gettingStarted.title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t.gettingStarted.subtitle}</p>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <ol className="mx-auto max-w-2xl space-y-8">
          <Step
            n={1}
            title={t.gettingStarted.step1Title}
            body={t.gettingStarted.step1Body}
            code={`npm install -g @weldsuite/cli\nweld login\n# or for CI: export WELD_API_KEY=wsk_...`}
          />
          <Step
            n={2}
            title={t.gettingStarted.step2Title}
            body={t.gettingStarted.step2Body}
            code={`weld app create my-app --name "My App" --code my-app\ncd my-app && npm install`}
          />
          <Step
            n={3}
            title={t.gettingStarted.step3Title}
            body={t.gettingStarted.step3Body}
            code={`weld app dev\n# or against hosted HTTPS:\nweld app dev --tunnel`}
          />
          <Step
            n={4}
            title={t.gettingStarted.step4Title}
            body={t.gettingStarted.step4Body}
            code={`# bump version in weldapp.json\nweld app deploy --changelog "First release"\nweld app versions\nweld app update\nweld app oauth --create`}
          />
          <Step
            n={5}
            title={t.gettingStarted.step5Title}
            body={t.gettingStarted.step5Body}
            code={`weld app publish --notes "Initial review"`}
          />
        </ol>

        <p className="mx-auto mt-10 max-w-2xl text-sm text-muted-foreground">
          <Link to="/apps" className="text-primary hover:underline">
            {t.nav.apps}
          </Link>
          {' · '}
          <a
            href="https://www.npmjs.com/package/@weldsuite/cli"
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            {t.gettingStarted.docsLink}
          </a>
        </p>
      </div>
    </div>
  );
}
