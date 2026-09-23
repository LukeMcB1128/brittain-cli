// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:tools.js
'use strict';

// Path containment, write guards, and the file tools: read_file,
// get_file_lines, browse_files, write_file, edit_file, apply_patch,
// delete_file, move_file.
//
// Pruned: granted roots outside the project (custom policies are not in v1),
// the PDF and attachment path helpers, and every file tool outside §4.2.

const path = require('path');
const fs = require('fs');
const { applyUnifiedPatch } = require('./apply-patch');

const MAX_TOOL_OUTPUT = 40_000;   // chars of tool output fed back to the model

// Every root a path may legitimately live under. In v1 that is the project
// alone; the list shape is kept so containment reads the same as the source.
function activeRoots(cwd) {
  return [fs.realpathSync(cwd)];
}

function containingRoot(roots, candidate) {
  let best = '';
  for (const root of roots) {
    const rel = path.relative(root, candidate);
    const inside = rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
    if (inside && root.length > best.length) best = root;
  }
  return best;
}

// The real location a path refers to, including a tail that does not exist yet.
//
// Containment cannot be decided lexically. A symlink inside the project can
// point anywhere, and on macOS an ordinary path like /var/... is itself a
// symlink to /private/var/..., so comparing raw strings both lets escapes
// through and rejects legitimate paths. Resolving the nearest existing ancestor
// and re-attaching the remainder settles both cases at once, and keeps new
// files safe rather than only existing ones.
function canonicalize(target) {
  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync(existing), path.relative(existing, target));
  } catch {
    return target;
  }
}

function resolveInside(cwd, p) {
  const roots = activeRoots(cwd);
  const abs = path.resolve(roots[0], p || '.');
  const where = 'the working directory';

  // Two different failures, worth telling apart. A path that never looked
  // contained is a mistake; one that looked fine and resolved elsewhere went
  // through a symlink, and saying so is the difference between "typo" and
  // "something in this project points outside it".
  //
  // The lexical check cannot stand alone in either direction: on macOS an
  // ordinary /var/... path is itself a symlink to /private/var/..., so it
  // reads as outside while being perfectly legitimate. Only the canonical
  // check decides; the lexical one just picks the wording.
  if (!containingRoot(roots, canonicalize(abs))) {
    const lookedInside = !!containingRoot(roots, abs);
    throw new Error(lookedInside
      ? `Path escapes ${where} through a symlink: ${p}`
      : `Path escapes ${where}: ${p}`);
  }
  return abs;
}

function truncate(s) {
  if (s.length <= MAX_TOOL_OUTPUT) return s;
  return s.slice(0, MAX_TOOL_OUTPUT) + `\n...[truncated, ${s.length} chars total]`;
}

function syntaxCheckContent(filePath, code) {
  if (/\.json$/i.test(filePath)) {
    try { JSON.parse(code); return Promise.resolve({ ok: true }); }
    catch (e) { return Promise.resolve({ ok: false, msg: e.message }); }
  }
  if (!/\.(js|mjs|cjs)$/i.test(filePath)) return Promise.resolve({ ok: true, unverified: true });
  try {
    new (require('vm').Script)(code, { filename: filePath });
    return Promise.resolve({ ok: true });
  } catch (e) {
    // vm.Script parses CommonJS only — ES-module syntax (import/export,
    // top-level await) is valid code we just can't verify this way.
    // Skip rather than falsely reject edits in ESM projects.
    if (/Cannot use import statement outside a module|Unexpected token 'export'|await is only valid in async functions and the top level bodies of modules/.test(e.message)) {
      return Promise.resolve({ ok: true, unverified: true });
    }
    return Promise.resolve({ ok: false, msg: e.message });
  }
}

function syntaxCheck(filePath) {
  return syntaxCheckContent(filePath, fs.readFileSync(filePath, 'utf8'));
}

// ---------- degraded-model guards ----------
// Long autonomous runs showed models leaking their inner monologue into code
// comments, truncating good files with shrinking rewrites, and rewriting the
// same file in a futile loop. These heuristics put loud warnings in the tool
// result — the one place a drifting model still reads.
const SELF_TALK = /(?:\/\/|\/\*|#).{0,60}(?:I(?:'m| am) sorry|I apologi[sz]e|my bad|I messed up|Wait, I\b|let me fix|Let's just do this properly|oops|I will now)/i;

function selfTalkNote(content) {
  return SELF_TALK.test(String(content))
    ? '\nWARNING: the content you wrote contains conversational self-talk in comments (e.g. "Wait, I…", "my bad"). You are leaking your reasoning into the file. Read the file back and remove every comment that is commentary about yourself rather than about the code.'
    : '';
}

function shrinkageNote(oldLen, newLen) {
  if (oldLen >= 500 && newLen < oldLen * 0.5) {
    return `\nWARNING: this overwrite SHRANK the file from ${oldLen} to ${newLen} chars. If that was not deliberate you just truncated your own work — read the file NOW and restore what is missing before doing anything else.`;
  }
  return '';
}

// futility breaker: consecutive write_file calls to the same path with nothing
// in between is the signature of a rewrite death-spiral. One tracker per
// runtime rather than module state, so two runtimes never share a count.
function createRewriteTracker() {
  let lastWritePath = '';
  let consecutiveWrites = 0;
  return function trackRewrite(name, p) {
    if (name !== 'write_file') {
      lastWritePath = '';
      consecutiveWrites = 0;
      return '';
    }
    if (p === lastWritePath) consecutiveWrites += 1;
    else { lastWritePath = p; consecutiveWrites = 1; }
    if (consecutiveWrites >= 3) {
      return `\nSTOP: this is consecutive rewrite #${consecutiveWrites} of ${p} with no other action in between. Rewriting again will not help. Call read_file on it, state exactly what is wrong, then make ONE targeted change with edit_file.`;
    }
    return '';
  };
}

// ---------- protected paths (Tier 2) ----------
// Defaults always apply; a `.brittainprotect` file in the project root adds
// project-specific globs (one per line, # comments). Mutation tools refuse
// matches; reads are unaffected (sensitive reads are gated separately).
const DEFAULT_PROTECTED_GLOBS = ['.git/**', '.env', '.env.*', '*.pem', '*.key', '.brittainprotect'];

function loadProtectedGlobs(cwd) {
  const globs = [...DEFAULT_PROTECTED_GLOBS];
  try {
    for (const line of fs.readFileSync(path.join(cwd, '.brittainprotect'), 'utf8').split('\n')) {
      const g = line.trim();
      if (g && !g.startsWith('#')) globs.push(g);
    }
  } catch {}
  return globs;
}

// Like resolveInside, but additionally refuses protected paths. Used by every
// tool that mutates the filesystem.
function resolveForWrite(cwd, p) {
  const abs = resolveInside(cwd, p);
  const roots = activeRoots(cwd);
  const real = canonicalize(abs);
  const base = containingRoot(roots, real) || roots[0];
  const rel = path.relative(base, real).split(path.sep).join('/');
  for (const glob of loadProtectedGlobs(cwd)) {
    const re = globToRegex(glob);
    if (re.test(rel) || re.test(path.basename(rel))) {
      throw new Error(`"${rel}" is protected (matched "${glob}" — defaults + .brittainprotect). Ask the user to change it themselves if it truly needs modification.`);
    }
  }
  return abs;
}

// Recursively visit files, skipping .git and node_modules; unreadable dirs are skipped.
function walkDir(dir, onFile) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(p, onFile);
    else if (e.isFile()) onFile(p);
  }
}

// Convert a glob like "src/**/*.js" to a RegExp (no external deps).
function globToRegex(glob) {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x01')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\x01\//g, '(?:.*/)?')   // "**/" matches zero or more directories
    .replace(/\x01/g, '.*');
  return new RegExp('^' + esc + '$');
}

// ---------- file tools ----------

// CLI addition. A model that guesses a path gets "ENOENT" and guesses again —
// one session tried seven test files that did not exist, one at a time. Say
// what IS there, from the nearest directory that exists.
const MISSING_LISTING_LIMIT = 40;

function missingPathError(cwd, requested, abs) {
  const root = fs.realpathSync(cwd);
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir) && dir.length > root.length) dir = path.dirname(dir);
  const rel = (target) => path.relative(root, target).split(path.sep).join('/') || '.';
  let listing = '';
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => entry.name + (entry.isDirectory() ? '/' : ''));
    const shown = entries.slice(0, MISSING_LISTING_LIMIT).join(', ');
    const more = entries.length > MISSING_LISTING_LIMIT ? `, … (${entries.length - MISSING_LISTING_LIMIT} more)` : '';
    listing = entries.length ? ` ${rel(dir)}/ contains: ${shown}${more}.` : ` ${rel(dir)}/ is empty.`;
  } catch {}
  return `Error: No such file: ${requested}.${listing} Use an existing path, or search_files/browse_files to find the right one — do not guess.`;
}

function readExisting(cwd, requested, read) {
  const p = resolveInside(cwd, requested);
  try {
    return read(p);
  } catch (error) {
    if (error.code === 'ENOENT') return missingPathError(cwd, requested, p);
    throw error;
  }
}

async function readFile(args, cwd) {
  return readExisting(cwd, args.path, (p) => {
    const stat = fs.statSync(p);
    if (stat.size > 2_000_000) return `Error: file too large (${stat.size} bytes)`;
    return truncate(fs.readFileSync(p, 'utf8'));
  });
}

async function getFileLines(args, cwd) {
  return readExisting(cwd, args.path, (p) => {
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    const start = Math.max(0, (args.start || 1) - 1);
    const end = args.end ? Math.min(lines.length, args.end) : Math.min(lines.length, start + 10);
    return truncate(lines.slice(start, end).join('\n')) || '(no lines found)';
  });
}

async function browseFiles(args, cwd) {
  const root = resolveInside(cwd, args.path);
  if (!fs.statSync(root).isDirectory()) return `Error: ${args.path || root} is not a directory.`;
  const maxDepth = Math.min(Math.max(Math.round(Number(args.depth) || 1), 1), 8);
  const maxResults = Math.min(Math.max(Math.round(Number(args.max_results) || 200), 1), 500);
  const fileGlob = args.glob ? globToRegex(String(args.glob)) : null;
  const includeFiles = args.include_files !== false;
  const matchesGlob = (filePath) => {
    if (!fileGlob) return true;
    const rel = path.relative(root, filePath).split(path.sep).join('/');
    return fileGlob.test(rel) || fileGlob.test(path.basename(filePath));
  };
  if (args.sort === 'size') {
    const files = [];
    const collect = (dir, depth) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const candidate = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < maxDepth) collect(candidate, depth + 1);
        else if (entry.isFile() && matchesGlob(candidate)) {
          try { files.push({ path: candidate, size: fs.statSync(candidate).size }); } catch {}
        }
      }
    };
    collect(root, 1);
    return truncate(files.sort((a, b) => b.size - a.size).slice(0, maxResults)
      .map((file) => `${path.relative(cwd, file.path)}: ${file.size} bytes`).join('\n') || '(no files found)');
  }
  const lines = [path.basename(root) + '/'];
  let shownFiles = 0;
  const tree = (dir, prefix, depth) => {
    if (depth > maxDepth || shownFiles >= maxResults) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries = entries.filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules')
      .filter((entry) => entry.isDirectory() || (includeFiles && matchesGlob(path.join(dir, entry.name))))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (let index = 0; index < entries.length && shownFiles < maxResults; index++) {
      const entry = entries[index];
      const last = index === entries.length - 1;
      const child = path.join(dir, entry.name);
      lines.push(prefix + (last ? '└── ' : '├── ') + entry.name + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) tree(child, prefix + (last ? '    ' : '│   '), depth + 1);
      else shownFiles++;
    }
  };
  tree(root, '', 1);
  if (shownFiles >= maxResults) lines.push(`… file result limit reached (${maxResults})`);
  return truncate(lines.join('\n'));
}

async function writeFile(args, cwd, futilityNote = '') {
  const p = resolveForWrite(cwd, args.path);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const content = args.content ?? '';
  let oldLen = 0;
  try { oldLen = fs.statSync(p).size; } catch {}
  const tmp = p + '.~check' + path.extname(p);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    const check = await syntaxCheck(tmp);
    if (!check.ok) return `Write rejected — syntax error (original file unchanged):\n${check.msg}` + futilityNote;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  fs.writeFileSync(p, content, 'utf8');
  return `Wrote ${content.length} chars to ${p}\nSyntax check: OK`
    + shrinkageNote(oldLen, Buffer.byteLength(content, 'utf8'))
    + selfTalkNote(content)
    + futilityNote;
}

async function editFile(args, cwd) {
  const p = resolveForWrite(cwd, args.path);
  const content = fs.readFileSync(p, 'utf8');
  const oldS = String(args.old_string ?? '');
  const newS = String(args.new_string ?? '');
  if (!oldS) return 'Error: old_string must not be empty.';
  if (oldS === newS) return 'Error: old_string and new_string are identical.';
  // Exact match first; regex mode keeps global replacement under the same
  // guarded editing path, while literal mode can normalize trailing space.
  const trimLines = s => s.split('\n').map(l => l.trimEnd()).join('\n');
  let updated;
  let count = 0;
  let fuzzy = false;
  if (args.is_regex) {
    let flags = String(args.flags || '');
    if (args.replace_all && !flags.includes('g')) flags += 'g';
    try {
      const countFlags = flags.replace(/g/g, '') + 'g';
      count = [...content.matchAll(new RegExp(oldS, countFlags))].length;
      if (!count) return `Error: old_string regex not found in ${p}.`;
      if (count > 1 && !args.replace_all) return `Error: old_string regex appears ${count} times in ${p}. Include more context or set replace_all to true.`;
      updated = content.replace(new RegExp(oldS, flags), newS);
    } catch (err) {
      return `Error: invalid regular expression: ${err.message}`;
    }
  } else {
    count = content.split(oldS).length - 1;
  }
  if (!args.is_regex && count === 0) {
    const normContent = trimLines(content);
    const normOld = trimLines(oldS);
    count = normContent.split(normOld).length - 1;
    if (count === 0) return `Error: old_string not found in ${p}. Read the file and copy the exact text, including indentation.`;
    if (count > 1 && !args.replace_all) return `Error: old_string appears ${count} times (after whitespace normalization) in ${p}. Include more surrounding lines to make it unique, or set replace_all to true.`;
    updated = normContent.split(normOld).join(trimLines(newS));
    fuzzy = true;
  } else if (!args.is_regex) {
    if (count > 1 && !args.replace_all) return `Error: old_string appears ${count} times in ${p}. Include more surrounding lines to make it unique, or set replace_all to true.`;
    updated = content.split(oldS).join(newS);
  }
  if (updated.length > content.length * 3 + 100_000) {
    return `Error: this edit would grow the file from ${content.length} to ${updated.length} chars — refusing.`;
  }
  const tmp = p + '.~check' + path.extname(p);
  try {
    fs.writeFileSync(tmp, updated, 'utf8');
    const check = await syntaxCheck(tmp);
    if (!check.ok) return `Edit rejected — syntax error in new_string (original file unchanged):\n${check.msg}\nFix your new_string and try again.`;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  fs.writeFileSync(p, updated, 'utf8');
  return `Edited ${p}: replaced ${count} occurrence(s)${fuzzy ? ' (matched after trailing-whitespace normalization)' : ''}.\nSyntax check: OK` + selfTalkNote(newS);
}

async function applyPatch(args, cwd) {
  try {
    const result = await applyUnifiedPatch({
      cwd,
      patch: args.patch,
      dryRun: args.dry_run,
      resolveForWrite,
      checkSyntax: syntaxCheckContent,
    });
    return truncate(JSON.stringify(result, null, 2));
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

async function deleteFile(args, cwd) {
  const p = resolveForWrite(cwd, args.path);
  if (!fs.existsSync(p)) return `File not found: ${p}`;
  fs.unlinkSync(p);
  return `Deleted file ${p}`;
}

async function moveFile(args, cwd) {
  const source = resolveForWrite(cwd, args.source);
  const dest = resolveForWrite(cwd, args.destination);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(source, dest);
  return `Moved ${source} to ${dest}`;
}

module.exports = {
  MAX_TOOL_OUTPUT,
  SELF_TALK,
  DEFAULT_PROTECTED_GLOBS,
  resolveInside,
  resolveForWrite,
  canonicalize,
  truncate,
  syntaxCheck,
  syntaxCheckContent,
  selfTalkNote,
  shrinkageNote,
  createRewriteTracker,
  walkDir,
  globToRegex,
  handlers: {
    read_file: readFile,
    get_file_lines: getFileLines,
    browse_files: browseFiles,
    write_file: writeFile,
    edit_file: editFile,
    apply_patch: applyPatch,
    delete_file: deleteFile,
    move_file: moveFile,
  },
};
