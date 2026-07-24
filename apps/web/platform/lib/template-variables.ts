/**
 * Template Variable Parser Utility
 * Handles parsing, validation, and extraction of template variables
 * Variables use the format: {{variableName}} or {{variableName|modifier}}
 */

export interface ParsedVariable {
  /** The full variable text including delimiters (e.g., "{{price|currency}}") */
  fullMatch: string;
  /** The variable name without delimiters (e.g., "price") */
  name: string;
  /** Optional format modifier (e.g., "currency", "date:MM/DD/YYYY") */
  modifier?: string;
  /** Position in the content string */
  position: number;
}

export interface VariableValidation {
  isValid: boolean;
  error?: string;
  suggestions?: string[];
}

/**
 * Regular expression to match template variables
 * Matches: {{variableName}} or {{variableName|modifier}}
 */
const VARIABLE_REGEX = /\{\{([a-zA-Z0-9_]+)(?:\|([a-zA-Z0-9_:/]+))?\}\}/g;

/**
 * Extract all variables from template content
 */
export function extractVariables(content: string): ParsedVariable[] {
  const variables: ParsedVariable[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  VARIABLE_REGEX.lastIndex = 0;

  while ((match = VARIABLE_REGEX.exec(content)) !== null) {
    variables.push({
      fullMatch: match[0],
      name: match[1],
      modifier: match[2],
      position: match.index
    });
  }

  return variables;
}

/**
 * Extract unique variable names from content
 */
export function getUniqueVariableNames(content: string): string[] {
  const variables = extractVariables(content);
  const uniqueNames = new Set(variables.map(v => v.name));
  return Array.from(uniqueNames);
}

/**
 * Check if content contains any variables
 */
export function hasVariables(content: string): boolean {
  VARIABLE_REGEX.lastIndex = 0;
  return VARIABLE_REGEX.test(content);
}

/**
 * Validate a variable name
 */
export function validateVariableName(name: string): VariableValidation {
  // Check if empty
  if (!name || name.trim().length === 0) {
    return {
      isValid: false,
      error: 'Variable name cannot be empty'
    };
  }

  // Check for valid characters (alphanumeric and underscore only)
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    return {
      isValid: false,
      error: 'Variable name can only contain letters, numbers, and underscores'
    };
  }

  // Check if starts with a number
  if (/^\d/.test(name)) {
    return {
      isValid: false,
      error: 'Variable name cannot start with a number'
    };
  }

  // Check length (reasonable limits)
  if (name.length > 50) {
    return {
      isValid: false,
      error: 'Variable name is too long (max 50 characters)'
    };
  }

  return { isValid: true };
}

/**
 * Available format modifiers and their descriptions
 */
const AVAILABLE_MODIFIERS = {
  currency: {
    label: 'Currency',
    description: 'Format as currency (e.g., $10.99)',
    example: '{{price|currency}}'
  },
  number: {
    label: 'Number',
    description: 'Format as number with decimal places',
    example: '{{quantity|number}}'
  },
  date: {
    label: 'Date',
    description: 'Format as date (supports custom formats)',
    example: '{{createdAt|date:MM/DD/YYYY}}'
  },
  boolean: {
    label: 'Yes/No',
    description: 'Format boolean as Yes/No',
    example: '{{isActive|boolean}}'
  }
};

/**
 * Validate a format modifier
 */
export function validateModifier(modifier: string): VariableValidation {
  if (!modifier) {
    return { isValid: true }; // No modifier is valid
  }

  const modifierName = modifier.split(':')[0];
  const validModifiers = Object.keys(AVAILABLE_MODIFIERS);

  if (!validModifiers.includes(modifierName)) {
    return {
      isValid: false,
      error: `Unknown modifier: ${modifierName}`,
      suggestions: validModifiers
    };
  }

  // Special validation for date modifier
  if (modifierName === 'date' && modifier.includes(':')) {
    const dateFormat = modifier.split(':')[1];
    if (!dateFormat) {
      return {
        isValid: false,
        error: 'Date format is required (e.g., date:MM/DD/YYYY)'
      };
    }
  }

  return { isValid: true };
}

/**
 * Create a variable string with optional modifier
 */
export function createVariable(name: string, modifier?: string): string {
  const nameValidation = validateVariableName(name);
  if (!nameValidation.isValid) {
    throw new Error(nameValidation.error);
  }

  if (modifier) {
    const modifierValidation = validateModifier(modifier);
    if (!modifierValidation.isValid) {
      throw new Error(modifierValidation.error);
    }
    return `{{${name}|${modifier}}}`;
  }

  return `{{${name}}}`;
}

/**
 * Replace variables in content with values from data object
 */
export function replaceVariables(
  content: string,
  data: Record<string, unknown>,
  formatters?: {
    currency?: (value: number) => string;
    date?: (value: string | Date, format?: string) => string;
    number?: (value: number) => string;
    boolean?: (value: boolean) => string;
  }
): string {
  let result = content;
  const variables = extractVariables(content);

  variables.forEach(variable => {
    const value = data[variable.name];

    if (value !== undefined && value !== null) {
      let formattedValue = String(value);

      // Apply formatter if modifier is present
      if (variable.modifier && formatters) {
        const modifierName = variable.modifier.split(':')[0];

        switch (modifierName) {
          case 'currency':
            if (formatters.currency) {
              formattedValue = formatters.currency(Number(value));
            }
            break;
          case 'date':
            if (formatters.date) {
              const dateFormat = variable.modifier.split(':')[1];
              formattedValue = formatters.date(value as string | Date, dateFormat);
            }
            break;
          case 'number':
            if (formatters.number) {
              formattedValue = formatters.number(Number(value));
            }
            break;
          case 'boolean':
            if (formatters.boolean) {
              formattedValue = formatters.boolean(Boolean(value));
            }
            break;
        }
      }

      // Escape special regex characters in the variable string
      const escapedVariable = variable.fullMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escapedVariable, 'g'), formattedValue);
    } else {
      // Replace with empty string if no value
      const escapedVariable = variable.fullMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escapedVariable, 'g'), '');
    }
  });

  return result;
}

/**
 * Get missing variables (variables in content that don't have corresponding data)
 */
export function getMissingVariables(
  content: string,
  data: Record<string, unknown>
): string[] {
  const variables = getUniqueVariableNames(content);
  return variables.filter(name => !(name in data));
}
