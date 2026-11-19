import { describe, expect, it } from 'vitest';
import { buildExplanation, type ExplainInput, type ExplainTexts } from './explain';

const texts: ExplainTexts = {
  off: 'OFF',
  noData: 'NO DATA',
  minMax: 'Reorder at {reorderPoint}: minimum {min}, up to {max}.',
  statistical:
    "Reorder at {reorderPoint}: {leadTime} days' lead time at {perDay} a day is {leadDemand}, plus {safetyStock} safety stock for {service}% availability.",
  position: '{onHand} on hand, {allocated} reserved, {incoming} incoming: position {position}.',
  order: 'Order {quantity} to reach {orderUpTo}.',
  nothingToOrder: 'Nothing to order.',
};

const plan: ExplainInput = {
  method: 'seasonal',
  confidence: 'ok',
  reorderPoint: 140,
  orderUpTo: 260,
  safetyStock: 36,
  leadTimeDays: 20,
  avgDailyDemand: '5.2000',
  serviceLevel: '0.950',
  onHand: 90,
  allocated: 10,
  incoming: 0,
  inventoryPosition: 80,
  suggestedQty: 180,
};

describe('buildExplanation', () => {
  it('explains a statistical suggestion the way the plan words it', () => {
    const sentence = buildExplanation(plan, texts);
    expect(sentence).toContain(
      "Reorder at 140: 20 days' lead time at 5.2 a day is 104, plus 36 safety stock for 95% availability.",
    );
    expect(sentence).toContain('90 on hand, 10 reserved, 0 incoming: position 80.');
    expect(sentence).toContain('Order 180 to reach 260.');
  });

  it('keeps a fractional service level readable', () => {
    expect(buildExplanation({ ...plan, serviceLevel: '0.995' }, texts)).toContain('for 99.5% availability');
  });

  it('says nothing to order when the position is above the point', () => {
    const sentence = buildExplanation({ ...plan, suggestedQty: 0, inventoryPosition: 300 }, texts);
    expect(sentence.endsWith('Nothing to order.')).toBe(true);
  });

  it('explains a min/max rule by its limits', () => {
    const sentence = buildExplanation(
      { ...plan, method: 'min_max', reorderPoint: 20, orderUpTo: 50, suggestedQty: 40 },
      texts,
    );
    expect(sentence.startsWith('Reorder at 20: minimum 20, up to 50.')).toBe(true);
  });

  it('distinguishes a switched-off rule from missing history', () => {
    expect(buildExplanation({ ...plan, method: 'none', confidence: 'ok' }, texts)).toBe('OFF');
    expect(buildExplanation({ ...plan, method: 'none', confidence: 'none' }, texts)).toBe('NO DATA');
  });

  it('falls back to the no-data text without a reorder point', () => {
    expect(buildExplanation({ ...plan, reorderPoint: null }, texts)).toBe('NO DATA');
  });
});
