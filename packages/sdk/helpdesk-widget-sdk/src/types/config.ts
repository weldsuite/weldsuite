/**
 * Weld SDK - Configuration Types
 * Type definitions for SDK initialization and configuration
 */

/**
 * Event types for widget events
 */
export type WidgetEventType = 'ready' | 'open' | 'close' | 'error' | 'message' | 'minimize' | 'maximize' | 'destroy';

/**
 * Widget event structure
 */
export interface WidgetEvent {
  type: WidgetEventType;
  data?: any;
  timestamp: number;
}

/**
 * Event handler function type
 */
export type WidgetEventHandler = (event?: WidgetEvent | any) => void;

/**
 * Position configuration
 */
export interface PositionConfig {
  bottom?: string;
  right?: string;
  left?: string;
  top?: string;
}

/**
 * Iframe configuration
 */
export interface IframeConfig {
  launcher: {
    url: string;
    name: string;
    position: PositionConfig;
    size: string;
  };
  widget: {
    url: string;
    name: string;
    position: PositionConfig;
    width: string;
    height: string;
  };
  backdrop?: {
    enabled: boolean;
    closeOnClick: boolean;
  };
}

/**
 * API configuration
 */
export interface ApiConfig {
  baseUrl: string;
  widgetId: string;
  endpoints?: {
    messages?: string;
    users?: string;
    conversations?: string;
    upload?: string;
  };
  timeout?: number;
  retries?: number;
}

/**
 * Authentication configuration
 */
export interface AuthConfig {
  enabled?: boolean;
  mode?: 'anonymous' | 'identified';
  userId?: string;
  email?: string;
  name?: string;
  avatar?: string;
  metadata?: Record<string, any>;
  token?: string;
}

/**
 * Locale configuration
 */
export interface LocaleConfig {
  locale?: string;
  translations?: Record<string, Record<string, string>>;
  dateFormat?: string;
  timeFormat?: string;
  timezone?: string;
}

/**
 * Logging configuration
 */
export interface LogConfig {
  enabled?: boolean;
  level?: 'debug' | 'info' | 'warn' | 'error';
  prefix?: string;
  includeTimestamp?: boolean;
}

/**
 * Performance configuration
 */
export interface PerformanceConfig {
  lazyLoad?: boolean;
  preload?: boolean;
  caching?: boolean;
  prefetch?: boolean;
}

/**
 * Security configuration
 */
export interface SecurityConfig {
  allowedOrigins?: string[];
  validateMessages?: boolean;
  sanitizeInput?: boolean;
  contentSecurityPolicy?: string;
}

/**
 * Main SDK configuration
 */
export interface WeldConfig {
  // Required
  widgetId: string;

  // Optional
  testMode?: boolean;
  api?: Partial<ApiConfig>;
  iframes?: Partial<IframeConfig>;
  position?: {
    launcher?: PositionConfig;
    widget?: PositionConfig;
  };
  auth?: AuthConfig;
  locale?: LocaleConfig;
  logging?: LogConfig;
  performance?: PerformanceConfig;
  security?: SecurityConfig;

  // Callbacks
  onReady?: () => void;
  onError?: (error: Error) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onMessage?: (message: any) => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
  onDestroy?: () => void;
}

/**
 * Runtime configuration (resolved from WeldConfig)
 */
export interface ResolvedConfig {
  widgetId: string;
  testMode?: boolean;
  api: ApiConfig;
  iframes: IframeConfig;
  auth: AuthConfig;
  locale: LocaleConfig;
  logging: LogConfig;
  performance: PerformanceConfig;
  security: SecurityConfig;
  // Callbacks (passed through from WeldConfig)
  onReady?: () => void;
  onError?: (error: Error) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onMessage?: (message: any) => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
  onDestroy?: () => void;
}

/**
 * Device detection
 */
export type DeviceType = 'mobile' | 'tablet' | 'desktop';

export interface DeviceInfo {
  type: DeviceType;
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  isTouchDevice: boolean;
  screenWidth: number;
  screenHeight: number;
  orientation: 'portrait' | 'landscape';
  userAgent: string;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Omit<ResolvedConfig, 'widgetId'> = {
  api: {
    baseUrl: 'https://widget.weldsuite.org',
    widgetId: '',
    timeout: 30000,
    retries: 3,
  },
  iframes: {
    launcher: {
      url: '?mode=launcher',
      name: 'weld-launcher-frame',
      position: { bottom: '24px', right: '24px' },
      size: '60px',
    },
    widget: {
      url: '?mode=widget',
      name: 'weld-widget-frame',
      position: { bottom: '100px', right: '24px' },
      width: '400px',
      height: 'min(680px, calc(100vh - 120px))',
    },
    backdrop: {
      enabled: true,
      closeOnClick: true,
    },
  },
  auth: {
    enabled: true,
    mode: 'anonymous',
  },
  locale: {
    locale: 'en',
    dateFormat: 'MMM dd, yyyy',
    timeFormat: 'HH:mm',
  },
  logging: {
    enabled: true,
    level: 'warn',
    prefix: '[Weld]',
    includeTimestamp: true,
  },
  performance: {
    lazyLoad: true,
    preload: false,
    caching: true,
    prefetch: false,
  },
  security: {
    allowedOrigins: [],
    validateMessages: true,
    sanitizeInput: true,
  },
};

/**
 * Configuration validation
 */
export function validateConfig(config: Partial<WeldConfig>): boolean {
  if (!config.widgetId || typeof config.widgetId !== 'string') {
    throw new Error('WeldConfig: widgetId is required and must be a string');
  }

  return true;
}

/**
 * Merge configuration with defaults
 */
export function resolveConfig(config: WeldConfig): ResolvedConfig {
  validateConfig(config);

  return {
    widgetId: config.widgetId,
    testMode: config.testMode,
    api: {
      ...DEFAULT_CONFIG.api,
      widgetId: config.widgetId,
      ...config.api,
    },
    iframes: {
      launcher: {
        ...DEFAULT_CONFIG.iframes.launcher,
        ...config.iframes?.launcher,
        position: {
          ...DEFAULT_CONFIG.iframes.launcher.position,
          ...config.position?.launcher,
          ...config.iframes?.launcher?.position,
        },
      },
      widget: {
        ...DEFAULT_CONFIG.iframes.widget,
        ...config.iframes?.widget,
        position: {
          ...DEFAULT_CONFIG.iframes.widget.position,
          ...config.position?.widget,
          ...config.iframes?.widget?.position,
        },
      },
      backdrop: {
        ...DEFAULT_CONFIG.iframes.backdrop!,
        ...config.iframes?.backdrop,
      },
    },
    auth: {
      ...DEFAULT_CONFIG.auth,
      ...config.auth,
    },
    locale: {
      ...DEFAULT_CONFIG.locale,
      ...config.locale,
    },
    logging: {
      ...DEFAULT_CONFIG.logging,
      ...config.logging,
    },
    performance: {
      ...DEFAULT_CONFIG.performance,
      ...config.performance,
    },
    security: {
      ...DEFAULT_CONFIG.security,
      ...config.security,
    },
    // Pass through callbacks
    onReady: config.onReady,
    onError: config.onError,
    onOpen: config.onOpen,
    onClose: config.onClose,
    onMessage: config.onMessage,
    onMinimize: config.onMinimize,
    onMaximize: config.onMaximize,
    onDestroy: config.onDestroy,
  };
}
