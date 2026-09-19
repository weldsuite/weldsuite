import typescript from '@rollup/plugin-typescript';
import dts from 'rollup-plugin-dts';

const external = ['react', 'react/jsx-runtime', 'react-dom'];

const config = [
  // Core build (ESM + CJS)
  {
    input: 'src/index.ts',
    output: [
      {
        file: 'dist/index.js',
        format: 'es',
        sourcemap: true,
      },
      {
        file: 'dist/index.cjs',
        format: 'cjs',
        sourcemap: true,
        exports: 'named',
      },
    ],
    plugins: [
      typescript({
        tsconfig: './tsconfig.json',
        declaration: false,
      }),
    ],
    external,
  },
  // React bindings build (ESM + CJS)
  {
    input: 'src/react/index.tsx',
    output: [
      {
        file: 'dist/react.js',
        format: 'es',
        sourcemap: true,
      },
      {
        file: 'dist/react.cjs',
        format: 'cjs',
        sourcemap: true,
        exports: 'named',
      },
    ],
    plugins: [
      typescript({
        tsconfig: './tsconfig.json',
        declaration: false,
      }),
    ],
    external,
  },
  // Suite UI kit (ESM + CJS)
  {
    input: 'src/ui/index.ts',
    output: [
      {
        file: 'dist/ui.js',
        format: 'es',
        sourcemap: true,
      },
      {
        file: 'dist/ui.cjs',
        format: 'cjs',
        sourcemap: true,
        exports: 'named',
      },
    ],
    plugins: [
      typescript({
        tsconfig: './tsconfig.json',
        declaration: false,
      }),
    ],
    external,
  },
  // Type definitions — core
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/index.d.ts',
      format: 'es',
    },
    plugins: [dts()],
    external,
  },
  // Type definitions — react
  {
    input: 'src/react/index.tsx',
    output: {
      file: 'dist/react.d.ts',
      format: 'es',
    },
    plugins: [dts()],
    external,
  },
  // Type definitions — ui
  {
    input: 'src/ui/index.ts',
    output: {
      file: 'dist/ui.d.ts',
      format: 'es',
    },
    plugins: [dts()],
    external,
  },
];

export default config;
