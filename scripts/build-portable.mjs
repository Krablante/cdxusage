#!/usr/bin/env node
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const portableRoot = path.join(repoRoot, 'portable');

await rm(portableRoot, { recursive: true, force: true });
await mkdir(portableRoot, { recursive: true });

for (const name of ['bin', 'src']) {
  await cp(path.join(repoRoot, name), path.join(portableRoot, name), {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
  await normalizePortableTree(path.join(portableRoot, name));
}
await chmod(path.join(portableRoot, 'bin', 'cdxusage.mjs'), 0o755);
await mkdir(path.join(portableRoot, 'docs'), { recursive: true });
await cp(
  path.join(repoRoot, 'docs', 'compatibility.md'),
  path.join(portableRoot, 'docs', 'compatibility.md'),
  { force: true },
);
await normalizePortableTree(path.join(portableRoot, 'docs'));

const sourcePackage = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
const portablePackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  type: sourcePackage.type,
  description: `${sourcePackage.description} Portable folder build.`,
  bin: sourcePackage.bin,
  engines: sourcePackage.engines,
  license: sourcePackage.license,
};

await writeTextFile(path.join(portableRoot, 'package.json'), `${JSON.stringify(portablePackage, null, 2)}\n`);
await writeFile(path.join(portableRoot, 'cdxusage'), portableShellLauncher(), { mode: 0o755 });
await chmod(path.join(portableRoot, 'cdxusage'), 0o755);
await writeTextFile(path.join(portableRoot, 'cdxusage.cmd'), portableCmdLauncher());
await writeTextFile(path.join(portableRoot, 'cdxusage.ps1'), portablePowerShellLauncher());
await writeTextFile(path.join(portableRoot, 'README.md'), portableReadme(sourcePackage.version));

async function writeTextFile(file, content) {
  await writeFile(file, content, { mode: 0o644 });
  await chmod(file, 0o644);
}

async function normalizePortableTree(root) {
  await chmod(root, 0o755);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await normalizePortableTree(full);
    } else if (entry.isFile()) {
      await chmod(full, 0o644);
    }
  }
}

function portableShellLauncher() {
  return `#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "cdxusage portable requires Node.js >=20.19.4 in PATH." >&2
  exit 1
fi

if ! node -e "const [a,b,c]=process.versions.node.split('.').map(Number); process.exit(a>20 || (a===20 && (b>19 || (b===19 && c>=4))) ? 0 : 1)" >/dev/null 2>&1; then
  echo "cdxusage portable requires Node.js >=20.19.4. Found: $(node -v)" >&2
  exit 1
fi

exec node "$ROOT/bin/cdxusage.mjs" "$@"
`;
}

function portableCmdLauncher() {
  return `@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "ROOT=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo cdxusage portable requires Node.js ^>=20.19.4 in PATH. 1>&2
  exit /b 1
)
node -e "const [a,b,c]=process.versions.node.split('.').map(Number); process.exit(a>20 || (a===20 && (b>19 || (b===19 && c>=4))) ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VERSION=%%v"
  echo cdxusage portable requires Node.js ^>=20.19.4. Found: !NODE_VERSION! 1>&2
  exit /b 1
)
node "%ROOT%bin\\cdxusage.mjs" %*
exit /b %ERRORLEVEL%
`;
}

function portablePowerShellLauncher() {
  return `$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
  [Console]::Error.WriteLine("cdxusage portable requires Node.js >=20.19.4 in PATH.")
  exit 1
}

& node -e "const [a,b,c]=process.versions.node.split('.').map(Number); process.exit(a>20 || (a===20 && (b>19 || (b===19 && c>=4))) ? 0 : 1)" *> $null
if ($LASTEXITCODE -ne 0) {
  $Version = & node -v
  [Console]::Error.WriteLine("cdxusage portable requires Node.js >=20.19.4. Found: $Version")
  exit 1
}

& node (Join-Path $Root "bin/cdxusage.mjs") @args
exit $LASTEXITCODE
`;
}

function portableReadme(version) {
  return `# cdxusage portable

This folder is a self-contained portable copy of cdxusage ${version}. It does
not need npm install and does not write any permanent database.

Requirements:

- Node.js >=20.19.4
- Codex CLI sessions in a normal Codex home. The launcher auto-discovers
  \`CODEX_HOME\`, \`~/.codex\`, current/near-parent \`.codex\`, and common Windows
  locations such as \`%USERPROFILE%\\.codex\`, \`%APPDATA%\\Codex\`, and
  \`%LOCALAPPDATA%\\Codex\`.

Two-command use after downloading this folder:

\`\`\`bash
cd /path/to/cdxusage-portable
sh ./cdxusage monthly
\`\`\`

If executable bits were preserved by the archive, this also works:

\`\`\`bash
./cdxusage monthly
\`\`\`

Useful commands:

\`\`\`bash
sh ./cdxusage daily
sh ./cdxusage monthly
sh ./cdxusage session
sh ./cdxusage monthly --no-priority
sh ./cdxusage monthly --json --include-stats
\`\`\`

On Windows:

\`\`\`bat
.\\cdxusage.cmd monthly
\`\`\`

PowerShell also works when script execution policy allows local scripts:

\`\`\`powershell
.\\cdxusage.ps1 monthly
\`\`\`

The default pricing mode is \`auto\`: it reads \`CODEX_HOME/config.toml\` and
uses priority pricing when Codex has \`service_tier = "fast"\` or
\`service_tier = "priority"\`. If \`CODEX_HOME\` is not set, it reads the
auto-discovered Codex home. Use \`--no-priority\` to force standard pricing.

If auto-discovery chooses the wrong location, override it explicitly:

\`\`\`bat
.\\cdxusage.cmd monthly --codex-home C:\\Users\\you\\.codex
\`\`\`
`;
}
