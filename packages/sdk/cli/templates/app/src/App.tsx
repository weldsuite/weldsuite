import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useCollection, useWeldApp } from '@weldsuite/app-sdk/react';
import { WeldApiError, type AppRecord, type PersonSummary } from '@weldsuite/app-sdk';

interface Item extends Record<string, unknown> {
  title: string;
  done: boolean;
}

type Tab = 'items' | 'people';

function peopleErrorMessage(cause: unknown): string {
  if (cause instanceof WeldApiError && cause.status === 403) {
    return 'This workspace has not granted people:read. Reinstall the app to consent.';
  }
  return cause instanceof Error ? cause.message : 'Failed to load people';
}

function ItemsList({
  loading,
  records,
  onToggle,
  onRemove,
}: {
  loading: boolean;
  records: AppRecord<Item>[];
  onToggle: (record: AppRecord<Item>) => void;
  onRemove: (record: AppRecord<Item>) => void;
}) {
  if (loading) return <p className="status">Loading items…</p>;
  if (records.length === 0) return <p className="status">No items yet — add your first one above.</p>;
  return (
    <ul className="items">
      {records.map((record) => (
        <li key={record.id} className={record.data.done ? 'done' : ''}>
          <label>
            <input type="checkbox" checked={record.data.done} onChange={() => onToggle(record)} />
            <span>{record.data.title}</span>
          </label>
          <button type="button" onClick={() => onRemove(record)} aria-label="Remove item">
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

function PeopleList({
  loading,
  error,
  people,
}: {
  loading: boolean;
  error: string | null;
  people: PersonSummary[];
}) {
  if (loading) return <p className="status">Loading people…</p>;
  if (error) return <p className="status">{error}</p>;
  if (people.length === 0) return <p className="status">No people in this workspace yet.</p>;
  return (
    <ul className="items">
      {people.map((person) => (
        <li key={person.id}>
          <span>{person.displayName || person.fullName || person.email || person.id}</span>
        </li>
      ))}
    </ul>
  );
}

export default function App() {
  const { theme, locale, user, bridge, api } = useWeldApp();
  const items = useCollection<Item>('items');

  const [tab, setTab] = useState<Tab>('items');
  const [records, setRecords] = useState<AppRecord<Item>[]>([]);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [peopleLoading, setPeopleLoading] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const refresh = useCallback(async () => {
    const response = await items.list({ limit: 50 });
    setRecords(response.data);
    setLoading(false);
  }, [items]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (tab !== 'people') return;
    let cancelled = false;
    setPeopleLoading(true);
    setPeopleError(null);
    void api.people
      .list({ limit: 10 })
      .then((page) => {
        if (!cancelled) setPeople(page.data);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setPeopleError(peopleErrorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setPeopleLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, tab]);

  const addItem = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    await items.create({ title: trimmed, done: false });
    setTitle('');
    await bridge.toast('Item added', 'success');
    await refresh();
  };

  const toggleItem = async (record: AppRecord<Item>) => {
    await items.update(record.id, { ...record.data, done: !record.data.done });
    await refresh();
  };

  const removeItem = async (record: AppRecord<Item>) => {
    await items.remove(record.id);
    await bridge.toast('Item removed');
    await refresh();
  };

  return (
    <main className="app">
      <header>
        <h1>{{APP_NAME}}</h1>
        <p className="meta">
          Hi {user?.name ?? 'there'} — theme: {theme}, locale: {locale}
        </p>
        <nav className="tabs" aria-label="App sections">
          <button type="button" className={tab === 'items' ? 'active' : ''} onClick={() => setTab('items')}>
            Items
          </button>
          <button type="button" className={tab === 'people' ? 'active' : ''} onClick={() => setTab('people')}>
            People
          </button>
        </nav>
      </header>

      {tab === 'items' ? (
        <>
          <form onSubmit={(event) => void addItem(event)} className="add-form">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Add an item…"
              aria-label="New item title"
            />
            <button type="submit">Add</button>
          </form>

          <ItemsList
            loading={loading}
            records={records}
            onToggle={(record) => void toggleItem(record)}
            onRemove={(record) => void removeItem(record)}
          />
        </>
      ) : (
        <section>
          <p className="meta">
            Example WeldSuite App API call: <code>api.people.list()</code> against <code>/v1/people</code>.
          </p>
          <PeopleList loading={peopleLoading} error={peopleError} people={people} />
        </section>
      )}
    </main>
  );
}
