export function Section({ title, description, children, actions }: Readonly<{ title: string; description?: string; children: React.ReactNode; actions?: React.ReactNode }>) {
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
