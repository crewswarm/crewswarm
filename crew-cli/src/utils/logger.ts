const useColor = Boolean(process.stdout?.isTTY) && !process.env.NO_COLOR;

function ansi(code: string, text: string): string {
  if (!useColor) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

const color = {
  gray: (text: string) => ansi('90', text),
  red: (text: string) => ansi('31', text),
  yellow: (text: string) => ansi('33', text),
  green: (text: string) => ansi('32', text),
  blue: (text: string) => ansi('34', text),
  cyan: (text: string) => ansi('36', text),
  bold: (text: string) => ansi('1', text),
};

export class Logger {
  constructor(options = {}) {
    this.level = options.level || 'info';
    this.prefix = options.prefix || '[CrewSwarm]';
  }

  formatMessage(level, message, ...args) {
    const timestamp = new Date().toISOString();
    const prefix = `${color.gray(timestamp)} ${this.prefix}`;
    
    let colorFn;
    switch (level) {
      case 'error': colorFn = color.red; break;
      case 'warn': colorFn = color.yellow; break;
      case 'success': colorFn = color.green; break;
      case 'debug': colorFn = color.gray; break;
      default: colorFn = color.blue;
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
        return color.cyan(part);
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
        if (line.startsWith('+') && !line.startsWith('+++')) return color.green(line);
        if (line.startsWith('-') && !line.startsWith('---')) return color.red(line);
        if (line.startsWith('@@')) return color.cyan(line);
        if (line.startsWith('diff') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++')) {
          return color.bold(line);
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
    console.log(`${color.blue(label)} [${bar}] ${pct}% (${clamped}/${safeTotal})`);
  }
}
