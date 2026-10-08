import { Hono } from 'hono';
import { isNull } from 'drizzle-orm';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, success } from '../../../lib/response';
import { WRITE_METHODS, rejectWrites } from '../accounting/read-only-route';

const table = schema.settings;
const app = new Hono<HonoEnv>();

/**
 * Singleton workspace accounting settings (`settings` table), read-only.
 *
 * books-api creates the row, when the first accounting entity is set up or
 * WeldBooks first reads its settings. This route never creates it: a read must
 * not write, and a row created here would pre-empt whatever books-api seeds.
 */
app.get('/', requireScope('accounting_settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const [row] = await db.select().from(table).where(isNull(table.deletedAt)).limit(1);
  if (!row) return error.notFound(c, 'Accounting settings');
  return success(c, row);
});

app.on([...WRITE_METHODS], '/*', rejectWrites('accounting settings'));

export default app;
