import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MUTATORS = new Set([
  'appendFile',
  'appendFileSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'mkdir',
  'mkdirSync',
  'rename',
  'renameSync',
  'rm',
  'rmSync',
  'unlink',
  'unlinkSync',
  'writeFile',
  'writeFileSync',
]);

function testSources(root: string): string[] {
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      break;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile() && absolute.endsWith('.ts')) {
        found.push(absolute);
      }
    }
  }
  return found.sort();
}

function sourcePathAliases(source: string): Set<string> {
  const aliases = new Set<string>();
  const declarations = [...source.matchAll(
    /\b(?:const|let)\s+(\w+)\s*=\s*path\.(?:join|resolve)\(([^;]+)\);/g,
  )];
  for (let pass = 0; pass < declarations.length; pass += 1) {
    let changed = false;
    for (const match of declarations) {
      const name = match[1];
      const argumentsText = match[2] ?? '';
      if (name === undefined || aliases.has(name)) {
        continue;
      }
      const startsAtSourceRoot =
        /\bPROJECT_ROOT\s*,\s*['"]src['"]/.test(argumentsText);
      const startsAtAlias = [...aliases].some((alias) =>
        new RegExp('^\\s*' + alias + '\\b').test(argumentsText),
      );
      if (startsAtSourceRoot || startsAtAlias) {
        aliases.add(name);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  return aliases;
}

/**
 * Finds filesystem mutation calls whose destination is a PROJECT_ROOT/src
 * path. The accepted temporary-copy shape has a copied root instead, so it is
 * deliberately not a hit.
 */
export function liveSourceWrites(source: string): string[] {
  const aliases = sourcePathAliases(source);
  const hits: string[] = [];
  const directCalls = new RegExp(
    '\\b(' + [...MUTATORS].join('|') + ')\\s*\\(\\s*path\\.(?:join|resolve)\\(\\s*PROJECT_ROOT\\s*,\\s*[\'"]src[\'"]',
    'g',
  );
  for (const match of source.matchAll(directCalls)) {
    hits.push(match[1] ?? '');
  }
  const call = /\b(\w+)\s*\(\s*([^,\n]+)/g;
  for (const match of source.matchAll(call)) {
    const name = match[1] ?? '';
    const target = match[2] ?? '';
    if (MUTATORS.has(name) && aliases.has(target.trim())) {
      hits.push(name);
    }
  }
  return hits;
}

/** A source file's template fixtures are data, not filesystem calls it makes. */
function withoutTemplateLiterals(source: string): string {
  const delimiter = String.fromCharCode(96);
  return source.replace(new RegExp(delimiter + '(?:\\\\.|[^' + delimiter + '])*' + delimiter, 'gs'), '');
}

/** Every test-tree write aimed at the shared shipped source directory. */
export function testSourceWriteOffenders(projectRoot: string): string[] {
  return testSources(path.join(projectRoot, 'tests')).flatMap((absolute) => {
    const hits = liveSourceWrites(withoutTemplateLiterals(readFileSync(absolute, 'utf8')));
    return hits.map((name) => path.relative(projectRoot, absolute) + ': ' + name);
  });
}
