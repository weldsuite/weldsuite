import { describe, expect, it } from 'vitest';
import { isSentToOdoo, purchaseOrderActions, remainingToReceive, statusTone } from './po-actions';

const base = {
  status: 'draft',
  totalQuantityReceived: 0,
  sentToOdoo: false,
  warehouseManagedInOdoo: false,
  purchasing: true,
  canUpdate: true,
  canDelete: true,
};

describe('purchaseOrderActions', () => {
  it('lets a draft be approved, edited, cancelled and sent to nowhere else', () => {
    const a = purchaseOrderActions(base);
    expect(a).toMatchObject({ approve: true, edit: true, editLines: true, cancel: true, delete: true });
    expect(a.markOrdered).toBe(false);
    expect(a.receive).toBe(false);
    expect(a.sendToOdoo).toBe(false);
  });

  it('walks approved -> ordered -> partial through mark ordered and receive', () => {
    expect(purchaseOrderActions({ ...base, status: 'approved' })).toMatchObject({
      approve: false,
      markOrdered: true,
      receive: true,
      editLines: false,
    });
    expect(purchaseOrderActions({ ...base, status: 'ordered' })).toMatchObject({ markOrdered: false, receive: true, cancel: true });
    expect(purchaseOrderActions({ ...base, status: 'partial', totalQuantityReceived: 3 })).toMatchObject({
      receive: true,
      cancel: false,
      close: true,
    });
  });

  it('closes a received order and nothing else', () => {
    const a = purchaseOrderActions({ ...base, status: 'received', totalQuantityReceived: 10 });
    expect(a).toMatchObject({ close: true, receive: false, cancel: false, approve: false });
  });

  it('offers no action on a cancelled or closed order but delete for a cancelled one', () => {
    const cancelled = purchaseOrderActions({ ...base, status: 'cancelled' });
    expect(cancelled).toMatchObject({ approve: false, receive: false, close: false, delete: true });
    const closed = purchaseOrderActions({ ...base, status: 'closed' });
    expect(closed).toMatchObject({ approve: false, receive: false, close: false, delete: false });
  });

  it('offers Send to Odoo only for an unsent order in an Odoo-managed warehouse', () => {
    expect(purchaseOrderActions({ ...base, warehouseManagedInOdoo: true }).sendToOdoo).toBe(true);
    expect(purchaseOrderActions({ ...base, warehouseManagedInOdoo: true, status: 'approved' }).sendToOdoo).toBe(true);
    expect(purchaseOrderActions({ ...base, warehouseManagedInOdoo: true, status: 'ordered' }).sendToOdoo).toBe(false);
    expect(purchaseOrderActions({ ...base, warehouseManagedInOdoo: false }).sendToOdoo).toBe(false);
  });

  it('offers nothing on an order that was sent to Odoo', () => {
    const a = purchaseOrderActions({ ...base, sentToOdoo: true, warehouseManagedInOdoo: true });
    expect(Object.values(a).filter(Boolean)).toEqual([true]); // only the receipts tab
    expect(a.receipts).toBe(true);
  });

  it('hides write actions without the update permission', () => {
    const a = purchaseOrderActions({ ...base, canUpdate: false, canDelete: false });
    expect(a).toMatchObject({ edit: false, editLines: false, approve: false, cancel: false, delete: false });
  });

  it('on Global offers the CRUD and a status chooser, and none of the Rust-only actions', () => {
    const a = purchaseOrderActions({ ...base, purchasing: false, status: 'ordered' });
    expect(a).toMatchObject({ edit: true, editLines: true, chooseStatus: true, delete: true });
    expect(a).toMatchObject({
      approve: false,
      markOrdered: false,
      receive: false,
      cancel: false,
      close: false,
      sendToOdoo: false,
      receipts: false,
    });
  });
});

describe('isSentToOdoo', () => {
  it('reads metadata.odoo', () => {
    expect(isSentToOdoo({ odoo: { id: 7, name: 'P00007' } })).toBe(true);
    expect(isSentToOdoo({})).toBe(false);
    expect(isSentToOdoo(null)).toBe(false);
  });
});

describe('remainingToReceive', () => {
  it('is ordered less received and rejected, never below zero', () => {
    expect(remainingToReceive({ quantityOrdered: 10, quantityReceived: 4, quantityRejected: 1 })).toBe(5);
    expect(remainingToReceive({ quantityOrdered: 10, quantityReceived: null, quantityRejected: null })).toBe(10);
    expect(remainingToReceive({ quantityOrdered: 2, quantityReceived: 3 })).toBe(0);
  });
});

describe('statusTone', () => {
  it('maps statuses to tones', () => {
    expect(statusTone('draft')).toBe('neutral');
    expect(statusTone('partial')).toBe('warning');
    expect(statusTone('received')).toBe('success');
    expect(statusTone('cancelled')).toBe('danger');
  });
});
