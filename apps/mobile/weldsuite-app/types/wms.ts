/**
 * WMS (Warehouse Management System) TypeScript Type Definitions
 * Based on WeldSuite.Backend WMS API DTOs
 */

// ============================================================================
// COMMON TYPES
// ============================================================================

export interface MoneyDto {
  amount: number;
  currency: string;
  formatted: string;
}

export interface AddressDto {
  id?: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ============================================================================
// ENUMS
// ============================================================================

export type OrderStatus =
  | 'pending'
  | 'processing'
  | 'picking'
  | 'shipped'
  | 'delivered'
  | 'cancelled';

export type OrderPriority =
  | 'normal'
  | 'high'
  | 'urgent';

export type FulfillmentStatus =
  | 'unfulfilled'
  | 'allocated'
  | 'picking'
  | 'picking-complete'
  | 'packed'
  | 'shipped'
  | 'fulfilled'
  | 'cancelled';

export type PickListStatus =
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'paused'
  | 'completed'
  | 'cancelled';

export type PickListItemStatus =
  | 'pending'
  | 'completed'
  | 'partial'
  | 'skipped';

export type ShipmentStatus =
  | 'pending'
  | 'labeled'
  | 'label_generated'
  | 'picked_up'
  | 'in_transit'
  | 'shipped'
  | 'delivered'
  | 'cancelled';

export type WarehouseType =
  | 'distribution'
  | 'fulfillment'
  | 'storage'
  | 'cross-dock';

export type WarehouseStatus =
  | 'active'
  | 'inactive'
  | 'maintenance';

export type LocationType =
  | 'aisle'
  | 'rack'
  | 'bin'
  | 'shelf'
  | 'stage'
  | 'reserve';

export type LocationStatus =
  | 'available'
  | 'occupied'
  | 'reserved'
  | 'blocked';

export type InventoryStatus =
  | 'active'
  | 'inactive';

export type MovementType =
  | 'inbound'
  | 'outbound'
  | 'transfer'
  | 'adjustment';

export type AdjustmentType =
  | 'manual'
  | 'system'
  | 'cycle_count';

export type AdjustmentReason =
  | 'stock_take'
  | 'damage'
  | 'theft'
  | 'expiry'
  | 'quality_issue';

export type PurchaseOrderStatus =
  | 'draft'
  | 'pending'
  | 'approved'
  | 'ordered'
  | 'partially_received'
  | 'received'
  | 'cancelled';

export type ReturnStatus =
  | 'pending'
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'received'
  | 'inspecting'
  | 'processed'
  | 'restocking'
  | 'shipped'
  | 'completed'
  | 'cancelled';

export type ReturnType =
  | 'return'
  | 'exchange'
  | 'repair';

export type ReturnReason =
  | 'defective'
  | 'wrong_item'
  | 'not_as_described'
  | 'change_of_mind'
  | 'damaged'
  | 'other';

export type ReturnResolution =
  | 'refund'
  | 'exchange'
  | 'store_credit'
  | 'repair';

export type ItemCondition =
  | 'new'
  | 'like_new'
  | 'good'
  | 'fair'
  | 'poor';

export type CycleCountStatus =
  | 'pending'
  | 'in_progress'
  | 'completed';

export type CycleCountType =
  | 'blind'
  | 'controlled'
  | 'sample';

export type CycleCountMethod =
  | 'blind'
  | 'cycle_count';

export type PackingStatus =
  | 'pending'
  | 'in_progress'
  | 'completed';

export type PutawayStatus =
  | 'pending'
  | 'in_progress'
  | 'completed';

// ============================================================================
// WAREHOUSE MANAGEMENT
// ============================================================================

export interface WarehouseDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  code: string;
  description?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  phone?: string;
  email?: string;
  manager?: string;
  timeZone?: string;
  type: WarehouseType;
  status: WarehouseStatus;
  isActive: boolean;
  isDefault: boolean;
  totalSpace?: number;
  usedSpace?: number;
  spaceUnit?: string;
  maxPallets?: number;
  currentPallets?: number;
  services?: string;
  capabilities?: string;
  parentWarehouseId?: string;
  lastInventoryCount?: string;
  metadata?: string;
}

export interface WarehouseStatsDto {
  totalProducts: number;
  totalQuantity: number;
  lowStockItems: number;
  activeOrders: number;
  spaceUtilization: number;
}

export interface WarehouseLocationDto {
  zoneId?: string;
  locationCode: string;
  itemCount: number;
  totalQuantity: number;
}

export interface LocationDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  code: string;
  name: string;
  warehouseId: string;
  warehouseName: string;
  zone?: string;
  type: LocationType;
  capacity?: number;
  currentOccupancy?: number;
  row?: string;
  column?: string;
  level?: string;
  status: LocationStatus;
  isActive: boolean;
  length?: number;
  width?: number;
  height?: number;
  dimensionUnit?: string;
  maxWeight?: number;
  weightUnit?: string;
  barcode?: string;
  description?: string;
  notes?: string;
}

export interface LocationStatsDto {
  total: number;
  available: number;
  occupied: number;
  reserved: number;
  blocked: number;
  activeLocations: number;
  inactiveLocations: number;
  emptyLocations: number;
  totalCapacity: number;
  totalOccupancy: number;
  utilizationPercent: number;
}

// ============================================================================
// INVENTORY MANAGEMENT
// ============================================================================

export interface InventoryDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  productId: string;
  productSku: string;
  productName: string;
  barcode?: string;
  warehouseId: string;
  warehouseName: string;
  zoneId?: string;
  zoneName?: string;
  locationId?: string;
  locationCode?: string;
  binNumber?: string;
  quantityOnHand: number;
  quantityAvailable: number;
  quantityAllocated: number;
  quantityReserved: number;
  quantityInTransit: number;
  quantityDamaged: number;
  quantityQuarantined: number;
  batchNumber?: string;
  serialNumber?: string;
  lotNumber?: string;
  expiryDate?: string;
  manufacturingDate?: string;
  unitCost: number;
  totalValue: MoneyDto;
  lastCostUpdate?: string;
  minStockLevel?: number;
  maxStockLevel?: number;
  reorderPoint?: number;
  reorderQuantity?: number;
  lastReceived?: string;
  lastCounted?: string;
  lastMoved?: string;
  lastPicked?: string;
  status: InventoryStatus;
  isActive: boolean;
  requiresCycleCount: boolean;
  isHazmat: boolean;
  requiresColdStorage: boolean;
  isHighValue: boolean;
}

export interface InventoryAdjustmentDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  adjustmentNumber: string;
  referenceNumber?: string;
  type: AdjustmentType;
  reason: AdjustmentReason;
  warehouseId: string;
  warehouseName: string;
  items: AdjustmentItemDto[];
  totalValue: MoneyDto;
  status: string;
  requiresApproval: boolean;
  approvedBy?: string;
  approvedAt?: string;
  performedBy?: string;
  performedAt?: string;
  notes?: string;
}

export interface AdjustmentItemDto {
  productId: string;
  productSku: string;
  productName: string;
  locationId?: string;
  locationCode?: string;
  quantityBefore: number;
  quantityAdjusted: number;
  quantityAfter: number;
  reason?: string;
  unitCost: number;
}

export interface InventoryTransferDto {
  id: string;
  createdAt: string;
  productId: string;
  productSku: string;
  productName: string;
  fromWarehouseId: string;
  fromWarehouseName: string;
  toWarehouseId: string;
  toWarehouseName: string;
  quantity: number;
  status: string;
  notes?: string;
}

export interface LowStockItemDto {
  productId: string;
  productSku: string;
  productName: string;
  warehouseId: string;
  warehouseName: string;
  quantityOnHand: number;
  quantityAvailable: number;
  reorderPoint: number;
  reorderQuantity: number;
}

export interface InventoryMovementDto {
  id: string;
  createdAt: string;
  productId: string;
  productSku: string;
  productName: string;
  warehouseId: string;
  warehouseName: string;
  movementType: MovementType;
  quantity: number;
  quantityBefore: number;
  quantityAfter: number;
  reference?: string;
  reason?: string;
  notes?: string;
}

// ============================================================================
// ORDERS
// ============================================================================

export interface WmsOrderDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  orderNumber: string;
  externalOrderId?: string;
  customerId: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  warehouseId: string;
  warehouseName: string;
  assignedPickerId?: string;
  pickerName?: string;
  status: OrderStatus;
  priority: OrderPriority;
  fulfillmentStatus: FulfillmentStatus;
  orderDate: string;
  requiredDate?: string;
  shippedDate?: string;
  deliveredDate?: string;
  items: WmsOrderItemDto[];
  shippingAddress?: AddressDto;
  billingAddress?: AddressDto;
  shippingMethod?: string;
  trackingNumber?: string;
  shippingCost: MoneyDto;
  subtotal: MoneyDto;
  tax: MoneyDto;
  discount: MoneyDto;
  total: MoneyDto;
  weight?: number;
  weightUnit?: string;
  packagesCount?: number;
  pickListId?: string;
  pickStartTime?: string;
  pickEndTime?: string;
  packStartTime?: string;
  packEndTime?: string;
  notes?: string;
  customerNotes?: string;
  isGift: boolean;
  requiresSignature: boolean;
}

export interface WmsOrderItemDto {
  id: string;
  productId: string;
  productSku: string;
  productName: string;
  quantity: number;
  allocatedQuantity: number;
  pickedQuantity: number;
  packedQuantity: number;
  shippedQuantity: number;
  unitPrice: MoneyDto;
  totalPrice: MoneyDto;
  locationCode?: string;
  binNumber?: string;
}

export interface OrderStatsDto {
  totalOrders: number;
  pendingOrders: number;
  processingOrders: number;
  shippedOrders: number;
  deliveredOrders: number;
  cancelledOrders: number;
  totalRevenue: MoneyDto;
  averageOrderValue: MoneyDto;
}

// ============================================================================
// PICK LISTS
// ============================================================================

export interface PickListDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  pickListNumber: string;
  batchId?: string;
  warehouseId: string;
  warehouseName: string;
  pickerId?: string;
  pickerName?: string;
  supervisorId?: string;
  orderIds: string[];
  orderCount: number;
  status: PickListStatus;
  priority: OrderPriority;
  pickType?: string;
  pickMethod?: string;
  routeOptimized: boolean;
  scheduledDate?: string;
  dueDate?: string;
  startTime?: string;
  endTime?: string;
  estimatedDuration?: number;
  actualDuration?: number;
  totalItems: number;
  pickedItems: number;
  items: PickListItemDto[];
  notes?: string;
}

export interface PickListItemDto {
  id: string;
  pickListId: string;
  productId: string;
  productSku: string;
  productName: string;
  requestedQuantity: number;
  pickedQuantity: number;
  location?: string;
  bin?: string;
  status: PickListItemStatus;
  notes?: string;
  pickedAt?: string;
  pickedByUserId?: string;
}

// ============================================================================
// SHIPMENTS
// ============================================================================

export interface ShipmentDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  shipmentNumber: string;
  trackingNumber?: string;
  trackingUrl?: string;
  orderIds: string[];
  orderNumber?: string;
  warehouseId: string;
  warehouseName: string;
  carrierId?: string;
  carrierName?: string;
  serviceType?: string;
  serviceName?: string;
  status: ShipmentStatus;
  shipmentDate: string;
  shipDate?: string;
  estimatedDeliveryDate?: string;
  estimatedDelivery?: string;
  actualDeliveryDate?: string;
  actualDelivery?: string;
  shippingAddress?: AddressDto;
  shipFrom?: AddressDto;
  shipTo?: AddressDto;
  returnAddress?: AddressDto;
  packages?: PackageDto[];
  totalPackages?: number;
  weight?: {
    value: number;
    unit: string;
  };
  dimensions?: {
    length: number;
    width: number;
    height: number;
    unit: string;
  };
  totalWeight?: number;
  weightUnit?: string;
  shippingCost?: MoneyDto;
  insuranceValue?: MoneyDto;
  declaredValue?: MoneyDto;
  trackingEvents?: TrackingEventDto[];
  labelUrl?: string;
  invoiceUrl?: string;
  packingSlipUrl?: string;
  customsFormUrl?: string;
  signatureRequired?: boolean;
  saturdayDelivery?: boolean;
  holdAtLocation?: boolean;
  isInternational?: boolean;
  deliveryInstructions?: string;
  notes?: string;
}

export interface PackageDto {
  id: string;
  packageNumber: string;
  trackingNumber?: string;
  items: PackageItemDto[];
  weight: number;
  weightUnit: string;
  length?: number;
  width?: number;
  height?: number;
  dimensionUnit?: string;
  packageType?: string;
  packagingMaterial?: string;
  labelUrl?: string;
  packingSlipUrl?: string;
}

export interface PackageItemDto {
  orderItemId: string;
  productId: string;
  productSku: string;
  productName: string;
  quantity: number;
  serialNumbers?: string[];
  batchNumber?: string;
}

export interface TrackingEventDto {
  timestamp: string;
  status: string;
  description: string;
  location?: string;
  details?: string;
}

export interface ShippingRateDto {
  carrier: string;
  carrierName: string;
  serviceCode: string;
  serviceName: string;
  rate: MoneyDto;
  estimatedDays?: number;
  estimatedDelivery?: string;
  isGuaranteed: boolean;
}

export interface ShippingLabelDto {
  trackingNumber: string;
  labelUrl: string;
  labelData?: string;
  format: string;
  cost: MoneyDto;
  carrierLabelId?: string;
  createdAt: string;
}

export interface CarrierAvailabilityDto {
  carrier: string;
  carrierName: string;
  isEnabled: boolean;
  isConfigured: boolean;
  availableServices: CarrierServiceDto[];
}

export interface CarrierServiceDto {
  serviceCode: string;
  serviceName: string;
  description?: string;
  isInternational: boolean;
  isGuaranteed: boolean;
}

// ============================================================================
// PURCHASE ORDERS
// ============================================================================

export interface PurchaseOrderDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  purchaseOrderNumber: string;
  referenceNumber?: string;
  supplierId: string;
  supplierName: string;
  supplierCode?: string;
  supplierContact?: string;
  supplierEmail?: string;
  supplierPhone?: string;
  warehouseId: string;
  warehouseName: string;
  receivingLocationId?: string;
  status: PurchaseOrderStatus;
  orderDate: string;
  expectedDate?: string;
  receivedDate?: string;
  dueDate?: string;
  currency: string;
  subtotal: MoneyDto;
  tax: MoneyDto;
  shipping: MoneyDto;
  discount: MoneyDto;
  total: MoneyDto;
  paymentTerms?: string;
  paymentMethod?: string;
  paymentStatus?: string;
  receivingStatus?: string;
  receivedBy?: string;
  qualityCheckStatus?: string;
  invoiceNumber?: string;
  packingSlipNumber?: string;
  notes?: string;
  internalNotes?: string;
  items: PurchaseOrderItemDto[];
  terms?: string;
}

export interface PurchaseOrderItemDto {
  id: string;
  productId: string;
  productSku: string;
  productName: string;
  supplierSku?: string;
  barcode?: string;
  quantity: number;
  orderedQuantity?: number;
  receivedQuantity: number;
  acceptedQuantity?: number;
  rejectedQuantity?: number;
  backorderedQuantity?: number;
  unitCost?: MoneyDto;
  tax?: MoneyDto;
  discount?: MoneyDto;
  totalCost?: MoneyDto;
  receivedDate?: string;
  batchNumber?: string;
  serialNumbers?: string[];
  expiryDate?: string;
  manufacturingDate?: string;
  qualityCheckRequired?: boolean;
  qualityCheckStatus?: string;
  qualityCheckNotes?: string;
  destinationLocationId?: string;
  destinationLocationCode?: string;
  status?: string;
  notes?: string;
}

// ============================================================================
// RETURNS
// ============================================================================

export interface ReturnDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  returnNumber: string;
  rmaNumber?: string;
  orderId?: string;
  orderNumber?: string;
  customerId?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  warehouseId: string;
  warehouseName: string;
  receivingLocationId?: string;
  status: ReturnStatus;
  type?: ReturnType;
  reason?: string;
  reasonNotes?: string;
  requestedDate?: string;
  approvedDate?: string;
  receivedDate?: string;
  processedDate?: string;
  returnShippingMethod?: string;
  returnTrackingNumber?: string;
  returnShippingPaidBy?: string;
  resolution?: ReturnResolution;
  refundAmount?: MoneyDto;
  refundMethod?: string;
  refundProcessedDate?: string;
  replacementOrderId?: string;
  storeCreditAmount?: MoneyDto;
  inspectionRequired?: boolean;
  inspectionStatus?: string;
  inspectionNotes?: string;
  customerNotes?: string;
  notes?: string;
  internalNotes?: string;
  items: ReturnItemDto[];
}

export interface ReturnItemDto {
  id: string;
  productId: string;
  productSku: string;
  productName: string;
  orderItemId?: string;
  requestedQuantity: number;
  receivedQuantity: number;
  acceptedQuantity: number;
  rejectedQuantity: number;
  condition?: ItemCondition;
  conditionNotes?: string;
  reason?: string;
  reasonNotes?: string;
  resolution?: ReturnResolution;
  restockable: boolean;
  restockingFee?: MoneyDto;
  restockedLocationId?: string;
  requiresDisposal: boolean;
  disposalMethod?: string;
  notes?: string;
}

// ============================================================================
// CYCLE COUNTS
// ============================================================================

export interface CycleCountDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  cycleCountNumber: string;
  warehouseId: string;
  warehouseName: string;
  zoneIds?: string[];
  locationIds?: string[];
  type: CycleCountType;
  method: CycleCountMethod;
  status: CycleCountStatus;
  assignedTo?: string[];
  supervisorId?: string;
  scheduledDate?: string;
  startTime?: string;
  endTime?: string;
  dueDate?: string;
  items: CycleCountItemDto[];
  totalItems: number;
  countedItems: number;
  accuracy?: number;
  varianceValue?: number;
  discrepanciesFound: number;
  requiresApproval: boolean;
  approvedBy?: string;
  approvedAt?: string;
  notes?: string;
  instructions?: string;
}

export interface CycleCountItemDto {
  id: string;
  productId: string;
  productSku: string;
  productName: string;
  locationId?: string;
  locationCode?: string;
  expectedQuantity: number;
  systemQuantity?: number;
  countedQuantity?: number;
  variance?: number;
  batchNumber?: string;
  serialNumbers?: string[];
  status: string;
  countedAt?: string;
  countedBy?: string;
  requiresRecount?: boolean;
  recountQuantity?: number;
  recountBy?: string;
  recountAt?: string;
  adjustmentMade?: boolean;
  adjustmentQuantity?: number;
  adjustmentReason?: string;
  notes?: string;
}

// ============================================================================
// PACKING & PUTAWAY
// ============================================================================

export interface PackingTaskDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  orderId: string;
  orderNumber: string;
  warehouseId: string;
  warehouseName: string;
  status: PackingStatus;
  priority: OrderPriority;
  assignedToUserId?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PutawayDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  warehouseId: string;
  warehouseName: string;
  productId: string;
  productSku: string;
  productName: string;
  quantity: number;
  fromLocation?: string;
  toLocation?: string;
  status: PutawayStatus;
  priority: OrderPriority;
  completedAt?: string;
}

// ============================================================================
// PRODUCTS
// ============================================================================

export interface ProductDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  sku: string;
  barcode?: string;
  description?: string;
  category?: string;
  price: MoneyDto;
  cost: MoneyDto;
  weight?: number;
  weightUnit?: string;
  dimensions?: string;
  isActive: boolean;
}

export interface ProductStatsDto {
  totalProducts: number;
  activeProducts: number;
  totalInventoryItems: number;
}

export interface BulkImportResultDto {
  importedCount: number;
  updatedCount: number;
  errorCount: number;
  errors: string[];
}

// ============================================================================
// DASHBOARD
// ============================================================================

export interface DashboardOverviewDto {
  totalOrders: number;
  ordersToday: number;
  ordersYesterday: number;
  pendingOrders: number;
  processingOrders: number;
  completedOrdersToday: number;
  activePickLists: number;
  totalInventoryValue: MoneyDto;
  lowStockItemsCount: number;
  lowStockProducts: LowStockItemDto[];
  outOfStockProducts: number;
  totalProducts: number;
  warehouses: WarehouseSummaryDto[];
  recentOrders: OrderSummaryDto[];
  purchaseOrderStats?: PurchaseOrderStatsDto;
  supplierStats?: SupplierStatsDto;
}

export interface WarehouseSummaryDto {
  id: string;
  name: string;
  code: string;
  capacity?: number;
  currentStock?: number;
  reserved?: number;
  inventoryCount: number;
}

export interface OrderSummaryDto {
  id: string;
  orderNumber: string;
  customerName: string;
  status: OrderStatus;
  total: MoneyDto;
  createdAt: string;
}

export interface RecentMovementDto {
  id: string;
  createdAt: string;
  productName: string;
  productSku: string;
  warehouseName: string;
  movementType: MovementType;
  quantity: number;
  reason?: string;
}

export interface PurchaseOrderStatsDto {
  totalPOs: number;
  pendingPOs: number;
  approvedPOs: number;
}

export interface SupplierStatsDto {
  totalSuppliers: number;
  activeSuppliers: number;
}

// ============================================================================
// REQUEST TYPES
// ============================================================================

export interface CreateWmsOrderRequest {
  customerId: string;
  warehouseId: string;
  items: {
    productId: string;
    quantity: number;
    unitPrice: number;
  }[];
  shippingAddress: AddressDto;
  billingAddress?: AddressDto;
  priority?: OrderPriority;
  customerNotes?: string;
  shippingMethod?: string;
}

export interface UpdateOrderStatusRequest {
  status: OrderStatus;
  notes?: string;
}

export interface AllocateInventoryRequest {
  orderId: string;
  warehouseId: string;
}

export interface CreatePickListRequest {
  warehouseId: string;
  orderIds: string[];
  pickerId?: string;
  priority?: OrderPriority;
  scheduledDate?: string;
}

export interface AssignPickListRequest {
  pickerId: string;
}

export interface UpdatePickProgressRequest {
  itemId: string;
  pickedQuantity: number;
}

export interface PickItemRequest {
  quantity: number;
  locationCode?: string;
}

export interface SkipItemRequest {
  reason: string;
}

export interface CancelPickListRequest {
  reason: string;
}

export interface CreateInventoryAdjustmentRequest {
  warehouseId: string;
  type: AdjustmentType;
  reason: AdjustmentReason;
  items: {
    productId: string;
    locationId?: string;
    quantityAdjusted: number;
    reason?: string;
  }[];
  notes?: string;
}

export interface CreateInventoryTransferRequest {
  productId: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  quantity: number;
  notes?: string;
}

export interface CreateShipmentRequest {
  orderIds: string[];
  warehouseId: string;
  carrierId?: string;
  serviceType?: string;
  shipDate?: string;
}

export interface GetShippingRatesRequest {
  shipFrom: AddressDto;
  shipTo: AddressDto;
  packages: {
    weight: number;
    length?: number;
    width?: number;
    height?: number;
  }[];
}

export interface GenerateLabelRequest {
  shipmentId: string;
  format?: string;
}

export interface CreatePurchaseOrderRequest {
  supplierId: string;
  warehouseId: string;
  expectedDate?: string;
  items: {
    productId: string;
    quantity: number;
    unitCost: number;
  }[];
  notes?: string;
}

export interface ReceivePurchaseOrderRequest {
  items: {
    itemId: string;
    receivedQuantity: number;
    acceptedQuantity: number;
    rejectedQuantity?: number;
    batchNumber?: string;
    expiryDate?: string;
  }[];
}

export interface CreateReturnRequest {
  orderId: string;
  warehouseId: string;
  type: ReturnType;
  reason: ReturnReason;
  items: {
    orderItemId: string;
    quantity: number;
    reason?: string;
  }[];
  customerNotes?: string;
}

export interface ProcessReturnRequest {
  resolution: ReturnResolution;
  refundAmount?: number;
  items: {
    itemId: string;
    acceptedQuantity: number;
    condition: ItemCondition;
    restockable: boolean;
  }[];
}

export interface CreateCycleCountRequest {
  warehouseId: string;
  type: CycleCountType;
  zoneIds?: string[];
  locationIds?: string[];
  productIds?: string[];
  scheduledDate?: string;
  assignedTo?: string[];
  notes?: string;
}

export interface CountItemRequest {
  countedQuantity: number;
  notes?: string;
}

export interface CompleteCycleCountRequest {
  applyAdjustments: boolean;
  notes?: string;
}

// ============================================================================
// FILTER TYPES
// ============================================================================

export interface InventoryFilters {
  search?: string;
  warehouseId?: string;
  productId?: string;
  status?: InventoryStatus;
  lowStock?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface OrderFilters {
  search?: string;
  warehouseId?: string;
  status?: OrderStatus;
  fulfillmentStatus?: FulfillmentStatus;
  priority?: OrderPriority;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PickListFilters {
  warehouseId?: string;
  status?: PickListStatus;
  pickerId?: string;
  priority?: OrderPriority;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface ShipmentFilters {
  warehouseId?: string;
  status?: ShipmentStatus;
  orderId?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PurchaseOrderFilters {
  supplierId?: string;
  status?: PurchaseOrderStatus;
  warehouseId?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface ReturnFilters {
  warehouseId?: string;
  status?: ReturnStatus;
  customerId?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface CycleCountFilters {
  warehouseId?: string;
  status?: CycleCountStatus;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}
