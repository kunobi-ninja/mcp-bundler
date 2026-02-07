import { readFileSync } from 'node:fs';
import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

export default {
  input: 'src/index.ts',
  output: [
    {
      dir: 'dist',
      format: 'es',
      preserveModules: true,
      preserveModulesRoot: 'src',
      sourcemap: true,
    },
  ],
  external: [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    /^node:/,
    /^@modelcontextprotocol/,
  ],
  plugins: [
    resolve({ preferBuiltins: true }),
    commonjs(),
    typescript({
      tsconfig: './tsconfig.json',
      declaration: true,
      declarationDir: 'dist',
      outDir: 'dist',
      noEmit: false,
    }),
  ],
};
