export interface ThemeSettings {
  // Colors
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text: string;
    textSecondary: string;
    border: string;
    success: string;
    error: string;
    warning: string;
  };

  // Typography
  typography: {
    fontFamily: {
      heading: string;
      body: string;
    };
    fontScale: {
      base: number; // Base font size in pixels (default 16)
      scale: number; // Scale ratio (default 1.25 for major third)
    };
    fontWeights: {
      normal: number;
      medium: number;
      semibold: number;
      bold: number;
    };
    lineHeights: {
      tight: number;
      normal: number;
      relaxed: number;
    };
  };

  // Spacing
  spacing: {
    scale: number; // Base spacing unit in pixels (default 4)
  };

  // Border Radius
  borderRadius: {
    none: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
    full: number;
  };

  // Buttons
  buttons: {
    primary: {
      backgroundColor: string;
      textColor: string;
      borderRadius: string; // 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'full'
      paddingX: number;
      paddingY: number;
      fontSize: string;
      fontWeight: number;
      borderWidth: number;
      borderColor: string;
    };
    secondary: {
      backgroundColor: string;
      textColor: string;
      borderRadius: string;
      paddingX: number;
      paddingY: number;
      fontSize: string;
      fontWeight: number;
      borderWidth: number;
      borderColor: string;
    };
    outline: {
      backgroundColor: string;
      textColor: string;
      borderRadius: string;
      paddingX: number;
      paddingY: number;
      fontSize: string;
      fontWeight: number;
      borderWidth: number;
      borderColor: string;
    };
  };

  // Layout
  layout: {
    maxWidth: string; // 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full'
    contentMaxWidth: string; // For sections with full-width backgrounds
    gutter: number; // Horizontal padding
  };
}

export const defaultTheme: ThemeSettings = {
  colors: {
    primary: '#000000',
    secondary: '#6b7280',
    accent: '#3b82f6',
    background: '#ffffff',
    text: '#000000',
    textSecondary: '#6b7280',
    border: '#e5e7eb',
    success: '#10b981',
    error: '#ef4444',
    warning: '#f59e0b',
  },
  typography: {
    fontFamily: {
      heading: 'system-ui, -apple-system, sans-serif',
      body: 'system-ui, -apple-system, sans-serif',
    },
    fontScale: {
      base: 16,
      scale: 1.25,
    },
    fontWeights: {
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
    lineHeights: {
      tight: 1.25,
      normal: 1.5,
      relaxed: 1.75,
    },
  },
  spacing: {
    scale: 4,
  },
  borderRadius: {
    none: 0,
    sm: 4,
    md: 8,
    lg: 12,
    xl: 16,
    full: 9999,
  },
  buttons: {
    primary: {
      backgroundColor: '#000000',
      textColor: '#ffffff',
      borderRadius: 'md',
      paddingX: 24,
      paddingY: 12,
      fontSize: '1rem',
      fontWeight: 500,
      borderWidth: 0,
      borderColor: '#000000',
    },
    secondary: {
      backgroundColor: '#ffffff',
      textColor: '#000000',
      borderRadius: 'md',
      paddingX: 24,
      paddingY: 12,
      fontSize: '1rem',
      fontWeight: 500,
      borderWidth: 1,
      borderColor: '#e5e7eb',
    },
    outline: {
      backgroundColor: 'transparent',
      textColor: '#000000',
      borderRadius: 'md',
      paddingX: 24,
      paddingY: 12,
      fontSize: '1rem',
      fontWeight: 500,
      borderWidth: 2,
      borderColor: '#000000',
    },
  },
  layout: {
    maxWidth: 'xl',
    contentMaxWidth: '7xl',
    gutter: 16,
  },
};
