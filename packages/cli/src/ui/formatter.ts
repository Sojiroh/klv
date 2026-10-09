import chalk from 'chalk';
import type { ParsedLog, LogLevel } from '@klv/core';

export interface FormatOptions {
  showTimestamp: boolean;
  showPodName: boolean;
  showService: boolean;
  showTraceId: boolean;
  showExtra: boolean;
  compact: boolean;
  maxMessageWidth: number;
}

const DEFAULT_OPTIONS: FormatOptions = {
  showTimestamp: true,
  showPodName: true,
  showService: true,
  showTraceId: false,
  showExtra: false,
  compact: false,
  maxMessageWidth: 0, // 0 = no limit
};

const LEVEL_COLORS: Record<LogLevel, (text: string) => string> = {
  TRACE: chalk.gray,
  DEBUG: chalk.cyan,
  INFO: chalk.green,
  WARN: chalk.yellow,
  ERROR: chalk.red,
  FATAL: chalk.bgRed.white,
  UNKNOWN: chalk.white,
};

const LEVEL_ICONS: Record<LogLevel, string> = {
  TRACE: '·',
  DEBUG: '○',
  INFO: '●',
  WARN: '▲',
  ERROR: '✖',
  FATAL: '☠',
  UNKNOWN: '?',
};

const POD_COLORS = [
  chalk.magenta,
  chalk.blue,
  chalk.cyan,
  chalk.green,
  chalk.yellow,
  chalk.red,
  chalk.magentaBright,
  chalk.blueBright,
  chalk.cyanBright,
  chalk.greenBright,
];

const podColorMap = new Map<string, (text: string) => string>();
let colorIndex = 0;

function getPodColor(podName: string): (text: string) => string {
  if (!podColorMap.has(podName)) {
    podColorMap.set(podName, POD_COLORS[colorIndex % POD_COLORS.length]);
    colorIndex++;
  }
  return podColorMap.get(podName)!;
}

function formatTimestamp(ts?: string): string {
  if (!ts) return chalk.gray('--:--:--');
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return chalk.gray(ts.substring(0, 12));
  return chalk.gray(
    date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }) + '.' + String(date.getMilliseconds()).padStart(3, '0')
  );
}

function formatLevel(level: LogLevel): string {
  const icon = LEVEL_ICONS[level];
  const color = LEVEL_COLORS[level];
  return color(`${icon} ${level.padEnd(5)}`);
}

function shortenPodName(name: string): string {
  // "my-service-abc123-xyz45" → "my-service-xyz45"
  const parts = name.split('-');
  if (parts.length > 3) {
    const suffix = parts.slice(-1)[0];
    const prefix = parts.slice(0, -2).join('-');
    return `${prefix}-${suffix}`;
  }
  return name;
}

function formatExtra(extra: Record<string, unknown>, indent: string): string {
  const entries = Object.entries(extra);
  if (entries.length === 0) return '';

  const lines = entries.map(([key, value]) => {
    const formatted = typeof value === 'object'
      ? JSON.stringify(value, null, 2).split('\n').join(`\n${indent}  `)
      : String(value);
    return `${indent}${chalk.gray(`${key}:`)} ${chalk.white(formatted)}`;
  });

  return '\n' + lines.join('\n');
}

export function formatLog(log: ParsedLog, options: Partial<FormatOptions> = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Si no es JSON y modo compacto, mostrar raw con nivel
  if (!log.isJson && opts.compact) {
    const level = formatLevel(log.level);
    const pod = opts.showPodName && log.podName
      ? getPodColor(log.podName)(shortenPodName(log.podName)) + ' '
      : '';
    return `${level} ${pod}${chalk.white(log.message)}`;
  }

  const parts: string[] = [];

  // Timestamp
  if (opts.showTimestamp) {
    parts.push(formatTimestamp(log.timestamp));
  }

  // Level
  parts.push(formatLevel(log.level));

  // Pod name
  if (opts.showPodName && log.podName) {
    const color = getPodColor(log.podName);
    parts.push(color(`[${shortenPodName(log.podName)}]`.padEnd(25)));
  }

  // Service
  if (opts.showService && log.service) {
    parts.push(chalk.blueBright(`(${log.service})`));
  }

  // Message
  let message = log.message;
  if (opts.maxMessageWidth > 0 && message.length > opts.maxMessageWidth) {
    message = message.substring(0, opts.maxMessageWidth - 3) + '...';
  }

  // Colorear el mensaje según el nivel
  const msgColor = log.level === 'ERROR' || log.level === 'FATAL'
    ? chalk.redBright
    : log.level === 'WARN'
      ? chalk.yellowBright
      : chalk.white;

  parts.push(msgColor(message));

  let result = parts.join(' ');

  // Trace ID
  if (opts.showTraceId && log.traceId) {
    result += chalk.gray(` [trace:${log.traceId}]`);
  }

  // Caller
  if (log.caller && !opts.compact) {
    result += chalk.gray(` @ ${log.caller}`);
  }

  // Error
  if (log.error && log.error !== log.message) {
    result += '\n' + chalk.redBright(`  ↳ ${log.error}`);
  }

  // Stack trace
  if (log.stackTrace && !opts.compact) {
    const lines = log.stackTrace.split('\n').map((l) => chalk.red(`    ${l}`));
    result += '\n' + lines.join('\n');
  }

  // Extra fields
  if (opts.showExtra && Object.keys(log.extra).length > 0) {
    result += formatExtra(log.extra, '  ');
  }

  return result;
}

export function formatLogSeparator(text: string): string {
  const width = process.stdout.columns || 80;
  const pad = Math.max(0, Math.floor((width - text.length - 2) / 2));
  return chalk.gray('─'.repeat(pad) + ` ${text} ` + '─'.repeat(pad));
}

export function formatStats(counts: Record<LogLevel, number>): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([level, count]) => {
      const color = LEVEL_COLORS[level as LogLevel];
      return color(`${LEVEL_ICONS[level as LogLevel]} ${level}: ${count}`);
    });
  return parts.join(chalk.gray(' │ '));
}
