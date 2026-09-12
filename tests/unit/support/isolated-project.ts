import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

import { execFileSync } from 'node:child_process';

/** A disposable copy of the project graph used only by a build assertion. */
export interface CopiedProject {
  root: string;
}

/**
 * Copy the game-owned build inputs below node_modules/.tmp, where dependency
 * resolution still finds this checkout's installed packages but no assertion
 * can rewrite a file the rest of the suite is reading.
 */
export function copyProjectGraph(projectRoot: string, prefix: string): CopiedProject {
  const scratch = path.join(projectRoot, 'node_modules', '.tmp');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, `${prefix}-`));
  try {
    for (const relative of ['index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'src']) {
      cpSync(path.join(projectRoot, relative), path.join(root, relative), { recursive: true });
    }
    return { root };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Build the copied graph, never the checkout that the unit runner shares. */
export function buildCopiedProject(project: CopiedProject, vite: string, outDir: string): string {
  execFileSync(process.execPath, [vite, 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: project.root,
    stdio: 'pipe',
  });
  return path.join(project.root, outDir);
}

/** Remove every copied input and emitted byte after the assertion finishes. */
export function removeCopiedProject(project: CopiedProject): void {
  rmSync(project.root, { recursive: true, force: true });
}
