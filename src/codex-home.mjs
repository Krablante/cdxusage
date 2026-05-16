import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export async function resolveCodexDataPaths(options = {}) {
  const sessionsDir = options.sessionsDir ? resolveUserPath(options.sessionsDir, options) : null;
  if (options.codexHome) {
    const codexHome = resolveUserPath(options.codexHome, options);
    return {
      codexHome,
      codexHomeSource: '--codex-home',
      sessionsDir: sessionsDir ?? path.join(codexHome, 'sessions'),
      sessionsDirSource: sessionsDir ? '--sessions-dir' : 'codex-home',
      candidatesChecked: 1,
    };
  }

  const env = options.env ?? process.env;
  if (env.CODEX_HOME) {
    const codexHome = resolveUserPath(env.CODEX_HOME, options);
    return {
      codexHome,
      codexHomeSource: 'CODEX_HOME',
      sessionsDir: sessionsDir ?? path.join(codexHome, 'sessions'),
      sessionsDirSource: sessionsDir ? '--sessions-dir' : 'codex-home',
      candidatesChecked: 1,
    };
  }

  if (sessionsDir) {
    return {
      codexHome: inferCodexHomeFromSessionsDir(sessionsDir),
      codexHomeSource: 'sessions-dir-parent',
      sessionsDir,
      sessionsDirSource: '--sessions-dir',
      candidatesChecked: 0,
    };
  }

  const candidates = buildCodexHomeCandidates(options);
  const selected = await selectBestCandidate(candidates);
  return {
    codexHome: selected.path,
    codexHomeSource: selected.source,
    sessionsDir: path.join(selected.path, 'sessions'),
    sessionsDirSource: 'codex-home',
    candidatesChecked: candidates.length,
  };
}

export function buildCodexHomeCandidates(options = {}) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const resolvedHome = path.resolve(homeDir);
  const candidates = [];

  addCandidate(candidates, path.join(cwd, '.codex'), 'cwd/.codex', options);
  for (const parent of parentDirectories(cwd)) {
    if (path.resolve(parent) === resolvedHome) {
      continue;
    }
    addCandidate(candidates, path.join(parent, '.codex'), 'parent/.codex', options);
  }
  addCandidate(candidates, path.join(homeDir, '.codex'), 'home/.codex', options);
  addCandidate(candidates, env.HOME ? path.join(env.HOME, '.codex') : null, 'HOME/.codex', options);
  addCandidate(candidates, env.USERPROFILE ? path.join(env.USERPROFILE, '.codex') : null, 'USERPROFILE/.codex', options);
  addCandidate(candidates, env.APPDATA ? path.join(env.APPDATA, 'Codex') : null, 'APPDATA/Codex', options);
  addCandidate(candidates, env.APPDATA ? path.join(env.APPDATA, 'codex') : null, 'APPDATA/codex', options);
  addCandidate(candidates, env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Codex') : null, 'LOCALAPPDATA/Codex', options);
  addCandidate(candidates, env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'codex') : null, 'LOCALAPPDATA/codex', options);

  return dedupeCandidates(candidates);
}

export function defaultCodexHome(options = {}) {
  return path.join(options.homeDir ?? homedir(), '.codex');
}

function addCandidate(candidates, value, source, options) {
  if (!value) {
    return;
  }
  candidates.push({ path: resolveUserPath(value, options), source });
  const wslPath = windowsPathToWslPath(value);
  if (wslPath) {
    candidates.push({ path: resolveUserPath(wslPath, options), source: `${source}:wsl` });
  }
}

function resolveUserPath(value, options = {}) {
  const homeDir = options.homeDir ?? homedir();
  const expanded = expandHomePath(String(value).trim(), homeDir);
  return path.resolve(windowsPathToWslPath(expanded) ?? expanded);
}

function expandHomePath(value, homeDir) {
  if (value === '~') {
    return homeDir;
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

function windowsPathToWslPath(value) {
  const normalized = String(value).trim();
  const match = normalized.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match || process.platform === 'win32') {
    return null;
  }
  const drive = match[1].toLowerCase();
  const rest = match[2].replaceAll('\\', '/');
  return `/mnt/${drive}/${rest}`;
}

function parentDirectories(start) {
  const out = [];
  let current = path.resolve(start);
  for (let depth = 0; depth < 3; depth += 1) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    out.push(parent);
    current = parent;
  }
  return out;
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    const key = path.normalize(candidate.path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

async function selectBestCandidate(candidates) {
  let best = null;
  for (const candidate of candidates) {
    const score = await scoreCandidate(candidate.path);
    if (!best || score > best.score) {
      best = { ...candidate, score };
    }
    if (score >= 3) {
      break;
    }
  }
  return best ?? { path: defaultCodexHome(), source: 'home/.codex', score: 0 };
}

async function scoreCandidate(codexHome) {
  if (await isDirectory(path.join(codexHome, 'sessions'))) {
    return 3;
  }
  if (await isFile(path.join(codexHome, 'config.toml'))) {
    return 2;
  }
  if (await isDirectory(codexHome)) {
    return 1;
  }
  return 0;
}

async function isDirectory(file) {
  try {
    return (await stat(file)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function inferCodexHomeFromSessionsDir(sessionsDir) {
  return path.dirname(sessionsDir);
}
