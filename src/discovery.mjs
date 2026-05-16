import { spawn } from 'node:child_process';
import { lstat, opendir, stat } from 'node:fs/promises';
import path from 'node:path';

const FIND_FIELD_SEPARATOR = '\x1f';
const FIND_RECORD_SEPARATOR = '\x1e';

export async function* discoverJsonlFiles(root, options = {}) {
  const mode = options.mode ?? 'auto';
  const stats = options.stats ?? {};
  if (mode !== 'node') {
    const unsupportedReason = findDiscoveryUnsupportedReason();
    if (unsupportedReason) {
      if (mode === 'find') {
        throw new Error(`find discovery is unavailable: ${unsupportedReason}`);
      }
      stats.discoveryMode ??= `node-fallback:${unsupportedReason}`;
    } else {
      let yielded = 0;
      try {
        for await (const entry of discoverJsonlFilesWithFind(root)) {
          yielded += 1;
          yield entry;
        }
        if (mode === 'find' || yielded > 0) {
          stats.discoveryMode ??= 'find';
          return;
        }
      } catch (error) {
        if (mode === 'find' || yielded > 0) {
          throw error;
        }
        stats.discoveryMode ??= `node-fallback:${error.code ?? error.message}`;
      }
    }
  }

  stats.discoveryMode ??= 'node';
  for await (const file of walkJsonl(root)) {
    yield { path: file };
  }
}

function findDiscoveryUnsupportedReason() {
  return process.platform === 'linux' ? null : `unsupported platform ${process.platform}`;
}

async function* discoverJsonlFilesWithFind(root) {
  try {
    await stat(root);
  } catch {
    return;
  }
  const child = spawn(
    'find',
    [
      root,
      '(',
      '-type',
      'f',
      '-name',
      '*.jsonl',
      '-printf',
      'f\\037%p\\037%D\\037%i\\037%s\\037%T@\\036',
      ')',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4096);
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  let buffer = '';
  for await (const chunk of child.stdout) {
    buffer += chunk.toString('utf8');
    for (;;) {
      const index = buffer.indexOf(FIND_RECORD_SEPARATOR);
      if (index === -1) {
        break;
      }
      const record = buffer.slice(0, index);
      buffer = buffer.slice(index + FIND_RECORD_SEPARATOR.length);
      const entry = parseFindRecord(record);
      if (entry) {
        yield entry;
      }
    }
  }
  if (buffer) {
    const entry = parseFindRecord(buffer);
    if (entry) {
      yield entry;
    }
  }
  const status = await closed;
  if (status.error) {
    throw new Error(`find discovery is unavailable: ${status.error.message}`);
  }
  if (status.code !== 0) {
    throw new Error(`find exited with ${status.signal ?? status.code}: ${stderr.trim()}`);
  }
}

function parseFindRecord(record) {
  if (!record) {
    return null;
  }
  const parts = record.split(FIND_FIELD_SEPARATOR);
  if (parts.length !== 6 || !parts[1]) {
    return null;
  }
  return {
    path: parts[1],
    stat: {
      dev: Number(parts[2]),
      ino: Number(parts[3]),
      size: Number(parts[4]),
      mtimeMs: Number(parts[5]) * 1000,
    },
  };
}

async function* walkJsonl(root) {
  let dir;
  try {
    dir = await opendir(root);
  } catch {
    return;
  }
  for await (const entry of dir) {
    const full = path.join(root, entry.name);
    let entryStat;
    try {
      entryStat = await lstat(full);
    } catch {
      continue;
    }
    if (entryStat.isSymbolicLink()) {
      continue;
    }
    if (entryStat.isDirectory()) {
      yield* walkJsonl(full);
    } else if (entryStat.isFile() && entry.name.endsWith('.jsonl')) {
      yield full;
    }
  }
}
