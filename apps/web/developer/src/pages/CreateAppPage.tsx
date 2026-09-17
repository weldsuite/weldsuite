import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useDeveloperI18n } from '@/lib/i18n';
import { useCreateUserApp } from '@/hooks/use-user-apps';
import { useCanDevelopApps } from '@/hooks/use-permissions';

const CODE_PATTERN = /^[a-z][a-z0-9-]*$/;

export function CreateAppPage() {
  const { t } = useDeveloperI18n();
  const navigate = useNavigate();
  const { canDevelop, isLoading: permissionsLoading } = useCanDevelopApps();
  const createMutation = useCreateUserApp();

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [category, setCategory] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (permissionsLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t.shell.loading}
      </div>
    );
  }

  if (!canDevelop) {
    return <Link to="/apps" className="p-6 text-sm text-primary hover:underline">{t.detail.back}</Link>;
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!CODE_PATTERN.test(code) || code.length < 3 || code.length > 50) {
      setError(t.create.codeInvalid);
      return;
    }
    if (!name.trim()) {
      setError(t.create.nameLabel);
      return;
    }
    try {
      const app = await createMutation.mutateAsync({
        code,
        name: name.trim(),
        description: description.trim() || undefined,
        icon: icon.trim() || undefined,
        category: category.trim() || undefined,
      });
      navigate(`/apps/${app.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.create.error);
    }
  };

  const fieldClass =
    'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border px-6 py-5">
        <Link
          to="/apps"
          className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t.detail.back}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">{t.create.title}</h1>
        <p className="mt-1 max-w-xl text-sm text-muted-foreground">{t.create.description}</p>
      </header>

      <form onSubmit={onSubmit} className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-lg space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">{t.create.codeLabel}</span>
            <input
              className={fieldClass}
              value={code}
              onChange={(e) => setCode(e.target.value.toLowerCase())}
              placeholder={t.create.codePlaceholder}
              required
            />
            <span className="text-xs text-muted-foreground">{t.create.codeHint}</span>
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium">{t.create.nameLabel}</span>
            <input
              className={fieldClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.create.namePlaceholder}
              required
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium">{t.create.descriptionLabel}</span>
            <textarea
              className={fieldClass}
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t.create.descriptionPlaceholder}
            />
          </label>

          <div className="grid grid-cols-2 gap-4">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">{t.create.iconLabel}</span>
              <input
                className={fieldClass}
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder={t.create.iconPlaceholder}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">{t.create.categoryLabel}</span>
              <input
                className={fieldClass}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder={t.create.categoryPlaceholder}
              />
            </label>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t.create.submit}
            </button>
            <Link to="/apps" className="text-sm text-muted-foreground hover:text-foreground">
              {t.create.cancel}
            </Link>
          </div>
        </div>
      </form>
    </div>
  );
}
