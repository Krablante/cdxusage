import { formatCurrency, formatDisplayDate, formatDisplayDateTime, formatDisplayMonth, formatNumber, modelList, splitUsageTokens } from './format.mjs';

const ANSI = {
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  yellow: '\x1b[33m',
  reset: '\x1b[39m',
};

export function renderReportTable(mode, rows, totals, options) {
  const title = `Codex Token Usage Report - ${titleForMode(mode)} (Timezone: ${options.timezone})`;
  const compact = Boolean(options.compact) || Number(process.env.COLUMNS || process.stdout.columns || 120) < 100;
  const head = headersForMode(mode, compact);
  const body = rows.map((row) => rowForMode(mode, row, options, compact));
  body.push(separatorRow(head.length));
  body.push(totalRowForMode(mode, totals, compact, options.color));
  const box = renderTitleBox(title);
  const table = renderTable(head, body, { color: options.color, aligns: alignsForMode(mode, compact) });
  const note = compact
    ? '\n\nRunning in Compact Mode\nExpand terminal width to see cache metrics, total tokens, and detail columns'
    : '';
  return `${box}\n\n${table}${note}`;
}

function titleForMode(mode) {
  if (mode === 'daily') {
    return 'Daily';
  }
  if (mode === 'monthly') {
    return 'Monthly';
  }
  return 'Sessions';
}

function headersForMode(mode, compact) {
  if (mode === 'session') {
    return compact
      ? ['Date', 'Directory', 'Session', 'Input', 'Output', 'Cost (USD)']
      : ['Date', 'Directory', 'Session', 'Models', 'Input', 'Output', 'Reasoning', 'Cache Read', 'Total Tokens', 'Cost (USD)', 'Last Activity'];
  }
  const first = mode === 'monthly' ? 'Month' : 'Date';
  return compact
    ? [first, 'Models', 'Input', 'Output', 'Cost (USD)']
    : [first, 'Models', 'Input', 'Output', 'Reasoning', 'Cache Read', 'Total Tokens', 'Cost (USD)'];
}

function alignsForMode(mode, compact) {
  if (mode === 'session') {
    return compact
      ? ['left', 'left', 'left', 'right', 'right', 'right']
      : ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'left'];
  }
  return compact
    ? ['left', 'left', 'right', 'right', 'right']
    : ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'];
}

function rowForMode(mode, row, options, compact) {
  const split = splitUsageTokens(row);
  if (mode === 'session') {
    const date = formatDisplayDate(dateKeyFromTimestamp(row.lastActivity, options.timezone), options.locale);
    const directory = row.directory || '-';
    const sessionFile = row.sessionFile.length > 8 ? `...${row.sessionFile.slice(-8)}` : row.sessionFile;
    if (compact) {
      return [date, directory, sessionFile, formatNumber(split.inputTokens), formatNumber(split.outputTokens), formatCurrency(row.costUSD)];
    }
    return [
      date,
      directory,
      sessionFile,
      multilineModels(row.models),
      formatNumber(split.inputTokens),
      formatNumber(split.outputTokens),
      formatNumber(split.reasoningTokens),
      formatNumber(split.cacheReadTokens),
      formatNumber(row.totalTokens),
      formatCurrency(row.costUSD),
      formatDisplayDateTime(row.lastActivity, options.locale, options.timezone),
    ];
  }

  const label = mode === 'monthly' ? formatDisplayMonth(row.key, options.locale) : formatDisplayDate(row.key, options.locale);
  if (compact) {
    return [label, multilineModels(row.models), formatNumber(split.inputTokens), formatNumber(split.outputTokens), formatCurrency(row.costUSD)];
  }
  return [
    label,
    multilineModels(row.models),
    formatNumber(split.inputTokens),
    formatNumber(split.outputTokens),
    formatNumber(split.reasoningTokens),
    formatNumber(split.cacheReadTokens),
    formatNumber(row.totalTokens),
    formatCurrency(row.costUSD),
  ];
}

function totalRowForMode(mode, totals, compact, color) {
  const split = splitUsageTokens(totals);
  const label = paint('Total', 'yellow', color);
  const values = [
    paint(formatNumber(split.inputTokens), 'yellow', color),
    paint(formatNumber(split.outputTokens), 'yellow', color),
    paint(formatNumber(split.reasoningTokens), 'yellow', color),
    paint(formatNumber(split.cacheReadTokens), 'yellow', color),
    paint(formatNumber(totals.totalTokens), 'yellow', color),
    paint(formatCurrency(totals.costUSD), 'yellow', color),
  ];
  if (mode === 'session') {
    return compact ? ['', '', label, values[0], values[1], values[5]] : ['', '', label, '', ...values, ''];
  }
  return compact ? [label, '', values[0], values[1], values[5]] : [label, '', ...values];
}

function multilineModels(models) {
  return modelList(models).map((model) => `- ${model}`).join('\n');
}

function renderTitleBox(title) {
  const width = title.length + 4;
  return [
    ` ${'╭'}${'─'.repeat(width)}${'╮'}`,
    ` │${' '.repeat(width)}│`,
    ` │  ${title}  │`,
    ` │${' '.repeat(width)}│`,
    ` ${'╰'}${'─'.repeat(width)}${'╯'}`,
  ].join('\n');
}

function renderTable(head, rows, options) {
  const normalizedRows = [head, ...rows.filter((row) => !row.__separator)].map(splitMultilineRow);
  const widths = head.map((_, index) =>
    Math.min(
      Math.max(
        visibleLength(head[index]),
        ...normalizedRows.flatMap((row) => row[index].map((line) => visibleLength(line))),
      ),
      maxWidthForColumn(head[index]),
    ),
  );
  const lines = [];
  lines.push(border('┌', '┬', '┐', widths, options.color));
  lines.push(...renderLogicalRow(head.map((cell) => [paint(cell, 'cyan', options.color)]), widths, options));
  lines.push(border('├', '┼', '┤', widths, options.color));
  for (const row of rows) {
    if (row.__separator) {
      continue;
    }
    lines.push(...renderLogicalRow(splitMultilineRow(row), widths, options));
    lines.push(border('├', '┼', '┤', widths, options.color));
  }
  lines[lines.length - 1] = border('└', '┴', '┘', widths, options.color);
  return lines.join('\n');
}

function splitMultilineRow(row) {
  if (row.__separator) {
    return row;
  }
  return row.map((cell) => String(cell ?? '').split('\n'));
}

function renderLogicalRow(row, widths, options) {
  const height = Math.max(...row.map((cell) => cell.length));
  const out = [];
  for (let line = 0; line < height; line += 1) {
    const cells = row.map((cell, index) => {
      const text = truncateAnsi(cell[line] ?? '', widths[index]);
      return pad(text, widths[index], options.aligns[index] ?? 'left');
    });
    out.push(`${paint('│', 'gray', options.color)} ${cells.join(` ${paint('│', 'gray', options.color)} `)} ${paint('│', 'gray', options.color)}`);
  }
  return out;
}

function border(left, join, right, widths, color) {
  return paint(`${left}${widths.map((width) => '─'.repeat(width + 2)).join(join)}${right}`, 'gray', color);
}

function separatorRow(length) {
  return { __separator: true, length };
}

function pad(value, width, align) {
  const len = visibleLength(value);
  const spaces = Math.max(width - len, 0);
  if (align === 'right') {
    return `${' '.repeat(spaces)}${value}`;
  }
  return `${value}${' '.repeat(spaces)}`;
}

function truncateAnsi(value, width) {
  if (visibleLength(value) <= width) {
    return value;
  }
  const plain = stripAnsi(value);
  if (width <= 1) {
    return '…';
  }
  return `${plain.slice(0, width - 1)}…`;
}

function visibleLength(value) {
  return stripAnsi(String(value)).length;
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}

function maxWidthForColumn(header) {
  if (header === 'Models') {
    return 28;
  }
  if (header === 'Directory' || header === 'Last Activity') {
    return 20;
  }
  return 18;
}

function paint(value, color, enabled) {
  if (!enabled) {
    return value;
  }
  return `${ANSI[color]}${value}${ANSI.reset}`;
}

function dateKeyFromTimestamp(timestamp, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(new Date(timestamp));
}
