import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useCollection, useWeldApp } from '@weldsuite/app-sdk/react';
import type { AppRecord } from '@weldsuite/app-sdk';

interface Item extends Record<string, unknown> {
  title: string;
  done: boolean;
}

export default function App() {
  const { theme, locale, user, bridge } = useWeldApp();
  const items = useCollection<Item>('items');

  const [records, setRecords] = useState<AppRecord<Item>[]>([]);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);

  // Follow the platform theme (styles.css switches on data-theme).
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

  const addItem = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      return;
    }
    await items.create({ title: trimmed, done: false });
    setTitle('');
    await bridge.toast('Item added', 'success');
    await refresh();
  };

  const toggleItem = async (record: AppRecord<Item>) => {
    // update() replaces the whole document — send every field.
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
      </header>

      <form onSubmit={(event) => void addItem(event)} className="add-form">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Add an item…"
          aria-label="New item title"
        />
        <button type="submit">Add</button>
      </form>

      {loading ? (
        <p className="status">Loading items…</p>
      ) : records.length === 0 ? (
        <p className="status">No items yet — add your first one above.</p>
      ) : (
        <ul className="items">
          {records.map((record) => (
            <li key={record.id} className={record.data.done ? 'done' : ''}>
              <label>
                <input
                  type="checkbox"
                  checked={record.data.done}
                  onChange={() => void toggleItem(record)}
                />
                <span>{record.data.title}</span>
              </label>
              <button type="button" onClick={() => void removeItem(record)} aria-label="Remove item">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
