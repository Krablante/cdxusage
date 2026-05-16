import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveCodexDataPaths } from './codex-home.mjs';
import { collectUsage, defaultCacheFile, normalizeDate, safeTimeZone } from './engine.mjs';
import { DEFAULT_LOCALE, DEFAULT_TIMEZONE, formatDisplayDate, formatDisplayMonth, toPublicModels, toPublicUsage } from './format.mjs';
import { renderReportTable } from './table.mjs';

export const VERSION = '0.1.0';

const COMMANDS = new Set(['daily', 'monthly', 'session', 'sessions']);
const DEFAULT_AUTO_PRIORITY_MODELS = Object.freeze(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5']);

export async function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
  if (args.help) {
    io.stdout.write(helpText(args.commandSpecified ? args.command : undefined));
    return 0;
  }
  if (args.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }

  let since;
  let until;
  try {
    since = normalizeDate(args.since);
    until = normalizeDate(args.until);
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }

  let timezone;
  try {
    timezone = safeTimeZone(args.timezone ?? DEFAULT_TIMEZONE);
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
  const locale = args.locale ?? DEFAULT_LOCALE;
  const mode = args.command === 'sessions' ? 'session' : args.command;
  const dataPaths = await resolveCodexDataPaths({
    codexHome: args.codexHome,
    sessionsDir: args.sessionsDir,
  });
  const pricingMode = await resolvePricingMode(args, dataPaths.codexHome);
  const report = await collectUsage({
    dataPaths,
    since,
    until,
    timezone,
    cacheFile: args.cacheFile,
    pricingCacheFile: args.pricingCacheFile,
    pricingOffline: args.offline,
    pricingTtlMs: args.pricingTtlHours != null ? Number(args.pricingTtlHours) * 60 * 60 * 1000 : undefined,
    pricingFetchTimeoutMs: args.pricingFetchTimeoutMs != null ? Number(args.pricingFetchTimeoutMs) : undefined,
    pricingTier: pricingMode.tier,
    pricingPriorityModels: pricingMode.priorityModels,
    maxCacheBytes: args.maxCacheBytes != null ? Number(args.maxCacheBytes) : undefined,
    useCache: !args.noCache,
    clearCache: args.clearCache,
    saveCache: !args.noSaveCache,
    discoveryMode: args.discovery,
    includePricing: !args.noPricing,
  });

  const rows = rowsForMode(report, mode, { locale, sort: args.sort, order: args.order });
  if (args.json) {
    const payload = jsonPayload(mode, rows, report.totals, report, args);
    io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (rows.length === 0) {
    io.stdout.write(filterProvided(since, until) ? 'No Codex usage data found for provided filters.\n' : 'No Codex usage data found.\n');
  } else {
    const output = renderReportTable(mode, rows, report.totals, {
      timezone,
      locale,
      compact: args.compact,
      color: shouldUseColor(args),
    });
    io.stdout.write(`${output}\n`);
    emitWarnings(report, io.stderr);
  }
  return 0;
}

export function parseArgs(argv) {
  const args = {
    command: 'daily',
    json: false,
    offline: false,
    compact: false,
    color: undefined,
    noColor: false,
    noCache: false,
    clearCache: false,
    noSaveCache: false,
    noPricing: false,
    includeStats: false,
    speed: 'auto',
    sort: 'auto',
    order: 'asc',
    cacheFile: defaultCacheFile(),
  };
  const rest = [...argv];
  if (rest[0] === 'ccusage-codex' || rest[0] === 'cdxusage') {
    rest.shift();
  }
  if (COMMANDS.has(rest[0])) {
    args.command = rest.shift();
    args.commandSpecified = true;
  }
  while (rest.length > 0) {
    const token = rest.shift();
    switch (token) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-v':
      case '--version':
        args.version = true;
        break;
      case '-j':
      case '--json':
        args.json = true;
        break;
      case '-s':
      case '--since':
        args.since = requireValue(token, rest);
        break;
      case '-u':
      case '--until':
        args.until = requireValue(token, rest);
        break;
      case '-z':
      case '--timezone':
        args.timezone = requireValue(token, rest);
        break;
      case '-l':
      case '--locale':
        args.locale = requireValue(token, rest);
        break;
      case '-O':
      case '--offline':
        args.offline = true;
        break;
      case '--no-offline':
        args.offline = false;
        break;
      case '--compact':
        args.compact = true;
        break;
      case '--color':
        args.color = true;
        break;
      case '--noColor':
      case '--no-color':
        args.noColor = true;
        args.color = false;
        break;
      case '--codex-home':
        args.codexHome = requireValue(token, rest);
        break;
      case '--sessions-dir':
        args.sessionsDir = requireValue(token, rest);
        break;
      case '--cache-file':
        args.cacheFile = path.resolve(requireValue(token, rest));
        break;
      case '--pricing-cache-file':
        args.pricingCacheFile = path.resolve(requireValue(token, rest));
        break;
      case '--pricing-ttl-hours':
        args.pricingTtlHours = requireValue(token, rest);
        break;
      case '--pricing-fetch-timeout-ms':
        args.pricingFetchTimeoutMs = requireValue(token, rest);
        break;
      case '--max-cache-bytes':
        args.maxCacheBytes = requireValue(token, rest);
        break;
      case '--discovery':
      case '--discovery-mode':
        args.discovery = requireValue(token, rest);
        break;
      case '--no-cache':
        args.noCache = true;
        break;
      case '--clear-cache':
        args.clearCache = true;
        break;
      case '--no-save-cache':
        args.noSaveCache = true;
        break;
      case '--no-pricing':
        args.noPricing = true;
        break;
      case '--no-priority':
        args.speed = 'standard';
        break;
      case '--speed':
        args.speed = requireValue(token, rest);
        break;
      case '--priority-models':
        args.priorityModels = requireValue(token, rest);
        break;
      case '--include-stats':
        args.includeStats = true;
        break;
      case '--sort':
        args.sort = requireValue(token, rest);
        break;
      case '--order':
        args.order = requireValue(token, rest);
        break;
      default:
        if (token.startsWith('--')) {
          throw new Error(`Unknown option: ${token}`);
        }
        throw new Error(`Unknown command or argument: ${token}`);
    }
  }
  validateArgs(args);
  return args;
}

function rowsForMode(report, mode, options) {
  if (mode === 'daily') {
    return sortRows(
      report.daily.map((row) => ({
        ...row,
        date: formatDisplayDate(row.key, options.locale),
      })),
      mode,
      options,
    );
  }
  if (mode === 'monthly') {
    return sortRows(
      report.monthly.map((row) => ({
        ...row,
        month: formatDisplayMonth(row.key, options.locale),
      })),
      mode,
      options,
    );
  }
  return sortRows(report.sessions, mode, options);
}

function sortRows(rows, mode, options) {
  const sort = normalizeSort(options.sort, mode);
  const order = options.order === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => compareRows(a, b, sort, mode) * order);
}

function compareRows(a, b, sort, mode) {
  if (sort === 'cost') {
    return compareNumber(a.costUSD, b.costUSD) || compareDefault(a, b, mode);
  }
  if (sort === 'tokens') {
    return compareNumber(a.totalTokens, b.totalTokens) || compareDefault(a, b, mode);
  }
  if (sort === 'input') {
    return compareNumber(a.inputTokens, b.inputTokens) || compareDefault(a, b, mode);
  }
  if (sort === 'output') {
    return compareNumber(a.outputTokens, b.outputTokens) || compareDefault(a, b, mode);
  }
  if (sort === 'session') {
    return String(a.sessionId ?? '').localeCompare(String(b.sessionId ?? '')) || compareDefault(a, b, mode);
  }
  if (sort === 'directory') {
    return String(a.directory ?? '').localeCompare(String(b.directory ?? '')) || compareDefault(a, b, mode);
  }
  return compareDefault(a, b, mode);
}

function compareDefault(a, b, mode) {
  if (mode === 'session') {
    return String(a.lastActivity ?? '').localeCompare(String(b.lastActivity ?? ''));
  }
  return String(a.key ?? '').localeCompare(String(b.key ?? ''));
}

function compareNumber(a, b) {
  return (Number(a) || 0) - (Number(b) || 0);
}

function normalizeSort(sort, mode) {
  if (!sort || sort === 'auto') {
    return mode === 'session' ? 'lastActivity' : mode === 'monthly' ? 'month' : 'date';
  }
  if (sort === 'date' && mode !== 'daily') {
    return mode === 'session' ? 'lastActivity' : 'month';
  }
  if (sort === 'month' && mode !== 'monthly') {
    return mode === 'session' ? 'lastActivity' : 'date';
  }
  if (sort === 'lastActivity' && mode !== 'session') {
    return mode === 'monthly' ? 'month' : 'date';
  }
  return sort;
}

function validateArgs(args) {
  const allowedSort = new Set([
    'auto',
    'date',
    'month',
    'lastActivity',
    'tokens',
    'cost',
    'input',
    'output',
    'session',
    'directory',
  ]);
  if (!allowedSort.has(args.sort)) {
    throw new Error(`Invalid --sort value: ${args.sort}`);
  }
  if (!['asc', 'desc'].includes(args.order)) {
    throw new Error(`Invalid --order value: ${args.order}`);
  }
  if (args.discovery != null && !['auto', 'find', 'node'].includes(args.discovery)) {
    throw new Error(`Invalid --discovery value: ${args.discovery}`);
  }
  if (args.speed != null && !['auto', 'standard', 'fast'].includes(args.speed)) {
    throw new Error(`Invalid --speed value: ${args.speed}`);
  }
  if (args.priorityModels != null && parsePriorityModelsFlag(args.priorityModels) === false) {
    throw new Error(`Invalid --priority-models value: ${args.priorityModels}`);
  }
  validateNumberFlag(args, 'pricingTtlHours', '--pricing-ttl-hours', { min: 0 });
  validateNumberFlag(args, 'pricingFetchTimeoutMs', '--pricing-fetch-timeout-ms', { min: Number.EPSILON });
  validateNumberFlag(args, 'maxCacheBytes', '--max-cache-bytes', { min: Number.EPSILON });
}

function validateNumberFlag(args, key, option, { min }) {
  if (args[key] == null) {
    return;
  }
  const parsed = Number(args[key]);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`Invalid ${option} value: ${args[key]}`);
  }
}

function jsonPayload(mode, rows, totals, report, args) {
  const mappedRows = rows.map((row) => publicRow(mode, row));
  const key = mode === 'session' ? 'sessions' : mode;
  const payload = {
    [key]: mappedRows,
    totals: mappedRows.length === 0 ? null : { ...toPublicUsage(totals), costUSD: publicCost(totals.costUSD) },
  };
  if (args.includeStats) {
    payload.pricing = report.pricing;
    payload.stats = report.stats;
  }
  return payload;
}

function publicRow(mode, row) {
  if (mode === 'daily') {
    return {
      date: row.date,
      dateKey: row.key,
      ...toPublicUsage(row),
      costUSD: publicCost(row.costUSD),
      models: toPublicModels(row.models),
    };
  }
  if (mode === 'monthly') {
    return {
      month: row.month,
      monthKey: row.key,
      ...toPublicUsage(row),
      costUSD: publicCost(row.costUSD),
      models: toPublicModels(row.models),
    };
  }
  return {
    sessionId: row.sessionId,
    lastActivity: row.lastActivity,
    sessionFile: row.sessionFile,
    directory: row.directory,
    ...toPublicUsage(row),
    costUSD: publicCost(row.costUSD),
    models: toPublicModels(row.models),
  };
}

function publicCost(value) {
  return value == null ? null : value;
}

async function resolvePricingMode(args, codexHome) {
  const hasExplicitPriorityModels = args.priorityModels != null;
  const explicitPriorityModels = parsePriorityModelsFlag(args.priorityModels);
  if (args.speed === 'fast') {
    return { tier: 'priority', priorityModels: hasExplicitPriorityModels ? explicitPriorityModels : null };
  }
  if (args.speed === 'standard') {
    return { tier: 'standard', priorityModels: null };
  }
  const serviceTier = await readServiceTier(path.join(codexHome, 'config.toml'));
  if (serviceTier === 'priority' || serviceTier === 'fast') {
    return {
      tier: 'priority',
      priorityModels: hasExplicitPriorityModels ? explicitPriorityModels : DEFAULT_AUTO_PRIORITY_MODELS,
    };
  }
  return { tier: 'standard', priorityModels: null };
}

function parsePriorityModelsFlag(value) {
  if (value == null) {
    return null;
  }
  const models = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (models.length === 0) {
    return false;
  }
  if (models.some((model) => model.toLowerCase() === 'all')) {
    return null;
  }
  return [...new Set(models)];
}

async function readServiceTier(configFile) {
  try {
    const config = await readFile(configFile, 'utf8');
    const match = config.match(/^\s*service_tier\s*=\s*["']?([^"'\s#]+)/m);
    return match?.[1]?.trim().toLowerCase();
  } catch {
    return null;
  }
}

function filterProvided(since, until) {
  return Boolean(since || until);
}

function shouldUseColor(args) {
  if (args.noColor || process.env.NO_COLOR) {
    return false;
  }
  if (args.color || process.env.FORCE_COLOR) {
    return true;
  }
  return Boolean(process.stdout.isTTY);
}

function emitWarnings(report, stderr) {
  const missing = report.pricing?.missingModels ?? [];
  if (missing.length > 0) {
    stderr.write(`Missing pricing for models: ${missing.join(', ')}\n`);
  }
  const warnings = report.pricing?.warnings ?? [];
  for (const warning of warnings) {
    stderr.write(`Pricing warning: ${warning}\n`);
  }
}

function requireValue(option, rest) {
  const value = rest.shift();
  if (!value || value.startsWith('-')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function helpText(command) {
  if (!command) {
    return topLevelHelp();
  }
  const name = command && command !== 'sessions' ? command : 'session';
  if (name === 'monthly') {
    return commandHelp('monthly', 'Show Codex token usage grouped by month');
  }
  if (name === 'session') {
    return commandHelp('session', 'Show Codex token usage grouped by session');
  }
  if (name === 'daily') {
    return commandHelp('daily', 'Show Codex token usage grouped by day');
  }
  return topLevelHelp();
}

function topLevelHelp() {
  return `USAGE:
  cdxusage [daily] <OPTIONS>
  cdxusage <COMMANDS>

COMMANDS:
  daily            Show Codex token usage grouped by day
  monthly          Show Codex token usage grouped by month
  session          Show Codex token usage grouped by session (alias: sessions)

For more info, run any command with the --help flag:
  cdxusage daily --help
  cdxusage monthly --help
  cdxusage session --help

${optionsHelp()}`;
}

function commandHelp(command, description) {
  return `${description}

USAGE:
  cdxusage ${command} <OPTIONS>

${optionsHelp()}`;
}

function optionsHelp() {
  return `OPTIONS:
  -j, --json                         Output report as JSON (default: false)
  -s, --since <since>                Filter from date (YYYY-MM-DD or YYYYMMDD)
  -u, --until <until>                Filter until date (inclusive)
  -z, --timezone <timezone>          Timezone for date grouping (IANA) (default: ${DEFAULT_TIMEZONE})
  -l, --locale <locale>              Locale for formatting (default: en-CA)
  -O, --offline                      Use cached pricing data instead of fetching live pricing (default: false)
  --no-offline                       Negatable of -O, --offline
  --compact                          Force compact table layout for narrow terminals (default: false)
  --color                            Enable colored output unless NO_COLOR is set. FORCE_COLOR=1 has the same effect.
  --noColor, --no-color              Disable colored output. NO_COLOR=1 wins over --color/FORCE_COLOR.
  --speed <auto|standard|fast>       Pricing service tier (default: auto; reads Codex config)
  --no-priority                      Alias for --speed standard
  --priority-models <list|all>       Comma-separated priority-priced models for --speed auto/fast
  -h, --help                         Display this help message
  -v, --version                      Display this version

EXTRA OPTIONS:
  --codex-home <path>                Override Codex home auto-discovery
  --sessions-dir <path>              Read a specific sessions directory
  --cache-file <path>                Override token cache file
  --pricing-cache-file <path>        Override pricing cache file
  --pricing-ttl-hours <hours>        Pricing cache TTL (default: 24)
  --pricing-fetch-timeout-ms <ms>    Live pricing fetch timeout
  --discovery <auto|find|node>       JSONL discovery mode (default: auto)
  --max-cache-bytes <bytes>          Max token cache file size to load or save (default: 67108864)
  --sort <field>                     Sort by auto/date/month/lastActivity/tokens/cost/input/output/session/directory
  --order <asc|desc>                 Sort order (default: asc)
  --clear-cache                      Ignore existing token cache for this run
  --no-cache                         Disable token cache
  --no-save-cache                    Do not write token cache
  --no-pricing                       Skip estimated API cost
  --include-stats                    Include pricing/cache stats in JSON
`;
}
