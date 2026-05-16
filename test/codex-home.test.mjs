import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCodexHomeCandidates, resolveCodexDataPaths } from '../src/codex-home.mjs';

const root = path.join(tmpdir(), `cdxusage-home-${process.pid}`);
await rm(root, { recursive: true, force: true });

const homeDir = path.join(root, 'home');
const cwd = path.join(root, 'work', 'project', 'portable');
const codexHome = path.join(homeDir, '.codex');
await mkdir(path.join(codexHome, 'sessions'), { recursive: true });

const resolved = await resolveCodexDataPaths({
  env: {},
  homeDir,
  cwd,
});
assert.equal(resolved.codexHome, codexHome);
assert.equal(resolved.codexHomeSource, 'home/.codex');
assert.equal(resolved.sessionsDir, path.join(codexHome, 'sessions'));

const envHome = path.join(root, 'env-codex');
const envResolved = await resolveCodexDataPaths({
  env: { CODEX_HOME: envHome },
  homeDir,
  cwd,
});
assert.equal(envResolved.codexHome, envHome);
assert.equal(envResolved.codexHomeSource, 'CODEX_HOME');

const parentCodex = path.join(root, 'work', '.codex');
await mkdir(path.join(parentCodex, 'sessions'), { recursive: true });
const parentResolved = await resolveCodexDataPaths({
  env: {},
  homeDir: path.join(root, 'empty-home'),
  cwd,
});
assert.equal(parentResolved.codexHome, parentCodex);
assert.equal(parentResolved.codexHomeSource, 'parent/.codex');

const appData = path.join(root, 'AppData', 'Roaming');
const appDataCodex = path.join(appData, 'Codex');
await mkdir(appDataCodex, { recursive: true });
await writeFile(path.join(appDataCodex, 'config.toml'), 'service_tier = "fast"\n');
const appDataResolved = await resolveCodexDataPaths({
  env: { APPDATA: appData },
  homeDir: path.join(root, 'no-config-home'),
  cwd: path.join(root, 'no-project'),
});
assert.equal(appDataResolved.codexHome, appDataCodex);
assert.equal(appDataResolved.codexHomeSource, 'APPDATA/Codex');

const explicitSessions = path.join(root, 'custom', 'sessions');
const explicitResolved = await resolveCodexDataPaths({
  env: {},
  homeDir,
  cwd,
  sessionsDir: explicitSessions,
});
assert.equal(explicitResolved.codexHome, path.dirname(explicitSessions));
assert.equal(explicitResolved.sessionsDir, explicitSessions);
assert.equal(explicitResolved.sessionsDirSource, '--sessions-dir');

const candidates = buildCodexHomeCandidates({
  env: { HOME: homeDir, USERPROFILE: homeDir },
  homeDir,
  cwd,
});
assert.equal(candidates.filter((candidate) => candidate.path === codexHome).length, 1);
if (process.platform !== 'win32') {
  const wslCandidates = buildCodexHomeCandidates({
    env: { USERPROFILE: 'C:\\Users\\Alice' },
    homeDir,
    cwd,
  });
  assert.ok(wslCandidates.some((candidate) => candidate.path === '/mnt/c/Users/Alice/.codex'));
}

await rm(root, { recursive: true, force: true });
console.log('codex-home ok');
