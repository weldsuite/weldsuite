import {
  formatDate,
  formatMoney,
  getPickListStatusColor,
  getShipmentStatusColor,
  getReturnStatusColor,
  getCycleCountStatusColor,
} from '../wms-helpers';

describe('wms-helpers', () => {
  describe('formatDate', () => {
    it('should format ISO date string', () => {
      const date = '2024-01-15T10:30:00Z';
      const result = formatDate(date);
      expect(result).toMatch(/Jan|1/); // Contains month or day
    });

    it('should handle null/undefined', () => {
      expect(formatDate(null as any)).toBe('N/A');
      expect(formatDate(undefined as any)).toBe('N/A');
    });
  });

  describe('formatMoney', () => {
    it('should format USD currency', () => {
      const result = formatMoney(1234.56, 'USD');
      expect(result).toContain('1,234.56');
      expect(result).toContain('$');
    });

    it('should format EUR currency', () => {
      const result = formatMoney(1234.56, 'EUR');
      expect(result).toContain('1,234.56');
      expect(result).toContain('€');
    });

    it('should handle zero', () => {
      const result = formatMoney(0, 'USD');
      expect(result).toContain('0');
    });

    it('should handle negative amounts', () => {
      const result = formatMoney(-100, 'USD');
      expect(result).toContain('-');
      expect(result).toContain('100');
    });
  });

  describe('getPickListStatusColor', () => {
    it('should return correct color for pending', () => {
      expect(getPickListStatusColor('pending')).toBe('#FFA500'); // Orange
    });

    it('should return correct color for in_progress', () => {
      expect(getPickListStatusColor('in_progress')).toBe('#9C27B0'); // Purple
    });

    it('should return correct color for completed', () => {
      expect(getPickListStatusColor('completed')).toBe('#4CAF50'); // Green
    });

    it('should return correct color for cancelled', () => {
      expect(getPickListStatusColor('cancelled')).toBe('#757575'); // Gray
    });

    it('should return default color for unknown status', () => {
      expect(getPickListStatusColor('unknown' as any)).toBe('#757575'); // Gray
    });
  });

  describe('getShipmentStatusColor', () => {
    it('should return correct color for pending', () => {
      expect(getShipmentStatusColor('pending')).toBe('#FFA500'); // Orange
    });

    it('should return correct color for delivered', () => {
      expect(getShipmentStatusColor('delivered')).toBe('#4CAF50'); // Green
    });

    it('should return correct color for cancelled', () => {
      expect(getShipmentStatusColor('cancelled')).toBe('#F44336'); // Red
    });
  });

  describe('getReturnStatusColor', () => {
    it('should return correct color for requested', () => {
      expect(getReturnStatusColor('requested')).toBe('#FFA500'); // Orange
    });

    it('should return correct color for approved', () => {
      expect(getReturnStatusColor('approved')).toBe('#2196F3'); // Blue
    });

    it('should return correct color for completed', () => {
      expect(getReturnStatusColor('completed')).toBe('#4CAF50'); // Green
    });

    it('should return correct color for cancelled', () => {
      expect(getReturnStatusColor('cancelled')).toBe('#F44336'); // Red
    });
  });

  describe('getCycleCountStatusColor', () => {
    it('should return correct color for pending', () => {
      expect(getCycleCountStatusColor('pending')).toBe('#FFA500'); // Orange
    });

    it('should return correct color for in_progress', () => {
      expect(getCycleCountStatusColor('in_progress')).toBe('#2196F3'); // Blue
    });

    it('should return correct color for completed', () => {
      expect(getCycleCountStatusColor('completed')).toBe('#4CAF50'); // Green
    });
  });
});
