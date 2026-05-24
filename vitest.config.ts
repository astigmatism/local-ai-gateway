import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

const withoutQuery = (value: string) => value.split('?')[0] ?? value;

const toFilePath = (value: string) => {
  const cleanValue = withoutQuery(value);
  return cleanValue.startsWith('file://') ? fileURLToPath(cleanValue) : cleanValue;
};

const resolveSourceJsImportsToTs = (): Plugin => ({
  name: 'resolve-source-js-imports-to-ts',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || !source.startsWith('.') || !source.endsWith('.js')) {
      return null;
    }

    const importerPath = toFilePath(importer);
    const importBasePath = path.resolve(path.dirname(importerPath), source.slice(0, -'.js'.length));

    for (const extension of ['.ts', '.tsx']) {
      const candidatePath = `${importBasePath}${extension}`;
      if (fs.existsSync(candidatePath)) {
        return candidatePath;
      }
    }

    return null;
  }
});

export default defineConfig({
  plugins: [resolveSourceJsImportsToTs()],
  test: {
    include: ['tests/**/*.test.ts']
  }
});
