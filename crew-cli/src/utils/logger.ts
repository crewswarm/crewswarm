import chalk from 'chalk';

export class Logger {
  constructor(options = {}) {
    this.level = options.level || 'info';
    this.prefix = options.prefix || '[CrewSwarm]';
  }

  formatMessage(level, message, ...args) {
    const timestamp = new Date().toISOString();
    const prefix = `${chalk.gray(timestamp)} ${this.prefix}`;
    
    let colorFn;
    switch (level) {
      case 'error': colorFn = chalk.red; break;
      case 'warn': colorFn = chalk.yellow; break;
      case 'success': colorFn = chalk.green; break;
      case 'debug': colorFn = chalk.gray; break;
      default: colorFn = chalk.blue;
    }

    return `${prefix} ${colorFn(`[${level.toUpperCase()}]`)} ${message}`;
  }

  info(message, ...args) {
    console.log(this.formatMessage('info', message), ...args);
  }

  error(message, ...args) {
    console.error(this.formatMessage('error', message), ...args);
  }

  warn(message, ...args) {
    console.warn(this.formatMessage('warn', message), ...args);
  }

  success(message, ...args) {
    console.log(this.formatMessage('success', message), ...args);
  }

  debug(message, ...args) {
    if (this.level === 'debug') {
      console.log(this.formatMessage('debug', message), ...args);
    }
  }

  highlightCodeBlocks(text: string) {
    if (!text.includes('```')) return text;

    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts
      .map(part => {
        if (!part.startsWith('```')) return part;
        return chalk.cyan(part);
      })
      .join('');
  }

  printWithHighlight(text: string) {
    console.log(this.highlightCodeBlocks(text));
  }

  highlightDiff(diff: string) {
    return diff
      .split('\n')
      .map(line => {
        if (line.startsWith('+') && !line.startsWith('+++')) return chalk.green(line);
        if (line.startsWith('-') && !line.startsWith('---')) return chalk.red(line);
        if (line.startsWith('@@')) return chalk.cyan(line);
        if (line.startsWith('diff') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++')) {
          return chalk.bold(line);
        }
        return line;
      })
      .join('\n');
  }

  progress(current: number, total: number, label = 'Progress') {
    const safeTotal = Math.max(1, total);
    const clamped = Math.min(Math.max(current, 0), safeTotal);
    const width = 24;
    const filled = Math.round((clamped / safeTotal) * width);
    const bar = `${'='.repeat(filled)}${'-'.repeat(width - filled)}`;
    const pct = Math.round((clamped / safeTotal) * 100);
    console.log(`${chalk.blue(label)} [${bar}] ${pct}% (${clamped}/${safeTotal})`);
  }
}
