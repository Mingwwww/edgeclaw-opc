import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  inspectGitWorkspace,
  normalizeMirrorStrategy,
  prepareAlwaysOnExecutionWorkspace,
  scanWorkspaceForMirror,
} from './always-on-mirror.js';

const tempDirs = [];

async function createTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `git exited ${code}`));
      }
    });
  });
}

async function commitAll(cwd, message = 'baseline') {
  await runGit(['add', '.'], cwd);
  await runGit([
    '-c',
    'user.name=Always-On Test',
    '-c',
    'user.email=always-on-test@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    message,
  ], cwd);
}

test('normalizeMirrorStrategy only allows copy-on-write and full-copy', () => {
  assert.deepEqual(
    normalizeMirrorStrategy({
      strategy: 'partial-copy',
      reason: 'try partial',
      expectedWritePaths: ['src'],
      riskLevel: 'low',
      requiresFullWorkspace: false,
    }, { copyOnWriteAvailable: true }),
    {
      strategy: 'full-copy',
      requestedStrategy: 'partial-copy',
      reason: 'try partial',
      expectedWritePaths: ['src'],
      riskLevel: 'low',
      requiresFullWorkspace: false,
    },
  );

  assert.equal(
    normalizeMirrorStrategy({ strategy: 'copy-on-write' }, { copyOnWriteAvailable: false }).strategy,
    'full-copy',
  );
});

test('non-git mirror ignores .claude and writes scan and strategy artifacts', async () => {
  const projectRoot = await createTempDir('always-on-mirror-project-');
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, '.claude', 'always-on'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'src', 'app.js'), 'console.log("hello");\n', 'utf8');
  await fs.writeFile(path.join(projectRoot, '.claude', 'secret.md'), 'do not copy\n', 'utf8');

  const scan = await scanWorkspaceForMirror(projectRoot);
  assert.equal(scan.files, 1);
  assert.equal(scan.ignored.includes('.claude'), true);

  const prepared = await prepareAlwaysOnExecutionWorkspace(projectRoot, 'run-alpha', '# Plan');
  assert.equal(prepared.workspaceKind, 'mirror');
  assert.equal(
    await fs.readFile(path.join(prepared.executionRoot, 'src', 'app.js'), 'utf8'),
    'console.log("hello");\n',
  );
  await assert.rejects(
    () => fs.access(path.join(prepared.executionRoot, '.claude')),
    /ENOENT/,
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(prepared.runDir, 'mirror-strategy.json'), 'utf8')).strategy,
    prepared.mirrorStrategy.strategy,
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(prepared.runDir, 'mirror-manifest.json'), 'utf8')).kind,
    'mirror',
  );
});

test('inspectGitWorkspace reports no HEAD and dirty state', async () => {
  const projectRoot = await createTempDir('always-on-git-no-head-');
  await runGit(['init'], projectRoot);
  await fs.mkdir(path.join(projectRoot, 'docs'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'docs', 'README.md'), '# Poker\n', 'utf8');

  const status = await inspectGitWorkspace(projectRoot);
  assert.equal(status.isGitRepository, true);
  assert.equal(status.hasHead, false);
  assert.equal(status.isDirty, true);
  assert.match(status.statusShort, /\?\? docs\//);
});

test('git repository without HEAD uses snapshot-git-mirror', async () => {
  const projectRoot = await createTempDir('always-on-snapshot-no-head-');
  await runGit(['init'], projectRoot);
  await fs.mkdir(path.join(projectRoot, 'docs'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'docs', 'README.md'), '# Poker\n', 'utf8');

  const prepared = await prepareAlwaysOnExecutionWorkspace(projectRoot, 'run-no-head', '# Plan');
  assert.equal(prepared.workspaceKind, 'snapshot-git-mirror');
  assert.equal(
    await fs.readFile(path.join(prepared.executionRoot, 'docs', 'README.md'), 'utf8'),
    '# Poker\n',
  );
  assert.equal(
    await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], prepared.executionRoot),
    'always-on/run-no-head',
  );
  const manifest = JSON.parse(await fs.readFile(path.join(prepared.runDir, 'mirror-manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'snapshot-git-mirror');
  assert.equal(manifest.gitStatus.hasHead, false);
  assert.ok(manifest.baselineCommit);
});

test('dirty git repository falls back to snapshot-git-mirror', async () => {
  const projectRoot = await createTempDir('always-on-snapshot-dirty-');
  await runGit(['init'], projectRoot);
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# Clean\n', 'utf8');
  await commitAll(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# Dirty\n', 'utf8');

  const prepared = await prepareAlwaysOnExecutionWorkspace(projectRoot, 'run-dirty', '# Plan');
  assert.equal(prepared.workspaceKind, 'snapshot-git-mirror');
  assert.equal(await fs.readFile(path.join(prepared.executionRoot, 'README.md'), 'utf8'), '# Dirty\n');
  const manifest = JSON.parse(await fs.readFile(path.join(prepared.runDir, 'mirror-manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'snapshot-git-mirror');
  assert.equal(manifest.gitStatus.hasHead, true);
  assert.equal(manifest.gitStatus.isDirty, true);
});

test('clean git repository with HEAD uses git worktree', async () => {
  const projectRoot = await createTempDir('always-on-clean-worktree-');
  await runGit(['init'], projectRoot);
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# Clean\n', 'utf8');
  await commitAll(projectRoot);

  const prepared = await prepareAlwaysOnExecutionWorkspace(projectRoot, 'run-clean', '# Plan');
  tempDirs.push(prepared.executionRoot);
  assert.equal(prepared.workspaceKind, 'git-worktree');
  assert.equal(await fs.readFile(path.join(prepared.executionRoot, 'README.md'), 'utf8'), '# Clean\n');
  const manifest = JSON.parse(await fs.readFile(path.join(prepared.runDir, 'mirror-manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'git-worktree');
  assert.equal(manifest.gitStatus.hasHead, true);
  assert.equal(manifest.gitStatus.isDirty, false);
});

