import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The only packages the domain may import. Everything else must be a relative path.
const ALLOWED_PACKAGES = new Set(['decimal.js', 'node:crypto']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

function importSpecifiers(source: string): string[] {
  const pattern = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
  return [...source.matchAll(pattern)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]!);
}

describe('domain purity', () => {
  const files = sourceFiles(import.meta.dir);

  it('finds the domain sources', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('imports only relative modules and allow-listed packages (no NestJS, no ORM)', () => {
    const violations = files.flatMap((file) =>
      importSpecifiers(readFileSync(file, 'utf8'))
        .filter((spec) => !spec.startsWith('.') && !ALLOWED_PACKAGES.has(spec))
        .map((spec) => `${file}: ${spec}`),
    );
    expect(violations).toEqual([]);
  });

  it('the scanner itself recognises the forbidden imports', () => {
    const sample = `import { Injectable } from '@nestjs/common';\nimport { Entity } from "@mikro-orm/core";\nexport * from '@mikro-orm/postgresql';`;
    expect(importSpecifiers(sample)).toEqual(['@nestjs/common', '@mikro-orm/core', '@mikro-orm/postgresql']);
  });
});
