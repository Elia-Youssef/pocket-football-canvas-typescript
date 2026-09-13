import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const TEST_ROOT = path.join(PROJECT_ROOT, 'tests');

function maskComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => ' '.repeat(line.length));
}

function closingAt(text: string, opening: number, open: string, close: string): number {
  let depth = 0;
  for (let at = opening; at < text.length; at += 1) {
    if (text[at] === open) depth += 1;
    if (text[at] === close) {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    // This file proves the reader with literal controls below. Its own parser
    // necessarily contains the event-loop words it is looking for.
    if (entry.name === 'simulation-loop-hygiene.test.ts') return [];
    return entry.name.endsWith('.ts') ? [file] : [];
  });
}

interface UnboundedLoop {
  readonly line: number;
}

function unboundedSimulationLoops(source: string): UnboundedLoop[] {
  const text = maskComments(source);
  const loops: UnboundedLoop[] = [];
  const opener = /\b(?:while|for)\s*\(/g;
  for (let match = opener.exec(text); match !== null; match = opener.exec(text)) {
    const conditionAt = match.index + match[0].length - 1;
    const conditionEnd = closingAt(text, conditionAt, '(', ')');
    if (conditionEnd === -1) continue;
    let bodyAt = conditionEnd + 1;
    while (/\s/.test(text[bodyAt] ?? '')) bodyAt += 1;
    if (text[bodyAt] !== '{') continue;
    const bodyEnd = closingAt(text, bodyAt, '{', '}');
    if (bodyEnd === -1) continue;

    const condition = text.slice(conditionAt + 1, conditionEnd);
    const body = text.slice(bodyAt + 1, bodyEnd);
    const isSimulationEvent =
      /everyBodyStopped|stateOf\(|\.readout\(\)|\.frozen|\.goals|opponentReady/.test(condition) ||
      /trailingEdgePast|\.input\.allowed\(\)/.test(condition);
    const advancesSimulation = /\.(?:update|step)\(/.test(body);
    const hasHeaderCap = /(?:<|>)=?\s*(?:\d|[A-Za-z_$][\w$]*)/.test(condition);
    const hasBodyCap =
      /\bif\s*\([^{}]*(?:<|>)=?\s*(?:\d|[A-Za-z_$][\w$]*)/.test(body) ||
      /\.toBeLessThan(?:OrEqual)?\(/.test(body);
    if (isSimulationEvent && advancesSimulation && !hasHeaderCap && !hasBodyCap) {
      loops.push({ line: text.slice(0, match.index).split('\n').length });
    }
  }
  return loops;
}

describe('unit simulation-event loop hygiene', () => {
  it('puts a failing cap around every driven simulation event loop', () => {
    const offences = sourceFiles(TEST_ROOT).flatMap((file) =>
      unboundedSimulationLoops(readFileSync(file, 'utf8')).map(
        (loop) => `${path.relative(PROJECT_ROOT, file)}:${String(loop.line)}`,
      ),
    );
    expect(offences).toEqual([]);
  });

  it('rejects an unbounded event loop and accepts a capped control', () => {
    const unbounded = 'while (!sim.scoring.readout().frozen) { sim.step(); }';
    const capped = [
      'let steps = 0;',
      'while (!sim.scoring.readout().frozen) {',
      '  sim.step();',
      '  steps += 1;',
      '  if (steps > 2000) throw new Error("goal never arrived");',
      '}',
    ].join('\n');

    expect(unboundedSimulationLoops(unbounded)).toEqual([{ line: 1 }]);
    expect(unboundedSimulationLoops(capped)).toEqual([]);
  });
});
