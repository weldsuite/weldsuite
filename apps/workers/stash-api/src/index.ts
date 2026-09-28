/**
 * WeldSuite stash-api — the WeldStash (WMS: warehouses, locations, zones,
 * inventory, pick lists, putaway, cycle counts, stock adjustments, boxes,
 * purchase orders, suppliers) module's API worker.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { boxesRoutes } from './routes/boxes';
import { cycleCountsRoutes } from './routes/cycle-counts';
import { inventoryRoutes } from './routes/inventory';
import { inventoryMovementsRoutes } from './routes/inventory-movements';
import { pickersRoutes } from './routes/pickers';
import { pickListsRoutes } from './routes/pick-lists';
import { purchaseOrdersRoutes } from './routes/purchase-orders';
import { putawayRoutes } from './routes/putaway';
import { stockAdjustmentsRoutes } from './routes/stock-adjustments';
import { warehouseLocationsRoutes } from './routes/warehouse-locations';
import { warehousesRoutes } from './routes/warehouses';
import { warehouseZonesRoutes } from './routes/warehouse-zones';
import { wmsActivityRoutes } from './routes/wms-activity';
import { wmsSuppliersRoutes } from './routes/wms-suppliers';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'stash-api' });

app.use('/api/*', ...apiAuth());

app.route('/api/boxes', boxesRoutes);
app.route('/api/cycle-counts', cycleCountsRoutes);
app.route('/api/inventory', inventoryRoutes);
app.route('/api/inventory-movements', inventoryMovementsRoutes);
app.route('/api/pick-lists', pickListsRoutes);
app.route('/api/pickers', pickersRoutes);
app.route('/api/purchase-orders', purchaseOrdersRoutes);
app.route('/api/putaway', putawayRoutes);
app.route('/api/warehouse-locations', warehouseLocationsRoutes);
app.route('/api/warehouses', warehousesRoutes);
app.route('/api/warehouse-zones', warehouseZonesRoutes);
app.route('/api/wms-suppliers', wmsSuppliersRoutes);
app.route('/api/wms-activity', wmsActivityRoutes);
app.route('/api/stock-adjustments', stockAdjustmentsRoutes);

export default {
  fetch: app.fetch,
};
