import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import multer from 'multer';
import { parseFrontmatter } from '../utils/frontmatter.js';

const execFileAsync = promisify(execFile);
const router = express.Router();

// Multipart parser for the folder-picker upload flow. Files are buffered in
// memory because the typical skill bundle is small (manifest hard-cap is
// 50MB total). diskStorage would also work but adds I/O for no win at this
// size class. The MAX_TOTAL_BYTES check below provides the hard ceiling.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // single file
    files: 500,
    fields: 20,
  },
});

// ---------------------------------------------------------------------------
// Path & slug safety
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

function safeSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug) && !slug.includes('..');
}

// "general chat" cwds — these come through as projectPath but are not real
// projects. Match the patterns from edgeclaw runtimePaths.generalCwd default
// and the memory-core constant. See routes/commands.js for the same logic.
const GENERAL_CWD_PATHS = [
  path.join(os.homedir(), 'Claude', 'general'),
  path.join(os.homedir(), '.claude-gateway', 'general'),
].map((p) => path.resolve(p));

function isGeneralCwd(projectPath) {
  if (!projectPath) return false;
  return GENERAL_CWD_PATHS.includes(path.resolve(projectPath));
}

function userSkillsRoot() {
  return path.join(os.homedir(), '.claude', 'skills');
}

function projectSkillsRoot(projectPath) {
  return path.join(projectPath, '.claude', 'skills');
}

// Validate that an absolute skillPath belongs to a known skills root and has
// a single safe slug segment. Returns { ok, scope, slug, root } or { ok: false, reason }.
function classifySkillPath(skillPath, projectPath = null) {
  if (typeof skillPath !== 'string' || !skillPath) {
    return { ok: false, reason: 'skillPath is required' };
  }
  const abs = path.resolve(skillPath);
  if (abs.includes('..')) {
    return { ok: false, reason: 'skillPath contains ".."' };
  }

  const candidates = [{ root: userSkillsRoot(), scope: 'user' }];
  if (projectPath && !isGeneralCwd(projectPath)) {
    candidates.push({ root: projectSkillsRoot(projectPath), scope: 'project' });
  }

  for (const { root, scope } of candidates) {
    const rootResolved = path.resolve(root);
    if (abs === rootResolved) {
      return { ok: false, reason: 'skillPath is the skills root, not a skill' };
    }
    const rel = path.relative(rootResolved, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const segments = rel.split(path.sep).filter(Boolean);
    if (segments.length === 0) continue;
    const slug = segments[0];
    if (!safeSlug(slug)) {
      return { ok: false, reason: `Invalid slug "${slug}"` };
    }
    return {
      ok: true,
      scope,
      slug,
      root: rootResolved,
      skillDir: path.join(rootResolved, slug),
    };
  }

  return { ok: false, reason: 'skillPath is not inside any known skills root' };
}

// ---------------------------------------------------------------------------
// Skill enumeration
// ---------------------------------------------------------------------------

async function readSkillMeta(skillDir) {
  const skillFile = path.join(skillDir, 'SKILL.md');
  let content;
  try {
    content = await fs.readFile(skillFile, 'utf8');
  } catch {
    return null;
  }
  let frontmatter = {};
  try {
    const parsed = parseFrontmatter(content);
    frontmatter = parsed.data || {};
  } catch {
    /* tolerate parse failures — surface raw skill anyway */
  }
  let mtime = null;
  try {
    const stat = await fs.stat(skillFile);
    mtime = stat.mtimeMs;
  } catch {
    /* ignore */
  }
  return {
    slug: path.basename(skillDir),
    name: frontmatter.name || path.basename(skillDir),
    description: frontmatter.description || '',
    version: frontmatter.version || null,
    skillFile,
    skillDir,
    mtime,
  };
}

async function listSkillsIn(root, scope) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const skills = [];
  for (const entry of entries) {
    if (!safeSlug(entry.name)) continue;
    // Accept directories AND symlinks-to-directories (the import-as-symlink
    // path creates the latter). For symlinks we resolve and verify the
    // target is a real directory before treating it as a skill.
    let isSkillDir = entry.isDirectory();
    if (!isSkillDir && entry.isSymbolicLink()) {
      try {
        const target = await fs.stat(path.join(root, entry.name));
        isSkillDir = target.isDirectory();
      } catch {
        isSkillDir = false;
      }
    }
    if (!isSkillDir) continue;
    const meta = await readSkillMeta(path.join(root, entry.name));
    if (!meta) continue;
    skills.push({ ...meta, scope });
  }
  skills.sort((a, b) => a.slug.localeCompare(b.slug));
  return skills;
}

router.post('/list', async (req, res) => {
  try {
    const { projectPath } = req.body || {};
    const generalCwd = isGeneralCwd(projectPath);
    const effectiveProjectPath = generalCwd ? null : projectPath || null;

    const userSkills = await listSkillsIn(userSkillsRoot(), 'user');
    const projectSkills = effectiveProjectPath
      ? await listSkillsIn(projectSkillsRoot(effectiveProjectPath), 'project')
      : [];

    res.json({
      user: userSkills,
      project: projectSkills,
      projectPath: effectiveProjectPath,
      isGeneralCwd: generalCwd,
    });
  } catch (e) {
    console.error('[skills/list]', e);
    res.status(500).json({ error: 'Failed to list skills', message: e.message });
  }
});

// ---------------------------------------------------------------------------
// Read & write SKILL.md
// ---------------------------------------------------------------------------

router.post('/read', async (req, res) => {
  try {
    const { skillPath, projectPath } = req.body || {};
    const cls = classifySkillPath(skillPath, projectPath);
    if (!cls.ok) return res.status(400).json({ error: cls.reason });

    const skillFile = path.join(cls.skillDir, 'SKILL.md');
    let content;
    try {
      content = await fs.readFile(skillFile, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'SKILL.md not found' });
      throw e;
    }
    const meta = await readSkillMeta(cls.skillDir);
    res.json({ content, scope: cls.scope, slug: cls.slug, skill: meta });
  } catch (e) {
    console.error('[skills/read]', e);
    res.status(500).json({ error: 'Failed to read skill', message: e.message });
  }
});

router.post('/write', async (req, res) => {
  try {
    const { skillPath, content, projectPath } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content (string) is required' });
    }
    const cls = classifySkillPath(skillPath, projectPath);
    if (!cls.ok) return res.status(400).json({ error: cls.reason });

    await fs.mkdir(cls.skillDir, { recursive: true });
    const skillFile = path.join(cls.skillDir, 'SKILL.md');
    await fs.writeFile(skillFile, content, 'utf8');
    const meta = await readSkillMeta(cls.skillDir);
    res.json({ ok: true, scope: cls.scope, slug: cls.slug, skill: meta });
  } catch (e) {
    console.error('[skills/write]', e);
    res.status(500).json({ error: 'Failed to write skill', message: e.message });
  }
});

// ---------------------------------------------------------------------------
// Create / delete
// ---------------------------------------------------------------------------

function buildInitialSkillContent({ slug, name, description, body }) {
  const fmName = (name || slug).replace(/\n/g, ' ').trim();
  const fmDesc = (description || '').replace(/\n/g, ' ').trim();
  const lines = ['---', `name: ${fmName}`];
  if (fmDesc) lines.push(`description: ${fmDesc}`);
  lines.push('---', '', `# ${fmName}`, '');
  if (body && body.trim()) {
    lines.push(body.trim(), '');
  } else {
    lines.push('Describe what this skill does, when to invoke it, and any prerequisites.', '');
  }
  return lines.join('\n');
}

router.post('/create', async (req, res) => {
  try {
    const { scope, projectPath, slug, name, description, body, content } = req.body || {};

    if (!safeSlug(slug)) {
      return res.status(400).json({ error: `Invalid slug "${slug}". Allowed: [a-zA-Z0-9][a-zA-Z0-9._-]{0,99}, no "..".` });
    }
    const wantProject = scope === 'project';
    let root;
    if (wantProject) {
      if (!projectPath || isGeneralCwd(projectPath)) {
        return res.status(400).json({ error: 'project scope requires a real project (general chat doesn\'t qualify)' });
      }
      root = projectSkillsRoot(projectPath);
    } else {
      root = userSkillsRoot();
    }
    const skillDir = path.join(root, slug);

    try {
      await fs.access(skillDir);
      return res.status(409).json({ error: `Skill already exists at ${skillDir}` });
    } catch {
      /* expected — does not exist */
    }

    await fs.mkdir(skillDir, { recursive: true });
    const finalContent =
      typeof content === 'string' && content.trim()
        ? content
        : buildInitialSkillContent({ slug, name, description, body });
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(skillFile, finalContent, 'utf8');

    const meta = await readSkillMeta(skillDir);
    res.json({
      ok: true,
      scope: wantProject ? 'project' : 'user',
      slug,
      skillPath: skillDir,
      skill: meta,
    });
  } catch (e) {
    console.error('[skills/create]', e);
    res.status(500).json({ error: 'Failed to create skill', message: e.message });
  }
});

router.post('/delete', async (req, res) => {
  try {
    const { skillPath, projectPath } = req.body || {};
    const cls = classifySkillPath(skillPath, projectPath);
    if (!cls.ok) return res.status(400).json({ error: cls.reason });

    try {
      await fs.rm(cls.skillDir, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    res.json({ ok: true, scope: cls.scope, slug: cls.slug });
  } catch (e) {
    console.error('[skills/delete]', e);
    res.status(500).json({ error: 'Failed to delete skill', message: e.message });
  }
});

// ---------------------------------------------------------------------------
// Import from existing folder (copy or symlink)
// ---------------------------------------------------------------------------

function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

router.post('/import', async (req, res) => {
  try {
    const { sourcePath, slug: requestedSlug, scope, projectPath, mode, force } = req.body || {};

    if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
      return res.status(400).json({ error: 'sourcePath is required' });
    }
    const importMode = mode === 'symlink' ? 'symlink' : 'copy';

    // Resolve source: ~ expansion + absolute path required.
    const resolvedSource = path.resolve(expandHome(sourcePath.trim()));
    let stat;
    try {
      stat = await fs.stat(resolvedSource);
    } catch (e) {
      if (e.code === 'ENOENT') {
        return res.status(404).json({ error: `Source path does not exist: ${resolvedSource}` });
      }
      throw e;
    }
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: `Source path is not a directory: ${resolvedSource}` });
    }

    // SKILL.md must exist at the source root — that's what makes it a skill.
    try {
      await fs.access(path.join(resolvedSource, 'SKILL.md'));
    } catch {
      return res.status(400).json({
        error: `Source folder does not contain a SKILL.md at the root: ${resolvedSource}`,
      });
    }

    // Slug: explicit, else fall back to basename of source. Validate strictly.
    const inferredSlug = (typeof requestedSlug === 'string' && requestedSlug.trim()) || path.basename(resolvedSource);
    if (!safeSlug(inferredSlug)) {
      return res.status(400).json({
        error: `Invalid slug "${inferredSlug}". Allowed: [a-zA-Z0-9][a-zA-Z0-9._-]{0,99}, no "..".`,
      });
    }

    // Resolve target scope and dir.
    const wantProject = scope === 'project';
    let root;
    if (wantProject) {
      if (!projectPath || isGeneralCwd(projectPath)) {
        return res.status(400).json({
          error: 'project scope requires a real project (general chat doesn\'t qualify)',
        });
      }
      root = projectSkillsRoot(projectPath);
    } else {
      root = userSkillsRoot();
    }
    const targetDir = path.join(root, inferredSlug);

    // Refuse the obviously broken self-import (target === source).
    if (path.resolve(targetDir) === resolvedSource) {
      return res.status(400).json({
        error: 'Source and target resolve to the same path; pick a different slug or scope.',
      });
    }

    // Conflict: target already exists.
    let exists = false;
    try {
      await fs.access(targetDir);
      exists = true;
    } catch {
      /* not present, good */
    }
    if (exists) {
      if (!force) {
        return res.status(409).json({
          error: `Skill already exists at ${targetDir}. Re-run with force=true to overwrite.`,
        });
      }
      await fs.rm(targetDir, { recursive: true, force: true });
    }

    // Run compliance validation. Hard fails block the import; warnings are
    // returned for the client to surface.
    const validation = await validateFromDisk(resolvedSource);
    if (!validation.ok) {
      return res.status(422).json({
        error: 'Validation failed',
        validation,
      });
    }

    await fs.mkdir(root, { recursive: true });

    if (importMode === 'symlink') {
      // Symlink lets the user keep editing in the source folder; the agent
      // will follow the link when reading SKILL.md.
      await fs.symlink(resolvedSource, targetDir, 'dir');
    } else {
      // Recursive copy. dereference=false preserves symlinks inside the
      // source as symlinks; force=true is safe because we already checked
      // and cleared the target above.
      await fs.cp(resolvedSource, targetDir, {
        recursive: true,
        force: true,
        dereference: false,
        errorOnExist: false,
      });
    }

    const meta = await readSkillMeta(targetDir);
    res.json({
      ok: true,
      mode: importMode,
      scope: wantProject ? 'project' : 'user',
      slug: inferredSlug,
      sourcePath: resolvedSource,
      skillPath: targetDir,
      skill: meta,
      validation,
    });
  } catch (e) {
    console.error('[skills/import]', e);
    res.status(500).json({ error: 'Import failed', message: e.message });
  }
});

// ---------------------------------------------------------------------------
// Compliance / validation
// ---------------------------------------------------------------------------

const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_COUNT = 500;
const RISKY_EXTS = new Set(['.sh', '.bash', '.zsh', '.fish', '.exe', '.bat', '.cmd', '.dll', '.so', '.dylib']);

function pushIf(arr, code, message, extra = {}) {
  arr.push({ code, message, ...extra });
}

// Pure validator. Inputs (one of):
//   { sourcePath: string }          — read the folder from disk
//   { skillMdContent, files }       — files = [{ relativePath, size }]
function validateRequiredFrontmatter(skillMdContent, hardFails, warnings) {
  if (typeof skillMdContent !== 'string' || !skillMdContent.trim()) {
    pushIf(hardFails, 'no_skill_md', 'SKILL.md is empty or missing.');
    return null;
  }
  let parsed;
  try {
    parsed = parseFrontmatter(skillMdContent);
  } catch (e) {
    pushIf(hardFails, 'frontmatter_unparseable', `Frontmatter could not be parsed: ${e.message}`);
    return null;
  }
  const fm = parsed?.data || {};
  if (!fm.name || typeof fm.name !== 'string' || !fm.name.trim()) {
    pushIf(hardFails, 'frontmatter_missing_name', 'Frontmatter is missing required field: name.');
  }
  if (!fm.description || typeof fm.description !== 'string' || !fm.description.trim()) {
    pushIf(hardFails, 'frontmatter_missing_description',
      'Frontmatter is missing required field: description (skill won\'t surface in the slash menu without it).');
  } else {
    const desc = fm.description.trim();
    if (desc.length < 20) {
      pushIf(warnings, 'description_short', `Description is short (${desc.length} chars). Consider expanding for better discovery.`);
    }
    if (desc.length > 1024) {
      pushIf(warnings, 'description_long', `Description is very long (${desc.length} chars). Most slash-menu surfaces truncate this.`);
    }
  }
  return fm;
}

async function validateFromDisk(sourcePath) {
  const hardFails = [];
  const warnings = [];
  let stats = { fileCount: 0, totalBytes: 0 };
  let frontmatter = null;

  let stat;
  try {
    stat = await fs.stat(sourcePath);
  } catch {
    pushIf(hardFails, 'source_missing', `Source path does not exist: ${sourcePath}`);
    return { ok: false, hardFails, warnings, stats, frontmatter };
  }
  if (!stat.isDirectory()) {
    pushIf(hardFails, 'source_not_directory', `Source path is not a directory: ${sourcePath}`);
    return { ok: false, hardFails, warnings, stats, frontmatter };
  }

  const skillMdPath = path.join(sourcePath, 'SKILL.md');
  let skillMdContent = '';
  try {
    skillMdContent = await fs.readFile(skillMdPath, 'utf8');
  } catch {
    pushIf(hardFails, 'no_skill_md', 'Source folder does not contain a SKILL.md at the root.');
    return { ok: false, hardFails, warnings, stats, frontmatter };
  }
  frontmatter = validateRequiredFrontmatter(skillMdContent, hardFails, warnings);

  // Walk the tree, collect stats, run safety checks. Cap at MAX_FILE_COUNT
  // to avoid pathological inputs.
  async function walk(dir, relPrefix) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (stats.fileCount > MAX_FILE_COUNT) return;
      const rel = path.posix.join(relPrefix, entry.name);
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        pushIf(warnings, 'contains_symlink', `Bundle contains a symlink: ${rel}`);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      stats.fileCount += 1;
      try {
        const fileStat = await fs.stat(abs);
        stats.totalBytes += fileStat.size;
        if (fileStat.size > MAX_FILE_BYTES) {
          pushIf(hardFails, 'file_too_large', `File exceeds ${MAX_FILE_BYTES} bytes: ${rel} (${fileStat.size} bytes)`);
        } else if (fileStat.size > 1024 * 1024) {
          pushIf(warnings, 'file_large', `Large file: ${rel} (${(fileStat.size / 1024 / 1024).toFixed(1)} MB)`);
        }
      } catch {
        /* unreadable, skip */
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (RISKY_EXTS.has(ext)) {
        pushIf(warnings, 'risky_extension', `Executable-style file (${ext}): ${rel}`);
      }
    }
  }
  await walk(sourcePath, '');

  if (stats.fileCount > MAX_FILE_COUNT) {
    pushIf(hardFails, 'too_many_files', `Bundle has more than ${MAX_FILE_COUNT} files.`);
  }
  if (stats.totalBytes > MAX_TOTAL_BYTES) {
    pushIf(hardFails, 'total_too_large', `Bundle total size exceeds ${MAX_TOTAL_BYTES} bytes (${stats.totalBytes}).`);
  }

  return { ok: hardFails.length === 0, hardFails, warnings, stats, frontmatter };
}

function validateFromManifest(skillMdContent, files) {
  const hardFails = [];
  const warnings = [];
  let stats = { fileCount: 0, totalBytes: 0 };

  if (!Array.isArray(files)) files = [];
  let hasSkillMd = false;
  for (const f of files) {
    const rel = (f && typeof f.relativePath === 'string') ? f.relativePath : null;
    if (!rel) continue;
    if (rel === 'SKILL.md') hasSkillMd = true;
    if (rel.includes('..') || path.isAbsolute(rel)) {
      pushIf(hardFails, 'unsafe_path', `File path is unsafe: ${rel}`);
      continue;
    }
    const size = Number(f.size) || 0;
    stats.fileCount += 1;
    stats.totalBytes += size;
    if (size > MAX_FILE_BYTES) {
      pushIf(hardFails, 'file_too_large', `File exceeds ${MAX_FILE_BYTES} bytes: ${rel} (${size} bytes)`);
    } else if (size > 1024 * 1024) {
      pushIf(warnings, 'file_large', `Large file: ${rel} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    }
    const ext = path.extname(rel).toLowerCase();
    if (RISKY_EXTS.has(ext)) {
      pushIf(warnings, 'risky_extension', `Executable-style file (${ext}): ${rel}`);
    }
  }
  if (!hasSkillMd) {
    pushIf(hardFails, 'no_skill_md', 'No SKILL.md at the root of the picked folder.');
  }
  if (stats.fileCount > MAX_FILE_COUNT) {
    pushIf(hardFails, 'too_many_files', `Bundle has more than ${MAX_FILE_COUNT} files.`);
  }
  if (stats.totalBytes > MAX_TOTAL_BYTES) {
    pushIf(hardFails, 'total_too_large', `Bundle total size exceeds ${MAX_TOTAL_BYTES} bytes (${stats.totalBytes}).`);
  }

  // Frontmatter checks only run if SKILL.md was provided.
  let frontmatter = null;
  if (hasSkillMd && typeof skillMdContent === 'string') {
    frontmatter = validateRequiredFrontmatter(skillMdContent, hardFails, warnings);
  }

  return { ok: hardFails.length === 0, hardFails, warnings, stats, frontmatter };
}

router.post('/validate', async (req, res) => {
  try {
    const { sourcePath, skillMdContent, files } = req.body || {};
    if (typeof sourcePath === 'string' && sourcePath.trim()) {
      const resolved = path.resolve(expandHome(sourcePath.trim()));
      const result = await validateFromDisk(resolved);
      return res.json({ ...result, sourcePath: resolved });
    }
    if (Array.isArray(files)) {
      return res.json(validateFromManifest(skillMdContent, files));
    }
    return res.status(400).json({
      error: 'Provide either { sourcePath } or { skillMdContent, files: [...] }.',
    });
  } catch (e) {
    console.error('[skills/validate]', e);
    res.status(500).json({ error: 'Validation failed', message: e.message });
  }
});

// ---------------------------------------------------------------------------
// Folder-picker upload (multipart) — for the browser-side folder picker.
// ---------------------------------------------------------------------------

// Each File field is named `files`. The client sends `paths` as a JSON
// string array aligned with the upload order, because multer's req.files[i]
// only carries the leaf basename, not the relative path inside the picked
// folder. (The browser knows webkitRelativePath; we ferry it explicitly.)
router.post('/import-upload', upload.array('files', MAX_FILE_COUNT), async (req, res) => {
  let stagingDir = null;
  try {
    const { slug: requestedSlug, scope, projectPath, force, paths: pathsJson } = req.body || {};
    let paths;
    try {
      paths = JSON.parse(pathsJson || '[]');
    } catch {
      return res.status(400).json({ error: '`paths` must be a JSON array of relative paths matching the file order.' });
    }
    const filesIn = Array.isArray(req.files) ? req.files : [];
    if (filesIn.length === 0) {
      return res.status(400).json({ error: 'No files were uploaded.' });
    }
    if (filesIn.length !== paths.length) {
      return res.status(400).json({
        error: `paths length (${paths.length}) does not match files count (${filesIn.length}).`,
      });
    }

    // Pair them up + run path-safety + size validation.
    const manifest = filesIn.map((f, i) => ({
      relativePath: paths[i],
      size: f.size,
      buffer: f.buffer,
    }));
    let skillMdContent = '';
    for (const m of manifest) {
      if (m.relativePath === 'SKILL.md') {
        skillMdContent = m.buffer.toString('utf8');
        break;
      }
    }
    const validation = validateFromManifest(
      skillMdContent,
      manifest.map((m) => ({ relativePath: m.relativePath, size: m.size })),
    );
    if (!validation.ok) {
      return res.status(422).json({
        error: 'Validation failed',
        validation,
      });
    }

    // Resolve scope + slug.
    const wantProject = scope === 'project';
    if (wantProject && (!projectPath || isGeneralCwd(projectPath))) {
      return res.status(400).json({
        error: 'project scope requires a real project (general chat doesn\'t qualify).',
      });
    }
    const root = wantProject ? projectSkillsRoot(projectPath) : userSkillsRoot();
    const inferredSlug =
      (typeof requestedSlug === 'string' && requestedSlug.trim()) ||
      // Common convention: webkitRelativePath puts the picked folder name
      // as the first path component, so derive slug from that.
      (paths[0] && paths[0].split('/')[0]) ||
      '';
    if (!safeSlug(inferredSlug)) {
      return res.status(400).json({
        error: `Invalid slug "${inferredSlug}". Allowed: [a-zA-Z0-9][a-zA-Z0-9._-]{0,99}, no "..".`,
      });
    }
    const targetDir = path.join(root, inferredSlug);

    // If a folder name prefix is shared by every uploaded path, strip it so
    // the picked folder's contents land at the slug root (not nested twice).
    const stripPrefix = (() => {
      const first = paths[0]?.split('/')?.[0];
      if (!first) return null;
      return paths.every((p) => p.split('/')[0] === first) ? first + '/' : null;
    })();

    // Conflict check.
    let exists = false;
    try {
      await fs.access(targetDir);
      exists = true;
    } catch {
      /* missing → fine */
    }
    if (exists) {
      const isForce = force === 'true' || force === true;
      if (!isForce) {
        return res.status(409).json({
          error: `Skill already exists at ${targetDir}. Re-submit with force=true to overwrite.`,
        });
      }
    }

    // Stage in a tmp dir, then atomically move.
    stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-upload-'));
    for (const m of manifest) {
      const rel = stripPrefix && m.relativePath.startsWith(stripPrefix)
        ? m.relativePath.slice(stripPrefix.length)
        : m.relativePath;
      // Defensive — already validated, but double-check.
      if (rel.includes('..') || path.isAbsolute(rel)) continue;
      const out = path.join(stagingDir, rel);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, m.buffer);
    }
    await fs.mkdir(root, { recursive: true });
    if (exists) {
      await fs.rm(targetDir, { recursive: true, force: true });
    }
    await fs.rename(stagingDir, targetDir);
    stagingDir = null; // moved, don't try to clean up

    const meta = await readSkillMeta(targetDir);
    res.json({
      ok: true,
      mode: 'upload',
      scope: wantProject ? 'project' : 'user',
      slug: inferredSlug,
      skillPath: targetDir,
      skill: meta,
      validation,
    });
  } catch (e) {
    console.error('[skills/import-upload]', e);
    res.status(500).json({ error: 'Upload import failed', message: e.message });
  } finally {
    if (stagingDir) {
      try { await fs.rm(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
});

// ---------------------------------------------------------------------------
// ClawHub: search & install
// ---------------------------------------------------------------------------

router.post('/clawhub/search', async (req, res) => {
  try {
    const { query, registry } = req.body || {};
    if (typeof query !== 'string' || query.trim().length === 0) {
      return res.json({ results: [] });
    }

    const args = ['--no-input'];
    if (registry) args.push('--registry', registry);
    args.push('search', query.trim());

    let stdout = '';
    try {
      const r = await execFileAsync('clawhub', args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      stdout = r.stdout || '';
    } catch (e) {
      if (e.code === 'ENOENT') {
        return res.status(503).json({ error: 'clawhub CLI not found in PATH. Install with `npm install -g clawhub`.' });
      }
      stdout = e.stdout || '';
      if (!stdout) {
        return res.status(500).json({ error: 'clawhub search failed', message: e.message });
      }
    }

    // clawhub search output looks like:
    //   "- Searching\n"
    //   "<slug>  <Display Name>  (<score>)\n"
    // Strip ANSI, drop chrome, parse the rest.
    // eslint-disable-next-line no-control-regex
    const ANSI = /\x1b\[[0-9;]*m/g;
    const results = [];
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.replace(ANSI, '').trim();
      if (!line) continue;
      if (line.startsWith('-') || line.toLowerCase().startsWith('searching')) continue;
      // Match `<slug>  <name>  (<score>)`
      const m = line.match(/^(\S+)\s+(.+?)\s+\(([\d.]+)\)\s*$/);
      if (m) {
        results.push({ slug: m[1], name: m[2], score: parseFloat(m[3]) });
      } else {
        // Fallback: no score, just slug
        const parts = line.split(/\s{2,}/);
        if (parts.length >= 1 && safeSlug(parts[0])) {
          results.push({ slug: parts[0], name: parts[1] || parts[0], score: null });
        }
      }
    }
    res.json({ results });
  } catch (e) {
    console.error('[skills/clawhub/search]', e);
    res.status(500).json({ error: 'Search failed', message: e.message });
  }
});

router.post('/clawhub/install', async (req, res) => {
  try {
    const { slug, version, force, scope, projectPath, registry } = req.body || {};

    if (!safeSlug(slug)) {
      return res.status(400).json({ error: `Invalid slug "${slug}".` });
    }

    const generalCwd = isGeneralCwd(projectPath);
    const effectiveProjectPath = generalCwd ? null : projectPath || null;
    const resolvedScope = scope === 'project' || scope === 'user' ? scope : effectiveProjectPath ? 'project' : 'user';

    let workdir;
    let dir;
    if (resolvedScope === 'project') {
      if (!effectiveProjectPath) {
        return res.status(400).json({ error: 'project scope requires a real project context' });
      }
      workdir = effectiveProjectPath;
      dir = path.join('.claude', 'skills');
    } else {
      workdir = path.join(os.homedir(), '.claude');
      dir = 'skills';
    }
    const installPath = path.join(workdir, dir, slug);

    const args = ['--no-input', '--workdir', workdir, '--dir', dir];
    if (registry) args.push('--registry', registry);
    args.push('install', slug);
    if (version) args.push('--version', version);
    if (force) args.push('--force');

    let stdout = '';
    let stderr = '';
    let runError = null;
    try {
      const r = await execFileAsync('clawhub', args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
      stdout = r.stdout || '';
      stderr = r.stderr || '';
    } catch (e) {
      if (e.code === 'ENOENT') {
        return res.status(503).json({ error: 'clawhub CLI not found in PATH. Install with `npm install -g clawhub`.' });
      }
      runError = e;
      stdout = e.stdout || '';
      stderr = e.stderr || '';
    }

    let installed = false;
    let skill = null;
    try {
      await fs.access(path.join(installPath, 'SKILL.md'));
      installed = true;
      skill = await readSkillMeta(installPath);
      if (skill) skill.scope = resolvedScope;
    } catch {
      /* not installed */
    }

    const needsForce =
      !installed && !force && (stderr || stdout).match(/Use --force to install suspicious/i) !== null;

    res.json({
      ok: installed,
      slug,
      scope: resolvedScope,
      installPath,
      installed,
      skill,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: runError ? (runError.code === undefined ? 1 : runError.code) : 0,
      needsForce,
    });
  } catch (e) {
    console.error('[skills/clawhub/install]', e);
    res.status(500).json({ error: 'Install failed', message: e.message });
  }
});

export default router;
