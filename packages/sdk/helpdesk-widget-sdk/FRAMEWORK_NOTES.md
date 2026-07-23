# Framework Implementation Notes

## Build Strategy

The SDK uses different build strategies for different frameworks based on their ecosystems:

### Compiled Frameworks (React, Angular)

**React** and **Angular** are built as compiled JavaScript:
- ✅ TypeScript compiled to JavaScript
- ✅ Type definitions generated
- ✅ Available as CJS and ESM
- ✅ Works out-of-the-box in any JavaScript project

**Files:**
- `dist/react.js` - React CJS build
- `dist/react.esm.js` - React ESM build
- `dist/react.d.ts` - React TypeScript definitions
- `dist/angular.js` - Angular CJS build
- `dist/angular.esm.js` - Angular ESM build
- `dist/angular.d.ts` - Angular TypeScript definitions

### Source Frameworks (Vue, Svelte)

**Vue** and **Svelte** component files are shipped as source:
- ✅ `.vue` and `.svelte` files included as-is
- ✅ Composables/helpers compiled to JavaScript
- ✅ Users' build systems handle component compilation
- ✅ Standard practice in these ecosystems

**Files:**
- `frameworks/vue/HelpdeskWidget.vue` - Vue component (source)
- `frameworks/vue/useHelpdeskWidget.ts` - Vue composable (source)
- `frameworks/vue/index.ts` - Vue exports (source)
- `frameworks/svelte/HelpdeskWidget.svelte` - Svelte component (source)
- `frameworks/svelte/index.ts` - Svelte exports (source)
- `dist/vue-composables.js` - Compiled composables (currently not used, may be removed)

## Why This Approach?

### React & Angular
- These frameworks expect pre-compiled npm packages
- Components are pure TypeScript/JSX
- No special file formats that require framework-specific build tools

### Vue & Svelte
- `.vue` and `.svelte` files require framework-specific compilers
- Standard practice: ship component files as source
- Users already have Vite/SvelteKit configured to handle these
- Avoids adding Vue/Svelte compiler dependencies to the SDK

## Package Exports

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.esm.js",
      "require": "./dist/index.js"
    },
    "./react": {
      "types": "./dist/react.d.ts",
      "import": "./dist/react.esm.js",
      "require": "./dist/react.js"
    },
    "./vue": {
      "types": "./frameworks/vue/index.ts",
      "import": "./frameworks/vue/index.ts",
      "require": "./frameworks/vue/index.ts"
    },
    "./angular": {
      "types": "./dist/angular.d.ts",
      "import": "./dist/angular.esm.js",
      "require": "./dist/angular.js"
    },
    "./svelte": {
      "types": "./frameworks/svelte/index.ts",
      "svelte": "./frameworks/svelte/HelpdeskWidget.svelte",
      "import": "./frameworks/svelte/index.ts",
      "require": "./frameworks/svelte/index.ts"
    }
  }
}
```

## For Framework Users

### React / Next.js
```tsx
import { HelpdeskWidgetReact } from '@weldcorporation/helpdesk-widget-sdk/react';

<HelpdeskWidgetReact widgetId="your-widget-id" />
```
Works immediately - no configuration needed.

### Vue / Nuxt
```vue
<script setup>
import { HelpdeskWidget } from '@weldcorporation/helpdesk-widget-sdk/vue';
</script>

<template>
  <HelpdeskWidget widget-id="your-widget-id" />
</template>
```
Works immediately - Vite/Nuxt already configured to handle `.vue` files.

### Angular
```typescript
import { HelpdeskWidgetComponent } from '@weldcorporation/helpdesk-widget-sdk/angular';

@Component({
  imports: [HelpdeskWidgetComponent],
  template: `<helpdesk-widget [widgetId]="'your-widget-id'"></helpdesk-widget>`
})
```
Works immediately - no configuration needed.

### Svelte / SvelteKit
```svelte
<script>
  import { HelpdeskWidget } from '@weldcorporation/helpdesk-widget-sdk/svelte';
</script>

<HelpdeskWidget widgetId="your-widget-id" />
```
Works immediately - SvelteKit already configured to handle `.svelte` files.

## Troubleshooting

### "Cannot find module .vue" in TypeScript

If TypeScript complains about `.vue` imports, ensure you have Vue's type definitions:

```json
// tsconfig.json or vite-env.d.ts
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
```

This is standard for Vue projects and should already be configured.

### "Cannot find module .svelte" in TypeScript

Ensure your `vite.config.js` includes the Svelte plugin:

```javascript
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default {
  plugins: [svelte()]
}
```

This is standard for Svelte projects and should already be configured.

## Build Process

```bash
pnpm build
```

Compiles:
1. Core SDK (all formats)
2. React components (CJS + ESM + types)
3. Angular components (CJS + ESM + types)
4. Vue composables (CJS + ESM) - optional
5. Type definitions for all compiled modules

Includes as source:
- Vue `.vue` component and TypeScript files
- Svelte `.svelte` component and TypeScript files

## Future Considerations

### If Pre-compilation is Required

If users request pre-compiled Vue/Svelte components:

1. Add `@vitejs/plugin-vue` and `vite-plugin-svelte` to devDependencies
2. Update Rollup config with these plugins
3. Compile `.vue` and `.svelte` files to `.js`
4. Update exports to point to compiled files

Current approach is preferred as it's simpler and aligns with ecosystem standards.
