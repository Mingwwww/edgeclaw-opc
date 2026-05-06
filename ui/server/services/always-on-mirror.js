import { promises as fs, constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { getAlwaysOnRunsDir } from './always-on-paths.js';

const VALID_MIRROR_STRATEGIES = new Set(['copy-on-write', 'full-copy']);
const TEXT_SAMPLE_BYTES = 8192;

function normalizeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function toRelativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function isIgnoredRelativePath(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  return normalized === '.claude' || normalized.startsWith('.claude/') || normalized === '.git' || normalized.startsWith('.git/');
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function runCommand(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
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
    child.on('error', error => {
      resolve({ code: 1, stdout, stderr: error.message });
    });
    child.on('close', code => {
      resolve({ code: code ?? 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export function getAlwaysOnRunDir(projectRoot, runId) {
  return path.join(getAlwaysOnRunsDir(projectRoot), runId);
}

export function getAlwaysOnRunArtifactPath(projectRoot, runId, fileName) {
  return path.join(getAlwaysOnRunDir(projectRoot, runId), fileName);
}

export function normalizeMirrorStrategy(input, { copyOnWriteAvailable = false } = {}) {
  const requested = normalizeString(input?.strategy, copyOnWriteAvailable ? 'copy-on-write' : 'full-copy');
  const strategy = VALID_MIRROR_STRATEGIES.has(requested) ? requested : 'full-copy';
  return {
    strategy: strategy === 'copy-on-write' && !copyOnWriteAvailable ? 'full-copy' : strategy,
    requestedStrategy: requested,
    reason: normalizeString(input?.reason, 'Selected by Always-On mirror policy.'),
    expectedWritePaths: Array.isArray(input?.expectedWritePaths)
      ? input.expectedWritePaths.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
      : [],
    riskLevel: ['low', 'medium', 'high'].includes(input?.riskLevel) ? input.riskLevel : 'medium',
    requiresFullWorkspace: input?.requiresFullWorkspace !== false,
  };
}

export async function detectGitRepository(projectRoot) {
  const result = await runCommand('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], projectRoot);
  return result.code === 0 && result.stdout === 'true';
}

export async function inspectGitWorkspace(projectRoot) {
  const isGitRepository = await detectGitRepository(projectRoot);
  if (!isGitRepository) {
    return {
      isGitRepository: false,
      hasHead: false,
      isDirty: false,
      statusShort: '',
    };
  }

  const [headResult, statusResult] = await Promise.all([
    runCommand('git', ['-C', projectRoot, 'rev-parse', '--verify', 'HEAD'], projectRoot),
    runCommand('git', ['-C', projectRoot, 'status', '--short'], projectRoot),
  ]);
  const rawStatusShort = statusResult.code === 0 ? statusResult.stdout : '';
  const statusShort = rawStatusShort
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .filter(line => {
      const filePath = line.length > 3 ? line.slice(3).trim() : '';
      return filePath !== '.claude' && !filePath.startsWith('.claude/');
    })
    .join('\n');

  return {
    isGitRepository: true,
    hasHead: headResult.code === 0,
    isDirty: statusShort.length > 0,
    statusShort,
  };
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function isTextFile(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(TEXT_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TEXT_SAMPLE_BYTES, 0);
    if (bytesRead === 0) {
      return true;
    }
    return !buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

async function walkWorkspace(root, visitor) {
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const relativePath = toRelativePath(root, entryPath);
    if (entry.name === '.claude' || isIgnoredRelativePath(relativePath)) {
      continue;
    }
    await visitor(entryPath, entry, relativePath);
    if (entry.isDirectory()) {
      await walkDirectory(entryPath, root, visitor);
    }
  }
}

async function walkDirectory(currentDir, root, visitor) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    const relativePath = toRelativePath(root, entryPath);
    if (isIgnoredRelativePath(relativePath)) {
      continue;
    }
    await visitor(entryPath, entry, relativePath);
    if (entry.isDirectory()) {
      await walkDirectory(entryPath, root, visitor);
    }
  }
}

export async function scanWorkspaceForMirror(projectRoot, { copyOnWriteAvailable = false } = {}) {
  const scan = {
    projectRoot,
    generatedAt: new Date().toISOString(),
    isGitRepository: await detectGitRepository(projectRoot),
    copyOnWriteAvailable,
    ignored: ['.claude'],
    files: 0,
    directories: 0,
    symlinks: 0,
    totalBytes: 0,
    largestFiles: [],
  };

  await walkWorkspace(projectRoot, async (entryPath, entry) => {
    if (entry.isDirectory()) {
      scan.directories += 1;
      return;
    }
    if (entry.isSymbolicLink()) {
      scan.symlinks += 1;
      return;
    }
    if (!entry.isFile()) {
      return;
    }
    const stats = await fs.stat(entryPath);
    scan.files += 1;
    scan.totalBytes += stats.size;
    scan.largestFiles.push({
      path: toRelativePath(projectRoot, entryPath),
      size: stats.size,
    });
    scan.largestFiles.sort((left, right) => right.size - left.size);
    scan.largestFiles = scan.largestFiles.slice(0, 10);
  });

  return scan;
}

async function probeCopyOnWrite(projectRoot, runDir) {
  const probeDir = path.join(runDir, 'cow-probe');
  const source = path.join(probeDir, 'source.txt');
  const target = path.join(probeDir, 'target.txt');
  try {
    await fs.rm(probeDir, { recursive: true, force: true });
    await ensureDir(probeDir);
    await fs.writeFile(source, 'always-on copy-on-write probe\n', 'utf8');
    await fs.copyFile(source, target, fsConstants.COPYFILE_FICLONE);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true }).catch(() => null);
  }
}

async function copyEntry(sourceRoot, targetRoot, relativePath, strategy) {
  const sourcePath = path.join(sourceRoot, relativePath);
  const targetPath = path.join(targetRoot, relativePath);
  const stats = await fs.lstat(sourcePath);
  if (stats.isDirectory()) {
    await ensureDir(targetPath);
    return;
  }
  if (stats.isSymbolicLink()) {
    const linkTarget = await fs.readlink(sourcePath);
    await ensureDir(path.dirname(targetPath));
    await fs.symlink(linkTarget, targetPath);
    return;
  }
  if (!stats.isFile()) {
    return;
  }

  await ensureDir(path.dirname(targetPath));
  if (strategy === 'copy-on-write') {
    await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE);
  } else {
    await fs.copyFile(sourcePath, targetPath);
  }
  await fs.chmod(targetPath, stats.mode).catch(() => null);
}

async function copyWorkspace(sourceRoot, targetRoot, strategy) {
  const entries = [];
  await walkWorkspace(sourceRoot, async (_entryPath, _entry, relativePath) => {
    entries.push(relativePath);
  });

  for (const relativePath of entries) {
    await copyEntry(sourceRoot, targetRoot, relativePath, strategy);
  }
}

async function copyWorkspaceWithFallback(sourceRoot, targetRoot, strategy, mirrorStrategy) {
  try {
    await copyWorkspace(sourceRoot, targetRoot, strategy);
    return strategy;
  } catch (error) {
    if (strategy !== 'copy-on-write') {
      throw error;
    }
    mirrorStrategy.strategy = 'full-copy';
    mirrorStrategy.reason = `${mirrorStrategy.reason} Copy-on-write failed during mirror creation, so Always-On fell back to full-copy.`;
    await fs.rm(targetRoot, { recursive: true, force: true });
    await ensureDir(targetRoot);
    await copyWorkspace(sourceRoot, targetRoot, 'full-copy');
    return 'full-copy';
  }
}

async function writeMirrorPreparationArtifacts(runDir, workspaceScan, mirrorStrategy) {
  await fs.writeFile(path.join(runDir, 'mirror-strategy.json'), `${JSON.stringify(mirrorStrategy, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(runDir, 'workspace-scan.json'), `${JSON.stringify(workspaceScan, null, 2)}\n`, 'utf8');
}

async function createPlainMirror({
  projectRoot,
  runId,
  runDir,
  strategyInput,
  fallbackReason = '',
}) {
  const copyOnWriteAvailable = await probeCopyOnWrite(projectRoot, runDir);
  const workspaceScan = await scanWorkspaceForMirror(projectRoot, { copyOnWriteAvailable });
  const mirrorStrategy = normalizeMirrorStrategy(strategyInput, { copyOnWriteAvailable });
  if (fallbackReason) {
    mirrorStrategy.reason = `${mirrorStrategy.reason} ${fallbackReason}`;
  }
  await writeMirrorPreparationArtifacts(runDir, workspaceScan, mirrorStrategy);

  const mirrorRoot = path.join(runDir, 'mirror');
  await fs.rm(mirrorRoot, { recursive: true, force: true });
  await ensureDir(mirrorRoot);
  await copyWorkspaceWithFallback(projectRoot, mirrorRoot, mirrorStrategy.strategy, mirrorStrategy);
  await fs.writeFile(path.join(runDir, 'mirror-strategy.json'), `${JSON.stringify(mirrorStrategy, null, 2)}\n`, 'utf8');

  const manifest = {
    runId,
    sourceRoot: projectRoot,
    executionRoot: mirrorRoot,
    kind: 'mirror',
    strategy: mirrorStrategy.strategy,
    ignored: ['.claude', '.git'],
    createdAt: new Date().toISOString(),
    files: workspaceScan.files,
    directories: workspaceScan.directories,
    totalBytes: workspaceScan.totalBytes,
    fallbackReason: fallbackReason || undefined,
  };
  await fs.writeFile(path.join(runDir, 'mirror-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    workspaceKind: 'mirror',
    executionRoot: mirrorRoot,
    runDir,
    manifest,
    workspaceScan,
    mirrorStrategy,
  };
}

async function createSnapshotGitMirror({
  projectRoot,
  runId,
  runDir,
  strategyInput,
  gitStatus,
  fallbackReason = '',
}) {
  const copyOnWriteAvailable = await probeCopyOnWrite(projectRoot, runDir);
  const workspaceScan = await scanWorkspaceForMirror(projectRoot, { copyOnWriteAvailable });
  const mirrorStrategy = normalizeMirrorStrategy(strategyInput, { copyOnWriteAvailable });
  if (fallbackReason) {
    mirrorStrategy.reason = `${mirrorStrategy.reason} ${fallbackReason}`;
  }
  await writeMirrorPreparationArtifacts(runDir, workspaceScan, mirrorStrategy);

  const mirrorRoot = path.join(runDir, 'snapshot-git-mirror');
  await fs.rm(mirrorRoot, { recursive: true, force: true });
  await ensureDir(mirrorRoot);
  await copyWorkspaceWithFallback(projectRoot, mirrorRoot, mirrorStrategy.strategy, mirrorStrategy);
  await fs.writeFile(path.join(runDir, 'mirror-strategy.json'), `${JSON.stringify(mirrorStrategy, null, 2)}\n`, 'utf8');

  const initResult = await runCommand('git', ['init'], mirrorRoot);
  if (initResult.code !== 0) {
    throw new Error(`Failed to initialize snapshot git mirror: ${initResult.stderr || initResult.stdout}`);
  }
  const addResult = await runCommand('git', ['add', '.'], mirrorRoot);
  if (addResult.code !== 0) {
    throw new Error(`Failed to stage snapshot git mirror baseline: ${addResult.stderr || addResult.stdout}`);
  }
  const commitResult = await runCommand(
    'git',
    [
      '-c',
      'user.name=Always-On',
      '-c',
      'user.email=always-on@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'Always-On baseline',
    ],
    mirrorRoot,
  );
  if (commitResult.code !== 0) {
    throw new Error(`Failed to commit snapshot git mirror baseline: ${commitResult.stderr || commitResult.stdout}`);
  }
  const baselineResult = await runCommand('git', ['rev-parse', 'HEAD'], mirrorRoot);
  if (baselineResult.code !== 0) {
    throw new Error(`Failed to resolve snapshot git mirror baseline: ${baselineResult.stderr || baselineResult.stdout}`);
  }
  const branchName = `always-on/${runId}`;
  const branchResult = await runCommand('git', ['checkout', '-b', branchName], mirrorRoot);
  if (branchResult.code !== 0) {
    throw new Error(`Failed to create snapshot git mirror branch: ${branchResult.stderr || branchResult.stdout}`);
  }

  const manifest = {
    runId,
    sourceRoot: projectRoot,
    executionRoot: mirrorRoot,
    kind: 'snapshot-git-mirror',
    strategy: mirrorStrategy.strategy,
    ignored: ['.claude', '.git'],
    createdAt: new Date().toISOString(),
    files: workspaceScan.files,
    directories: workspaceScan.directories,
    totalBytes: workspaceScan.totalBytes,
    gitStatus,
    baselineCommit: baselineResult.stdout,
    branchName,
    fallbackReason: fallbackReason || undefined,
  };
  await fs.writeFile(path.join(runDir, 'mirror-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    workspaceKind: 'snapshot-git-mirror',
    executionRoot: mirrorRoot,
    runDir,
    manifest,
    workspaceScan,
    mirrorStrategy,
  };
}

export async function prepareAlwaysOnExecutionWorkspace(projectRoot, runId, planContent, strategyInput = null) {
  const runDir = getAlwaysOnRunDir(projectRoot, runId);
  await ensureDir(runDir);
  await fs.writeFile(path.join(runDir, 'plan.md'), `${planContent.trim()}\n`, 'utf8');

  const gitStatus = await inspectGitWorkspace(projectRoot);
  if (gitStatus.isGitRepository && gitStatus.hasHead && !gitStatus.isDirty) {
    const safeRootName = path.basename(projectRoot).replace(/[^a-zA-Z0-9._-]/g, '-');
    const worktreePath = path.join(os.tmpdir(), 'edgeclaw-always-on-worktrees', `${safeRootName}-${runId}`);
    const branchName = `always-on/${runId}`;
    const result = await runCommand('git', ['-C', projectRoot, 'worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], projectRoot);
    if (result.code !== 0) {
      return await createSnapshotGitMirror({
        projectRoot,
        runId,
        runDir,
        strategyInput,
        gitStatus,
        fallbackReason: `Git worktree creation failed: ${result.stderr || result.stdout}`,
      });
    }
    const manifest = {
      runId,
      sourceRoot: projectRoot,
      executionRoot: worktreePath,
      kind: 'git-worktree',
      branchName,
      ignored: ['.claude'],
      createdAt: new Date().toISOString(),
      gitStatus,
    };
    await fs.writeFile(path.join(runDir, 'mirror-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return {
      workspaceKind: 'git-worktree',
      executionRoot: worktreePath,
      runDir,
      manifest,
      workspaceScan: null,
      mirrorStrategy: null,
    };
  }

  if (gitStatus.isGitRepository) {
    const reason = gitStatus.hasHead
      ? 'Git workspace is dirty, so Always-On used a snapshot git mirror.'
      : 'Git workspace has no HEAD, so Always-On used a snapshot git mirror.';
    return await createSnapshotGitMirror({
      projectRoot,
      runId,
      runDir,
      strategyInput,
      gitStatus,
      fallbackReason: reason,
    });
  }

  return await createPlainMirror({
    projectRoot,
    runId,
    runDir,
    strategyInput,
  });
}

async function collectFileMap(root) {
  const files = new Map();
  await walkWorkspace(root, async (entryPath, entry, relativePath) => {
    if (!entry.isFile()) {
      return;
    }
    const stats = await fs.stat(entryPath);
    files.set(relativePath, {
      path: relativePath,
      sha256: await hashFile(entryPath),
      size: stats.size,
      kind: await isTextFile(entryPath) ? 'text' : 'binary',
    });
  });
  return files;
}

function createPatchSection(operation, beforeText, afterText) {
  const filePath = operation.path || operation.to || operation.from;
  const oldLabel = operation.type === 'created' ? '/dev/null' : `a/${filePath}`;
  const newLabel = operation.type === 'deleted' ? '/dev/null' : `b/${filePath}`;
  const beforeLines = beforeText ? beforeText.replace(/\n$/, '').split(/\r?\n/) : [];
  const afterLines = afterText ? afterText.replace(/\n$/, '').split(/\r?\n/) : [];
  return [
    `--- ${oldLabel}`,
    `+++ ${newLabel}`,
    '@@',
    ...beforeLines.map(line => `-${line}`),
    ...afterLines.map(line => `+${line}`),
    '',
  ].join('\n');
}

async function buildTextPatch(sourceRoot, executionRoot, operations) {
  const sections = [];
  for (const operation of operations) {
    const filePath = operation.path || operation.to || operation.from;
    if (operation.kind !== 'text' || !filePath) {
      continue;
    }
    const beforePath = operation.type === 'created' ? null : path.join(sourceRoot, operation.from || filePath);
    const afterPath = operation.type === 'deleted' ? null : path.join(executionRoot, operation.to || filePath);
    const beforeText = beforePath ? await fs.readFile(beforePath, 'utf8').catch(() => '') : '';
    const afterText = afterPath ? await fs.readFile(afterPath, 'utf8').catch(() => '') : '';
    sections.push(createPatchSection(operation, beforeText, afterText));
  }
  return sections.join('\n');
}

export async function writeExecutionArtifacts(projectRoot, runId, executionRoot, latestSummary = '') {
  const runDir = getAlwaysOnRunDir(projectRoot, runId);
  await ensureDir(runDir);
  const [sourceFiles, executionFiles] = await Promise.all([
    collectFileMap(projectRoot),
    collectFileMap(executionRoot),
  ]);

  const operations = [];
  for (const [relativePath, before] of sourceFiles) {
    const after = executionFiles.get(relativePath);
    if (!after) {
      operations.push({
        type: 'deleted',
        path: relativePath,
        beforeSha256: before.sha256,
        kind: before.kind,
        size: before.size,
      });
      continue;
    }
    if (before.sha256 !== after.sha256) {
      operations.push({
        type: 'modified',
        path: relativePath,
        beforeSha256: before.sha256,
        afterSha256: after.sha256,
        kind: before.kind === 'binary' || after.kind === 'binary' ? 'binary' : 'text',
        beforeSize: before.size,
        afterSize: after.size,
      });
    }
  }

  for (const [relativePath, after] of executionFiles) {
    if (sourceFiles.has(relativePath)) {
      continue;
    }
    operations.push({
      type: 'created',
      path: relativePath,
      afterSha256: after.sha256,
      kind: after.kind,
      size: after.size,
    });
  }

  const fileOps = {
    runId,
    sourceRoot: projectRoot,
    executionRoot,
    generatedAt: new Date().toISOString(),
    operations,
  };
  const report = [
    '# Always-On Execution Report',
    '',
    `Run ID: ${runId}`,
    `Generated At: ${fileOps.generatedAt}`,
    '',
    '## Summary',
    latestSummary || 'The execution agent completed. Review the changed files before applying to the source workspace.',
    '',
    '## Files Changed',
    operations.length > 0
      ? operations.map(operation => `- ${operation.type}: ${operation.path || operation.from || operation.to}`).join('\n')
      : 'No file changes were detected.',
    '',
    '## Apply Status',
    'Waiting for user approval before applying changes to the source workspace.',
    '',
  ].join('\n');

  const patch = await buildTextPatch(projectRoot, executionRoot, operations);
  await fs.writeFile(path.join(runDir, 'report.md'), `${report.trim()}\n`, 'utf8');
  await fs.writeFile(path.join(runDir, 'file-ops.json'), `${JSON.stringify(fileOps, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(runDir, 'changes.patch'), patch ? `${patch.trim()}\n` : '', 'utf8');

  return {
    reportFilePath: path.join('.claude', 'always-on', 'runs', runId, 'report.md'),
    changesPatchPath: path.join('.claude', 'always-on', 'runs', runId, 'changes.patch'),
    fileOpsPath: path.join('.claude', 'always-on', 'runs', runId, 'file-ops.json'),
    changedFileCount: operations.length,
  };
}

