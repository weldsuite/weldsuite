/**
 * Weld SDK - Logger Utility
 * Centralized logging with configurable levels and formatting
 */

import type { LogConfig } from '../types/config';

/**
 * Log levels
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

/**
 * Logger class
 */
export class Logger {
  private config: LogConfig;
  private level: LogLevel;

  constructor(config: LogConfig) {
    this.config = {
      enabled: true,
      level: 'warn',
      prefix: '[Weld]',
      includeTimestamp: true,
      ...config,
    };

    this.level = this.getLevelFromString(this.config.level!);
  }

  /**
   * Convert string level to LogLevel enum
   */
  private getLevelFromString(level: string): LogLevel {
    switch (level.toLowerCase()) {
      case 'debug':
        return LogLevel.DEBUG;
      case 'info':
        return LogLevel.INFO;
      case 'warn':
        return LogLevel.WARN;
      case 'error':
        return LogLevel.ERROR;
      default:
        return LogLevel.WARN;
    }
  }

  /**
   * Check if logging is enabled for level
   */
  private shouldLog(level: LogLevel): boolean {
    return (this.config.enabled ?? true) && level >= this.level;
  }

  /**
   * Format log message
   */
  private format(level: string, message: string, _data?: any): string[] {
    const parts: string[] = [];

    if (this.config.prefix) {
      parts.push(this.config.prefix);
    }

    if (this.config.includeTimestamp) {
      const timestamp = new Date().toISOString();
      parts.push(`[${timestamp}]`);
    }

    parts.push(`[${level.toUpperCase()}]`);
    parts.push(message);

    return parts;
  }

  /**
   * Log debug message
   */
  public debug(message: string, data?: any): void {
    if (!this.shouldLog(LogLevel.DEBUG)) return;

    const formatted = this.format('debug', message, data);
    if (data !== undefined) {
      console.debug(...formatted, data);
    } else {
      console.debug(...formatted);
    }
  }

  /**
   * Log info message
   */
  public info(message: string, data?: any): void {
    if (!this.shouldLog(LogLevel.INFO)) return;

    const formatted = this.format('info', message, data);
    if (data !== undefined) {
      console.info(...formatted, data);
    } else {
      console.info(...formatted);
    }
  }

  /**
   * Log warning message
   */
  public warn(message: string, data?: any): void {
    if (!this.shouldLog(LogLevel.WARN)) return;

    const formatted = this.format('warn', message, data);
    if (data !== undefined) {
      console.warn(...formatted, data);
    } else {
      console.warn(...formatted);
    }
  }

  /**
   * Log error message
   */
  public error(message: string, error?: Error | any): void {
    if (!this.shouldLog(LogLevel.ERROR)) return;

    const formatted = this.format('error', message);
    if (error !== undefined) {
      if (error instanceof Error) {
        console.error(...formatted, error.message, error.stack);
      } else {
        console.error(...formatted, error);
      }
    } else {
      console.error(...formatted);
    }
  }

  /**
   * Create child logger with prefix
   */
  public child(prefix: string): Logger {
    return new Logger({
      ...this.config,
      prefix: `${this.config.prefix} ${prefix}`,
    });
  }

  /**
   * Update log level at runtime
   */
  public setLevel(level: 'debug' | 'info' | 'warn' | 'error'): void {
    this.config.level = level;
    this.level = this.getLevelFromString(level);
  }

  /**
   * Enable/disable logging
   */
  public setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }
}

/**
 * Default logger instance
 */
export const defaultLogger = new Logger({
  enabled: true,
  level: 'warn',
  prefix: '[Weld]',
  includeTimestamp: true,
});
