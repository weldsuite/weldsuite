/**
 * Weld SDK - Validation Utilities
 * Input validation and sanitization functions
 */

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate URL format
 */
export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate API key format
 */
export function isValidApiKey(apiKey: string): boolean {
  return typeof apiKey === 'string' && apiKey.length > 0 && apiKey.length <= 256;
}

/**
 * Validate workspace ID format
 */
export function isValidWorkspaceId(workspaceId: string): boolean {
  return typeof workspaceId === 'string' && workspaceId.length > 0 && workspaceId.length <= 128;
}

/**
 * Validate color format (hex, rgb, rgba)
 */
export function isValidColor(color: string): boolean {
  const hexRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
  const rgbRegex = /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/;
  const rgbaRegex = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(0|1|0?\.\d+)\s*\)$/;

  return hexRegex.test(color) || rgbRegex.test(color) || rgbaRegex.test(color);
}

/**
 * Validate message text
 */
export function isValidMessageText(text: string): boolean {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= 10000;
}

/**
 * Sanitize HTML to prevent XSS
 */
export function sanitizeHtml(html: string): string {
  const div = document.createElement('div');
  div.textContent = html;
  return div.innerHTML;
}

/**
 * Sanitize user input
 */
export function sanitizeInput(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }

  return input
    .trim()
    .replace(/[<>]/g, '') // Remove angle brackets
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+\s*=/gi, ''); // Remove event handlers
}

/**
 * Validate object has required properties
 */
export function hasRequiredProperties<T extends Record<string, any>>(
  obj: any,
  properties: (keyof T)[]
): obj is T {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }

  return properties.every((prop) => prop in obj);
}

/**
 * Validate string length
 */
export function isValidLength(
  str: string,
  options: { min?: number; max?: number }
): boolean {
  const length = str.length;

  if (options.min !== undefined && length < options.min) {
    return false;
  }

  if (options.max !== undefined && length > options.max) {
    return false;
  }

  return true;
}

/**
 * Validate number range
 */
export function isInRange(
  num: number,
  options: { min?: number; max?: number }
): boolean {
  if (options.min !== undefined && num < options.min) {
    return false;
  }

  if (options.max !== undefined && num > options.max) {
    return false;
  }

  return true;
}

/**
 * Validate array length
 */
export function isValidArrayLength<T>(
  arr: T[],
  options: { min?: number; max?: number }
): boolean {
  if (!Array.isArray(arr)) {
    return false;
  }

  return isInRange(arr.length, options);
}

/**
 * Deep clone object (safe for JSON-serializable objects)
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (obj instanceof Date) {
    return new Date(obj.getTime()) as any;
  }

  if (obj instanceof Array) {
    return obj.map((item) => deepClone(item)) as any;
  }

  if (obj instanceof Object) {
    const cloned: any = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        cloned[key] = deepClone(obj[key]);
      }
    }
    return cloned;
  }

  return obj;
}

/**
 * Check if value is a plain object
 */
export function isPlainObject(value: any): value is Record<string, any> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Merge objects deeply
 */
export function deepMerge<T extends Record<string, any>>(
  target: T,
  ...sources: Partial<T>[]
): T {
  if (!sources.length) return target;

  const source = sources.shift();
  if (!source) return target;

  if (isPlainObject(target) && isPlainObject(source)) {
    for (const key in source) {
      if (isPlainObject(source[key])) {
        if (!target[key]) {
          Object.assign(target, { [key]: {} });
        }
        deepMerge(target[key], source[key] as any);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }

  return deepMerge(target, ...sources);
}

/**
 * Validate file type
 */
export function isValidFileType(file: File, allowedTypes: string[]): boolean {
  return allowedTypes.some((type) => {
    if (type.endsWith('/*')) {
      const category = type.split('/')[0];
      return file.type.startsWith(category + '/');
    }
    return file.type === type;
  });
}

/**
 * Validate file size
 */
export function isValidFileSize(file: File, maxSizeBytes: number): boolean {
  return file.size <= maxSizeBytes;
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}
