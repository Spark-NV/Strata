/**
 * Browsing the PC's folders and making new ones, for a page or a phone that cannot open the PC's own folder window
 * (the iPhone app, the app opened from another computer, a Linux desktop with no chooser).
 *
 *   listFolder(dir)        what is in a folder: its folders first, then (when asked) its files
 *   makeFolder(parent, n)  a new, empty folder inside an existing one
 *   folderPlaces()         where to start: home, Desktop, Documents, Downloads, the Strata workspace, the drives
 *
 * Reading is allowed anywhere the host can read; a Code or Vibe chat can run commands, so a folder list shows nothing more.
 * Making a folder follows the rule for a chat's folder (refusedFolder): never in a system folder or at a drive's top.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { refusedFolder } from './chat-files.mjs';
import { INSTRUCTION_FILES } from './projects.mjs';

const LIMIT = 2000;
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
const nameOf = p => basename(p) || p;
/** Folders and files sorted the way a person reads them: case does not matter and "file10" comes after "file9". */
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** An absolute path, or the person's home folder when none is given. Anything else is refused rather than guessed. */
export function folderPath(value, { platform = process.platform, home = homedir() } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return home;
  if (text === '~' || text.startsWith('~/')) return resolve(home, text.slice(2));
  if (!isAbsolute(text)) throw fail(400, 'Give the whole path of the folder, starting with ' + (platform === 'win32' ? 'a drive (C:\\).' : '/.'), 'not-absolute');
  return resolve(text);
}

/** Why a new folder's name is not usable, or null. */
export function badFolderName(value, platform = process.platform) {
  const name = String(value ?? '');
  if (!name.trim()) return 'Give the new folder a name.';
  if (name !== name.trim()) return 'A folder name cannot start or end with a space.';
  if (name === '.' || name === '..') return 'That name is not allowed for a folder.';
  if (name.includes('/') || name.includes('\0')) return 'A folder name cannot contain "/".';
  if (Buffer.byteLength(name) > 255) return 'That name is too long.';
  if (platform === 'win32') {
    if (/[\\<>:"|?*\x00-\x1f]/.test(name)) return 'A folder name cannot contain \\ < > : " | ? *.';
    if (/[. ]$/.test(name)) return 'A folder name cannot end with a dot.';
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) return 'That name is kept for Windows itself.';
  }
  return null;
}

const project = dir => existsSync(join(dir, '.git')) || INSTRUCTION_FILES.some(f => existsSync(join(dir, f)));

function readError(e, dir) {
  if (e?.status) return e;
  if (e?.code === 'ENOENT') return fail(404, "That folder doesn't exist.", 'missing');
  if (e?.code === 'ENOTDIR') return fail(400, `${nameOf(dir)} is a file, not a folder.`, 'not-folder');
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return fail(403, "Strata isn't allowed to open that folder.", 'not-allowed');
  return fail(400, e?.message ?? String(e));
}

/**
 * The folder's contents. `files` adds the files (folders always come first); `hidden` adds names that start with a dot.
 * At most `limit` entries; `truncated` says when there were more.
 */
export function listFolder(dir, { files = false, hidden = false, limit = LIMIT } = {}) {
  let entries;
  try {
    if (!statSync(dir).isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) { throw readError(e, dir); }
  const folders = [], others = [];
  let hiddenCount = 0;
  for (const entry of entries) {
    const isHidden = entry.name.startsWith('.');
    if (isHidden) hiddenCount += 1;
    if (isHidden && !hidden) continue;
    const path = join(dir, entry.name);
    let kind = entry.isDirectory() ? 'folder' : entry.isFile() ? 'file' : null;
    // A link is shown as what it points to; a broken one is left out.
    if (entry.isSymbolicLink()) { try { const s = statSync(path); kind = s.isDirectory() ? 'folder' : s.isFile() ? 'file' : null; } catch { kind = null; } }
    if (kind === 'folder') folders.push({ name: entry.name, path, kind, hidden: isHidden, link: entry.isSymbolicLink() });
    else if (kind === 'file' && files) others.push({ name: entry.name, path, kind, hidden: isHidden, link: entry.isSymbolicLink() });
  }
  folders.sort(byName); others.sort(byName);
  const shown = [...folders, ...others].slice(0, limit);
  for (const item of shown) {
    if (item.kind === 'folder') item.project = project(item.path);
    else { try { const s = statSync(item.path); item.size = s.size; item.modifiedAt = s.mtime.toISOString(); } catch { /* gone meanwhile */ } }
  }
  const parent = dirname(dir);
  return {
    path: dir,
    name: nameOf(dir),
    parent: parent === dir ? null : parent,
    project: project(dir),
    // Can this folder be a chat's folder, and can a new folder be made in it? A sentence says why not.
    refused: refusedFolder(dir),
    entries: shown,
    folders: folders.length,
    files: files ? others.length : undefined,
    hiddenCount,
    truncated: folders.length + others.length > shown.length,
  };
}

/** A new, empty folder `name` inside `parent`. Never makes the parents, never replaces anything. */
export function makeFolder(parent, name, { platform = process.platform } = {}) {
  const why = badFolderName(name, platform);
  if (why) throw fail(400, why, 'bad-name');
  if (!isDir(parent)) throw fail(404, existsSync(parent) ? `${nameOf(parent)} is a file, not a folder.` : "That folder doesn't exist.", 'missing');
  const target = join(parent, name);
  const refused = refusedFolder(target) ?? refusedFolder(parent);
  if (refused) throw fail(403, refused.replace('Choose one of your own folders.', 'Make it inside one of your own folders.'), 'folder-refused');
  try { mkdirSync(target); }
  catch (e) {
    if (e?.code === 'EEXIST') throw fail(409, `There is already something called "${name}" in ${nameOf(parent)}.`, 'exists');
    if (e?.code === 'EACCES' || e?.code === 'EPERM' || e?.code === 'EROFS') throw fail(403, `Strata isn't allowed to make a folder in ${nameOf(parent)}.`, 'not-allowed');
    throw fail(400, e?.message ?? String(e));
  }
  return { path: target, name, exists: true };
}

/** Where to start browsing: the person's usual folders that exist, Strata's workspace, and the top of each drive. */
export function folderPlaces({ home = homedir(), workspace = null, platform = process.platform } = {}) {
  const places = [{ name: 'Home', path: home, kind: 'home' }];
  for (const name of ['Desktop', 'Documents', 'Downloads', 'Projects']) {
    const path = join(home, name);
    if (isDir(path)) places.push({ name, path, kind: name.toLowerCase() });
  }
  if (workspace && isDir(workspace) && !places.some(p => p.path === workspace)) places.push({ name: 'Strata workspace', path: workspace, kind: 'workspace' });
  if (platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { const path = `${letter}:\\`; if (isDir(path)) places.push({ name: `${letter}:`, path, kind: 'drive' }); }
  } else places.push({ name: 'Computer', path: '/', kind: 'drive' });
  return places;
}
