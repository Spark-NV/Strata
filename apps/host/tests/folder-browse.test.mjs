// Browsing the PC's folders and making a new one (server/folder-browse.mjs), for the iPhone app and a page opened from away.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { badFolderName, folderPath, folderPlaces, listFolder, makeFolder } from '../server/folder-browse.mjs';

function tree(t) {
  const dir = mkdtempSync(join(tmpdir(), 'strata-folders-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['beta', 'Alpha', 'app10', 'app9', '.secret', 'repo', 'agents']) mkdirSync(join(dir, name));
  mkdirSync(join(dir, 'repo', '.git'));
  writeFileSync(join(dir, 'agents', 'AGENTS.md'), '# x');
  writeFileSync(join(dir, 'notes.txt'), 'hello');
  writeFileSync(join(dir, '.env'), 'x');
  symlinkSync(join(dir, 'beta'), join(dir, 'link-to-beta'));
  symlinkSync(join(dir, 'gone'), join(dir, 'broken'));
  return dir;
}

test('a folder lists its folders first, in reading order, without hidden ones or files unless asked', t => {
  const dir = tree(t);
  const plain = listFolder(dir);
  assert.deepEqual(plain.entries.map(e => e.name), ['agents', 'Alpha', 'app9', 'app10', 'beta', 'link-to-beta', 'repo']);
  assert.equal(plain.path, dir);
  assert.equal(plain.parent, join(dir, '..'));
  assert.equal(plain.hiddenCount, 2);
  assert.equal(plain.truncated, false);
  assert.equal(plain.refused, null);
  const byName = Object.fromEntries(plain.entries.map(e => [e.name, e]));
  assert.equal(byName.repo.project, true, 'a git checkout is a project');
  assert.equal(byName.agents.project, true, 'a folder with AGENTS.md is a project');
  assert.equal(byName.beta.project, false);
  assert.equal(byName['link-to-beta'].link, true);
  assert.equal(byName.broken, undefined, 'a broken link is left out');

  const all = listFolder(dir, { files: true, hidden: true });
  assert.deepEqual(all.entries.map(e => e.name), ['.secret', 'agents', 'Alpha', 'app9', 'app10', 'beta', 'link-to-beta', 'repo', '.env', 'notes.txt']);
  const notes = all.entries.find(e => e.name === 'notes.txt');
  assert.equal(notes.kind, 'file');
  assert.equal(notes.size, 5);
  assert.match(notes.modifiedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(all.files, 2);

  const few = listFolder(dir, { limit: 2 });
  assert.equal(few.entries.length, 2);
  assert.equal(few.truncated, true);
});

test('a missing folder, a file and a system folder say so plainly', t => {
  const dir = tree(t);
  assert.throws(() => listFolder(join(dir, 'nope')), e => e.status === 404 && /doesn't exist/.test(e.message));
  assert.throws(() => listFolder(join(dir, 'notes.txt')), e => e.status === 400 && /is a file/.test(e.message));
  if (process.platform !== 'win32') {
    assert.match(listFolder('/etc').refused, /system folder/, 'a system folder can be looked at but not chosen');
    assert.equal(listFolder('/').parent, null);
  }
});

test('paths: empty is home, ~ is home, a relative path is refused', () => {
  assert.equal(folderPath('', { home: '/home/me' }), '/home/me');
  assert.equal(folderPath('  ', { home: '/home/me' }), '/home/me');
  assert.equal(folderPath('~', { home: '/home/me' }), '/home/me');
  assert.equal(folderPath('~/Projects', { home: '/home/me' }), '/home/me/Projects');
  assert.equal(folderPath('/home/me/a/../b/'), '/home/me/b');
  assert.throws(() => folderPath('Projects'), e => e.status === 400 && e.code === 'not-absolute');
});

test('a new folder: made once, never over something, never with a bad name, never in a system folder', t => {
  const dir = tree(t);
  const made = makeFolder(dir, 'My App');
  assert.deepEqual(made, { path: join(dir, 'My App'), name: 'My App', exists: true });
  assert.equal(statSync(made.path).isDirectory(), true);
  assert.equal(listFolder(made.path).entries.length, 0);
  assert.throws(() => makeFolder(dir, 'My App'), e => e.status === 409 && e.code === 'exists');
  assert.throws(() => makeFolder(dir, 'notes.txt'), e => e.status === 409);
  assert.throws(() => makeFolder(join(dir, 'nope'), 'x'), e => e.status === 404);
  assert.throws(() => makeFolder(join(dir, 'notes.txt'), 'x'), e => e.status === 404 && /is a file/.test(e.message));
  for (const name of ['', '  ', '.', '..', 'a/b', '../escape', ' lead', 'trail ', 'x'.repeat(256), 'nul\0']) {
    assert.throws(() => makeFolder(dir, name), e => e.status === 400 && e.code === 'bad-name', JSON.stringify(name));
  }
  if (process.platform !== 'win32') {
    assert.throws(() => makeFolder('/etc', 'strata-test'), e => e.status === 403 && /system folder/.test(e.message));
    assert.throws(() => makeFolder('/usr/local', 'strata-test'), e => e.status === 403);
  }
});

test('Windows names: the reserved ones and characters Windows refuses', () => {
  for (const name of ['a:b', 'a?', 'CON', 'com1.txt', 'dot.', 'a\\b']) assert.ok(badFolderName(name, 'win32'), name);
  assert.equal(badFolderName('My Project', 'win32'), null);
  assert.equal(badFolderName('a:b', 'linux'), null, 'Linux allows it');
});

test('places: home first, the usual folders that exist, the workspace, then the computer', t => {
  const home = mkdtempSync(join(tmpdir(), 'strata-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'Documents')); mkdirSync(join(home, 'Projects'));
  const workspace = join(home, 'Documents', 'Strata');
  mkdirSync(workspace);
  const places = folderPlaces({ home, workspace, platform: 'linux' });
  assert.deepEqual(places.map(p => p.kind), ['home', 'documents', 'projects', 'workspace', 'drive']);
  assert.equal(places.at(-1).path, '/');
});
