// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/tools/apply-patch.js
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_PATCH_CHARS = 1_000_000;
const MAX_PATCH_FILES = 100;
const MAX_SOURCE_BYTES = 5_000_000;

function parsePatchPath(value) {
  let raw = String(value || '').trim();
  if (raw.startsWith('"')) {
    try { raw = JSON.parse(raw); } catch { throw new Error(`Invalid quoted patch path: ${raw}`); }
  } else {
    raw = raw.split('\t')[0];
  }
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) raw = raw.slice(2);
  if (!raw) throw new Error('Patch path must not be empty.');
  return raw;
}

function parseUnifiedPatch(value) {
  const patch = String(value || '');
  if (!patch.trim()) throw new Error('patch must not be empty.');
  if (patch.length > MAX_PATCH_CHARS) throw new Error(`patch exceeds the ${MAX_PATCH_CHARS}-character limit.`);
  if (/^GIT binary patch$/m.test(patch) || /^Binary files /m.test(patch)) throw new Error('Binary patches are not supported.');
  if (/^(?:rename|copy) (?:from|to) /m.test(patch)) throw new Error('Rename and copy patches are not supported.');

  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const files = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].startsWith('--- ')) { index += 1; continue; }
    const oldPath = parsePatchPath(lines[index].slice(4));
    index += 1;
    if (index >= lines.length || !lines[index].startsWith('+++ ')) throw new Error('Each --- file header must be followed by a +++ file header.');
    const newPath = parsePatchPath(lines[index].slice(4));
    index += 1;
    if (oldPath === null && newPath === null) throw new Error('A patch cannot use /dev/null for both paths.');
    if (oldPath && newPath && oldPath !== newPath) throw new Error('File renames are not supported in apply_patch.');
    const hunks = [];
    while (index < lines.length) {
      if (lines[index].startsWith('diff --git ') || lines[index].startsWith('--- ')) break;
      if (!lines[index].startsWith('@@ ')) { index += 1; continue; }
      const header = lines[index];
      const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) throw new Error(`Invalid hunk header: ${header}`);
      const hunk = {
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      index += 1;
      while (index < lines.length) {
        const line = lines[index];
        if (line.startsWith('@@ ') || line.startsWith('diff --git ') || line.startsWith('--- ')) break;
        if (line === '\\ No newline at end of file') {
          if (!hunk.lines.length) throw new Error('A no-newline marker must follow a patch line.');
          hunk.lines[hunk.lines.length - 1].noNewline = true;
          index += 1;
          continue;
        }
        if (!/^[ +\-]/.test(line)) {
          if (line === '' && index === lines.length - 1) { index += 1; break; }
          throw new Error(`Invalid hunk line: ${line}`);
        }
        hunk.lines.push({ type: line[0], text: line.slice(1), noNewline: false });
        index += 1;
      }
      const oldCount = hunk.lines.filter((line) => line.type !== '+').length;
      const newCount = hunk.lines.filter((line) => line.type !== '-').length;
      if (oldCount !== hunk.oldCount || newCount !== hunk.newCount) {
        throw new Error(`Hunk count mismatch in ${oldPath || newPath}: header says -${hunk.oldCount}/+${hunk.newCount}, content has -${oldCount}/+${newCount}.`);
      }
      hunks.push(hunk);
    }
    if (!hunks.length) throw new Error(`Patch for ${oldPath || newPath} has no hunks.`);
    files.push({ oldPath, newPath, path: newPath || oldPath, hunks });
    if (files.length > MAX_PATCH_FILES) throw new Error(`patch exceeds the ${MAX_PATCH_FILES}-file limit.`);
  }
  if (!files.length) throw new Error('No unified diff file headers were found.');
  const duplicate = files.find((file, position) => files.findIndex((candidate) => candidate.path === file.path) !== position);
  if (duplicate) throw new Error(`Patch contains duplicate file sections for ${duplicate.path}.`);
  return files;
}

function splitContent(content) {
  if (content === '') return { lines: [], finalNewline: false };
  const finalNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
}

function applyHunks(content, file) {
  const source = splitContent(content);
  const output = [];
  let cursor = 0;
  let finalNewline = source.finalNewline;
  for (const hunk of file.hunks) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (start < cursor || start > source.lines.length) throw new Error(`Hunk starts outside ${file.path} at old line ${hunk.oldStart}.`);
    output.push(...source.lines.slice(cursor, start));
    cursor = start;
    let newSideHasNoNewline = false;
    for (const line of hunk.lines) {
      if (line.type === ' ' || line.type === '-') {
        if (source.lines[cursor] !== line.text) {
          throw new Error(`Hunk does not match ${file.path} at old line ${cursor + 1}. Expected ${JSON.stringify(line.text)}, found ${JSON.stringify(source.lines[cursor] ?? '(end of file)')}.`);
        }
        if (line.type === ' ') output.push(line.text);
        cursor += 1;
      } else {
        output.push(line.text);
      }
      if (line.noNewline && line.type !== '-') newSideHasNoNewline = true;
    }
    if (cursor === source.lines.length) finalNewline = !newSideHasNoNewline;
  }
  output.push(...source.lines.slice(cursor));
  return output.length ? output.join('\n') + (finalNewline ? '\n' : '') : '';
}

async function preparePatch({ cwd, patch, resolveForWrite, checkSyntax }) {
  const sections = parseUnifiedPatch(patch);
  const prepared = [];
  for (const section of sections) {
    const filePath = resolveForWrite(cwd, section.path);
    const exists = fs.existsSync(filePath);
    if (section.oldPath === null && exists) throw new Error(`Cannot create ${section.path}: the file already exists.`);
    if (section.oldPath !== null && !exists) throw new Error(`Cannot patch ${section.path}: the file does not exist.`);
    let original = '';
    let mode = 0o644;
    if (exists) {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error(`Cannot patch ${section.path}: it is not a regular file.`);
      if (stat.size > MAX_SOURCE_BYTES) throw new Error(`${section.path} exceeds the ${MAX_SOURCE_BYTES}-byte source limit.`);
      original = fs.readFileSync(filePath, 'utf8');
      if (original.includes('\0')) throw new Error(`Cannot patch binary file ${section.path}.`);
      mode = stat.mode;
    }
    const updated = applyHunks(original, section);
    if (section.newPath === null && updated !== '') throw new Error(`Delete patch for ${section.path} does not remove all content.`);
    if (section.newPath !== null && updated === original) throw new Error(`Patch does not change ${section.path}.`);
    const syntax = section.newPath === null
      ? { ok: true, skipped: true, reason: 'file deleted' }
      : await checkSyntax(filePath, updated);
    if (!syntax.ok) throw new Error(`Patch rejected: syntax error in ${section.path}: ${syntax.msg}`);
    prepared.push({
      path: section.path,
      filePath,
      original,
      updated: section.newPath === null ? null : updated,
      existed: exists,
      mode,
      operation: section.oldPath === null ? 'create' : section.newPath === null ? 'delete' : 'modify',
      syntax,
    });
  }
  return prepared;
}

function rollbackFiles(files) {
  for (const file of [...files].reverse()) {
    try {
      if (file.installed && fs.existsSync(file.filePath)) fs.unlinkSync(file.filePath);
      if (file.backedUp && file.backupPath && fs.existsSync(file.backupPath)) fs.renameSync(file.backupPath, file.filePath);
    } catch {}
    try { if (file.tempPath && fs.existsSync(file.tempPath)) fs.unlinkSync(file.tempPath); } catch {}
  }
}

async function applyUnifiedPatch({ cwd, patch, dryRun = true, resolveForWrite, checkSyntax }) {
  const prepared = await preparePatch({ cwd, patch, resolveForWrite, checkSyntax });
  const summary = prepared.map((file) => ({
    path: file.path,
    operation: file.operation,
    old_chars: file.original.length,
    new_chars: file.updated === null ? 0 : file.updated.length,
    syntax: file.syntax.unverified ? 'unverified' : file.syntax.skipped ? 'skipped' : 'ok',
  }));
  if (dryRun !== false) return { dry_run: true, applied: false, files: summary };

  const token = crypto.randomBytes(8).toString('hex');
  try {
    for (const file of prepared) {
      fs.mkdirSync(path.dirname(file.filePath), { recursive: true });
      file.backupPath = `${file.filePath}.brittain-backup-${token}`;
      if (file.updated !== null) {
        file.tempPath = `${file.filePath}.brittain-patch-${token}`;
        fs.writeFileSync(file.tempPath, file.updated, { encoding: 'utf8', mode: file.mode });
      }
    }
    for (const file of prepared) {
      if (file.existed) {
        fs.renameSync(file.filePath, file.backupPath);
        file.backedUp = true;
      }
      if (file.updated !== null) {
        fs.renameSync(file.tempPath, file.filePath);
        file.installed = true;
      }
    }
  } catch (err) {
    rollbackFiles(prepared);
    throw new Error(`Atomic patch failed and was rolled back: ${err.message}`);
  }
  for (const file of prepared) {
    try { if (file.backupPath && fs.existsSync(file.backupPath)) fs.unlinkSync(file.backupPath); } catch {}
  }
  return { dry_run: false, applied: true, files: summary };
}

module.exports = {
  applyHunks,
  applyUnifiedPatch,
  parseUnifiedPatch,
};
