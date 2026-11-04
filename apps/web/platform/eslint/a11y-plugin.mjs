/**
 * Accessibility checks jsx-a11y can't make for our components (TASK-1184).
 *
 * jsx-a11y treats any child component as a possible label, so
 * `<Button size="icon"><X /></Button>` passes it, and it has no rule for
 * placeholder-only inputs, `outline-none` without a focus style, or Radix
 * dialogs without a title. These rules cover those, statically and within
 * one file: a name passed in from another file counts as missing, so the fix
 * is to pass it where the element is written.
 *
 * Switched on per folder through eslint/a11y-strict.mjs (A11Y_STRICT_FOLDERS);
 * lib/a11y/a11y-strict.test.ts is the check that blocks CI.
 */

const NAME_ATTRS = ['aria-label', 'aria-labelledby', 'title'];

function elementName(node) {
  const name = node.openingElement.name;
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') return name.property.name;
  return '';
}

function attr(node, name) {
  return node.openingElement.attributes.find(
    (a) => a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === name,
  );
}

function hasSpread(node) {
  return node.openingElement.attributes.some((a) => a.type === 'JSXSpreadAttribute');
}

/** A non-empty static value, or any expression (assumed to give one). */
function attrHasValue(a) {
  if (!a) return false;
  if (!a.value) return true;
  if (a.value.type === 'Literal') return String(a.value.value).trim() !== '';
  return true;
}

function hasNameAttr(node, names = NAME_ATTRS) {
  return names.some((n) => attrHasValue(attr(node, n)));
}

function exprHasText(e) {
  switch (e.type) {
    case 'JSXElement':
      return elementHasText(e);
    case 'JSXFragment':
      return childrenHaveText(e.children);
    case 'JSXEmptyExpression':
      return false;
    case 'ConditionalExpression':
      return exprHasText(e.consequent) || exprHasText(e.alternate);
    case 'LogicalExpression':
      return e.operator === '&&' ? exprHasText(e.right) : exprHasText(e.left) || exprHasText(e.right);
    case 'Literal':
      return typeof e.value === 'string' ? e.value.trim() !== '' : typeof e.value === 'number';
    case 'Identifier':
      return e.name !== 'undefined';
    default:
      // Member access, calls, template literals: assume they render text.
      return true;
  }
}

function elementHasText(el) {
  if (hasNameAttr(el, ['aria-label', 'aria-labelledby', 'title', 'alt'])) return true;
  if (attrHasValue(attr(el, 'children'))) return true;
  return childrenHaveText(el.children);
}

function childrenHaveText(children) {
  return children.some((c) => {
    if (c.type === 'JSXText') return c.value.trim() !== '';
    if (c.type === 'JSXExpressionContainer') return exprHasText(c.expression);
    if (c.type === 'JSXElement') return elementHasText(c);
    if (c.type === 'JSXFragment') return childrenHaveText(c.children);
    return false;
  });
}

/** Every string literal in a className value (also inside cn(), ternaries, templates). */
function classTokens(valueNode) {
  const out = [];
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'Literal' && typeof n.value === 'string') out.push(n.value);
    else if (n.type === 'TemplateElement') out.push(n.value.cooked ?? '');
    for (const key of Object.keys(n)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(valueNode);
  return out.join(' ').split(/\s+/).filter(Boolean);
}

const FOCUS_PREFIX = /^(?:[\w-]+:)*(?:focus|focus-visible|focus-within|group-focus-visible|peer-focus-visible):/;
const VISIBLE_FOCUS = [
  /^ring(?:-(?!0$|offset)[\w[\]/.#-]+)?$/,
  /^border(?:-.+)?$/,
  /^bg-.+$/,
  /^underline$/,
  /^outline(?:-(?!none$).+)?$/,
  /^shadow.*$/,
];

function removesOutline(tokens) {
  return tokens.some((t) => /(^|:)outline-none$/.test(t));
}

function replacesOutline(tokens) {
  return tokens.some((t) => {
    if (!FOCUS_PREFIX.test(t)) return false;
    const style = t.replace(FOCUS_PREFIX, '');
    return VISIBLE_FOCUS.some((pattern) => pattern.test(style));
  });
}

/** The shared ui components that draw their own focus-visible ring. */
const RING_COMPONENTS = new Set(['Button', 'Input', 'Textarea', 'SelectTrigger']);

function removesRing(tokens) {
  return tokens.some((t) => FOCUS_PREFIX.test(t) && /^ring-0$/.test(t.replace(FOCUS_PREFIX, '')));
}

function findDescendant(el, test) {
  let found = false;
  const visit = (n) => {
    if (found || !n || typeof n !== 'object') return;
    if (n.type === 'JSXElement' && n !== el && test(n)) {
      found = true;
      return;
    }
    for (const key of Object.keys(n)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(el);
  return found;
}

const iconButtonHasName = {
  meta: {
    type: 'problem',
    docs: { description: 'A button with only an icon in it needs an aria-label, title or sr-only text.' },
    schema: [],
    messages: {
      missing: 'This button has no text. Give it an aria-label (through i18n), or sr-only text.',
    },
  },
  create(context) {
    return {
      JSXElement(node) {
        const name = elementName(node);
        if (name !== 'button' && name !== 'Button') return;
        if (hasSpread(node) || hasNameAttr(node)) return;
        if (attr(node, 'aria-hidden')) return;
        if (!childrenHaveText(node.children)) context.report({ node: node.openingElement, messageId: 'missing' });
      },
    };
  },
};

const FIELDS = new Set(['input', 'Input', 'textarea', 'Textarea']);

const fieldHasName = {
  meta: {
    type: 'problem',
    docs: { description: 'Inputs, textareas and contentEditable fields need a label; a placeholder is not one.' },
    schema: [],
    messages: {
      missing: 'This field has no label. Add an aria-label (through i18n), or an id with a <Label htmlFor>.',
    },
  },
  create(context) {
    return {
      JSXElement(node) {
        const name = elementName(node);
        const editable = attr(node, 'contentEditable');
        const isEditable = editable && !(editable.value?.type === 'JSXExpressionContainer' && editable.value.expression.value === false);
        if (!FIELDS.has(name) && !isEditable) return;
        if (hasSpread(node) || hasNameAttr(node, ['aria-label', 'aria-labelledby', 'title', 'id'])) return;
        const type = attr(node, 'type');
        if (type?.value?.type === 'Literal' && ['hidden', 'submit', 'button', 'reset'].includes(type.value.value)) return;
        const className = attr(node, 'className');
        if (className && classTokens(className.value).includes('hidden')) return;
        for (let p = node.parent; p; p = p.parent) {
          if (p.type === 'JSXElement' && (elementName(p) === 'label' || elementName(p) === 'Label')) return;
        }
        context.report({ node: node.openingElement, messageId: 'missing' });
      },
    };
  },
};

const outlineNoneHasFocusStyle = {
  meta: {
    type: 'problem',
    docs: { description: '`outline-none` needs a visible focus replacement (focus-visible:ring-…, focus:bg-…).' },
    schema: [],
    messages: {
      missing: '`outline-none` hides the focus ring. Add a focus-visible: (or focus:) ring, border or background.',
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'className' || !node.value) return;
        const tokens = classTokens(node.value);
        if (!removesOutline(tokens) || replacesOutline(tokens)) return;
        const owner = node.parent.name;
        const ownerName = owner.type === 'JSXIdentifier' ? owner.name : owner.property?.name;
        if (RING_COMPONENTS.has(ownerName) && !removesRing(tokens)) return;
        context.report({ node, messageId: 'missing' });
      },
    };
  },
};

const DIALOG_CONTENT = /^(Dialog|AlertDialog|Sheet|Drawer|WideDialog)Content$/;

const dialogHasTitle = {
  meta: {
    type: 'problem',
    docs: { description: 'Dialog content needs a *Title and a *Description (or aria-describedby).' },
    schema: [],
    messages: {
      title: 'This dialog has no title. Add a DialogTitle (sr-only if it shows no heading).',
      description: 'This dialog has no description. Add a DialogDescription, or aria-describedby={undefined} if there is nothing to describe.',
    },
  },
  create(context) {
    return {
      JSXElement(node) {
        const name = elementName(node);
        if (!DIALOG_CONTENT.test(name) || hasSpread(node)) return;
        const hasTitle =
          hasNameAttr(node, ['aria-label', 'aria-labelledby']) || findDescendant(node, (el) => /Title$/.test(elementName(el)));
        if (!hasTitle) context.report({ node: node.openingElement, messageId: 'title' });
        const hasDescription =
          attr(node, 'aria-describedby') !== undefined || findDescendant(node, (el) => /Description$/.test(elementName(el)));
        if (!hasDescription) context.report({ node: node.openingElement, messageId: 'description' });
      },
    };
  },
};

export default {
  meta: { name: 'weldsuite-a11y' },
  rules: {
    'icon-button-has-name': iconButtonHasName,
    'field-has-name': fieldHasName,
    'outline-none-has-focus-style': outlineNoneHasFocusStyle,
    'dialog-has-title': dialogHasTitle,
  },
};
