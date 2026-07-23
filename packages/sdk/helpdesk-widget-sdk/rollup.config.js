import typescript from '@rollup/plugin-typescript';
import json from '@rollup/plugin-json';
import dts from 'rollup-plugin-dts';

const config = [
  // Main build (CJS and ESM)
  {
    input: 'src/index.ts',
    output: [
      {
        file: 'dist/index.js',
        format: 'cjs',
        sourcemap: true,
        exports: 'named',
      },
      {
        file: 'dist/index.esm.js',
        format: 'es',
        sourcemap: true,
      },
      {
        file: 'dist/index.umd.js',
        format: 'umd',
        name: 'HelpdeskWidget',
        sourcemap: true,
        exports: 'named',
      },
    ],
    plugins: [
      json(),
      typescript({
        tsconfig: './tsconfig.json',
        declaration: false,
      }),
    ],
    external: ['react', 'react-dom', 'vue', '@angular/core', 'svelte'],
  },
  // React framework build
  {
    input: 'frameworks/react/index.ts',
    output: [
      {
        file: 'dist/react.js',
        format: 'cjs',
        sourcemap: true,
        exports: 'named',
      },
      {
        file: 'dist/react.esm.js',
        format: 'es',
        sourcemap: true,
      },
    ],
    plugins: [
      json(),
      typescript({
        tsconfig: './tsconfig.json',
        declaration: false,
        compilerOptions: {
          declaration: false,
          declarationMap: false,
        },
      }),
    ],
    external: ['react', 'react-dom'],
  },
  // Vue composables build (component shipped as .vue source)
  {
    input: 'frameworks/vue/useHelpdeskWidget.ts',
    output: [
      {
        file: 'dist/vue-composables.js',
        format: 'cjs',
        sourcemap: true,
        exports: 'named',
      },
      {
        file: 'dist/vue-composables.esm.js',
        format: 'es',
        sourcemap: true,
      },
    ],
    plugins: [
      json(),
      typescript({
        tsconfig: './tsconfig.json',
        declaration: false,
        compilerOptions: {
          declaration: false,
          declarationMap: false,
        },
      }),
    ],
    external: ['vue'],
  },
  // Angular framework build
  {
    input: 'frameworks/angular/index.ts',
    output: [
      {
        file: 'dist/angular.js',
        format: 'cjs',
        sourcemap: true,
        exports: 'named',
      },
      {
        file: 'dist/angular.esm.js',
        format: 'es',
        sourcemap: true,
      },
    ],
    plugins: [
      json(),
      typescript({
        tsconfig: './tsconfig.json',
        declaration: false,
        compilerOptions: {
          declaration: false,
          declarationMap: false,
        },
      }),
    ],
    external: ['@angular/core'],
  },
  // Svelte component shipped as .svelte source (no build needed)
  // Type definitions - Main
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/index.d.ts',
      format: 'es',
    },
    plugins: [dts()],
  },
  // Type definitions - React
  {
    input: 'frameworks/react/index.ts',
    output: {
      file: 'dist/react.d.ts',
      format: 'es',
    },
    plugins: [dts()],
  },
  // Type definitions - Angular
  {
    input: 'frameworks/angular/index.ts',
    output: {
      file: 'dist/angular.d.ts',
      format: 'es',
    },
    plugins: [dts()],
  },
];

export default config;
