import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { liveSourceWrites, testSourceWriteOffenders } from './support/test-source-write-hygiene';

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

describe('test source write hygiene', () => {
  it('finds a planted named write targeting the shipped source tree', () => {
    const planted = `
      const live = path.join(PROJECT_ROOT, 'src', 'render', 'capture.ts');
      writeFileSync(live, 'export {};\\n');
    `;
    expect(liveSourceWrites(planted)).toEqual(['writeFileSync']);
  });

  it('finds a planted direct write targeting the shipped source tree', () => {
    const planted = `
      writeFileSync(path.join(PROJECT_ROOT, 'src', 'render', 'effects.ts'), 'export {};\\n');
    `;
    expect(liveSourceWrites(planted)).toEqual(['writeFileSync']);
  });

  it('finds a planted write through a two-step source path alias', () => {
    const planted = `
      const sourceRoot = path.join(PROJECT_ROOT, 'src');
      const capture = path.join(sourceRoot, 'render', 'capture.ts');
      writeFileSync(capture, 'export {};\\n');
    `;
    expect(liveSourceWrites(planted)).toEqual(['writeFileSync']);
  });

  it('permits source mutation only inside a copied project graph', () => {
    const copied = `
      writeFileSync(path.join(project.root, 'src', 'render', 'capture.ts'), 'export {};\\n');
    `;
    expect(liveSourceWrites(copied)).toEqual([]);
  });

  it('never lets a test mutate the shared shipped source tree', () => {
    expect(testSourceWriteOffenders(PROJECT_ROOT)).toEqual([]);
  });
});
