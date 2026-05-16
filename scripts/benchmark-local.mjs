#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const args = parseArgs(process.argv.slice(2));
const upstreamTimeoutValue = args.upstreamTimeout ?? args.timeout ?? 25;
const upstreamTimeoutSeconds = parsePositiveSeconds(
  upstreamTimeoutValue,
  args.upstreamTimeout != null ? '--upstream-timeout' : args.timeout != null ? '--timeout' : '--upstream-timeout',
);
const cdxusageTimeoutSeconds = parsePositiveSeconds(
  args.cdxusageTimeout ?? Math.max(90, upstreamTimeoutSeconds),
  args.cdxusageTimeout != null ? '--cdxusage-timeout' : '--cdxusage-timeout',
);
const since = args.since ?? '2026-05-01';
const workDir = await mkdtemp(path.join(tmpdir(), 'cdxusage-bench-'));

try {
  const cacheFile = path.join(workDir, 'index.json');
  const pricingCacheFile = path.join(workDir, 'pricing.json');
  const commonCdxArgs = [
    path.join(repoRoot, 'bin/cdxusage.mjs'),
    'monthly',
    '--offline',
    '--json',
    '--since',
    since,
    '--cache-file',
    cacheFile,
    '--pricing-cache-file',
    pricingCacheFile,
  ];
  const rows = [];
  rows.push(await measure('cdxusage cold', process.execPath, [...commonCdxArgs, '--clear-cache'], cdxusageTimeoutSeconds));
  rows.push(await measure('cdxusage warm', process.execPath, commonCdxArgs, cdxusageTimeoutSeconds));
  rows.push(
    await measure(
      'upstream latest',
      'npx',
      ['-y', '@ccusage/codex@latest', 'monthly', '--since', since, '--json'],
      upstreamTimeoutSeconds,
    ),
  );
  printRows(rows);
} finally {
  await rm(workDir, { recursive: true, force: true });
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [key, inlineValue] = token.split('=', 2);
    if (key === '--since' || key === '--timeout' || key === '--upstream-timeout' || key === '--cdxusage-timeout') {
      out[toCamelCase(key.slice(2))] = inlineValue ?? argv[++index];
    }
  }
  return out;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parsePositiveSeconds(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`${flag} must be a positive number of seconds`);
    process.exit(1);
  }
  return parsed;
}

async function measure(label, command, commandArgs, timeoutSeconds) {
  const start = process.hrtime.bigint();
  const hasTime = process.platform !== 'win32';
  const finalCommand = hasTime ? '/usr/bin/time' : command;
  const finalArgs = hasTime
    ? ['-v', 'timeout', `${timeoutSeconds}s`, command, ...commandArgs]
    : commandArgs;
  const result = await run(finalCommand, finalArgs, timeoutSeconds);
  const wallSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
  const maxRssKb = parseMaxRss(result.stderr);
  return {
    label,
    status: result.timedOut ? 124 : result.status,
    timedOut: result.timedOut || result.status === 124,
    wallSeconds,
    maxRssKb,
  };
}

function run(command, args, timeoutSeconds) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, Math.ceil(timeoutSeconds * 1000) + 500);
    timer.unref();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stderr, timedOut });
    });
  });
}

function parseMaxRss(stderr) {
  const match = stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

function printRows(rows) {
  console.log('| Tool | Time | RAM | Result |');
  console.log('| --- | ---: | ---: | --- |');
  for (const row of rows) {
    const time = row.timedOut ? `>${row.wallSeconds.toFixed(2)}s` : `${row.wallSeconds.toFixed(2)}s`;
    const ram = row.maxRssKb == null ? 'n/a' : `${(row.maxRssKb / 1_000_000).toFixed(2)} GB`;
    const result = row.timedOut ? `timed out (${row.status})` : row.status === 0 ? 'complete' : `exit ${row.status}`;
    console.log(`| ${row.label} | ${time} | ${ram} | ${result} |`);
  }
}
