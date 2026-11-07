import { describe, expect, it } from 'vitest';
import { createSlaSchema } from '@weldsuite/core-api-client/schemas/slas';
import type { DeskSlaPolicy } from '@/hooks/queries/use-desk-sla-queries';
import { createSlaFormSchema, newPolicyValues, policyToValues, valuesToPayload } from './sla-form';

const messages = {
  nameRequired: 'name',
  nameTooLong: 'long',
  priorityInvalid: 'order',
  timeInvalid: 'time',
  conditionValueRequired: 'value',
  noTargets: 'targets',
  timeTooLong: 'too long',
  timezoneRequired: 'tz',
  noOpenDay: 'open',
  closeBeforeOpen: 'close',
  holidayDateRequired: 'date',
};
const schema = createSlaFormSchema(messages);

const stored: DeskSlaPolicy = {
  id: 'sla_1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  name: 'Gold',
  description: null,
  isActive: true,
  isDefault: false,
  priority: 4,
  conditions: [{ field: 'team', operator: 'equals', value: 'dept_1' }],
  firstResponseTime: [
    { priority: 'medium', time: 90, notifyAt: [50] },
    { priority: 'critical', time: 5 },
  ],
  updateTime: [],
  resolutionTime: [{ priority: 'high', time: 480 }],
  reminders: [
    { type: 'before_breach', time: 20, recipients: ['manager'] },
    { type: 'after_breach', time: 60, recipients: ['manager'] },
  ],
  operationalHours: 'business',
  businessHours: null,
};

describe('SLA policy form', () => {
  it('needs a name and at least one target', () => {
    const result = schema.safeParse(newPolicyValues(0));
    expect(result.success).toBe(false);
    const messagesSeen = result.success ? [] : result.error.issues.map((i) => i.message);
    expect(messagesSeen).toEqual(expect.arrayContaining(['name', 'targets']));
  });

  it('reads stored minutes as hours and minutes, and the engine field aliases as canonical fields', () => {
    const values = policyToValues(stored);
    expect(values.targets.firstResponseTime.medium).toEqual({ hours: '1', minutes: '30' });
    expect(values.targets.resolutionTime.high).toEqual({ hours: '8', minutes: '' });
    expect(values.warnBefore).toEqual({ hours: '', minutes: '20' });
    expect(values.conditions).toEqual([{ field: 'departmentId', operator: 'equals', value: 'dept_1' }]);
  });

  it('writes a payload the API accepts and keeps what the form does not show', () => {
    const values = policyToValues(stored);
    values.targets.firstResponseTime.medium = { hours: '2', minutes: '15' };
    const payload = valuesToPayload(values, stored);

    expect(createSlaSchema.safeParse(payload).success).toBe(true);
    expect(payload.priority).toBe(4);
    expect(payload.firstResponseTime).toEqual([
      { priority: 'medium', time: 135, notifyAt: [50] },
      { priority: 'critical', time: 5 },
    ]);
    expect(payload.reminders).toEqual([
      { type: 'before_breach', time: 20, recipients: ['manager'] },
      { type: 'after_breach', time: 60, recipients: ['manager'] },
    ]);
    expect(payload.businessHours).toBeNull();
  });

  it('sends the policy calendar only for custom hours, and no conditions for the default', () => {
    const values = policyToValues(stored);
    values.operationalHours = 'custom';
    values.isDefault = true;
    const payload = valuesToPayload(values, stored);
    expect(payload.conditions).toEqual([]);
    expect(payload.businessHours?.monday).toEqual({ isOpen: true, openTime: '09:00', closeTime: '17:00' });
    expect(payload.businessHours?.sunday).toEqual({ isOpen: false });
    expect(createSlaSchema.safeParse(payload).success).toBe(true);
  });

  it('treats a business policy that carries its own hours as custom hours', () => {
    const own = { ...stored, businessHours: { timezone: 'UTC', monday: { isOpen: true, openTime: '08:00', closeTime: '12:00' } } };
    const values = policyToValues(own);
    expect(values.operationalHours).toBe('custom');
    expect(values.days.monday).toEqual({ isOpen: true, openTime: '08:00', closeTime: '12:00' });
    expect(values.days.tuesday.isOpen).toBe(false);
  });

  it('refuses custom hours with no open day or a closing time before the opening time', () => {
    const values = policyToValues(stored);
    values.operationalHours = 'custom';
    values.days.monday = { isOpen: true, openTime: '17:00', closeTime: '09:00' };
    expect(schema.safeParse(values).success).toBe(false);
    for (const day of Object.keys(values.days) as (keyof typeof values.days)[]) values.days[day].isOpen = false;
    const result = schema.safeParse(values);
    expect(result.success ? [] : result.error.issues.map((i) => i.message)).toContain('open');
  });
});
