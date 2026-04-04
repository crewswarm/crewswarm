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
  level: string;
  prefix: string;

  constructor(options: { level?: string; prefix?: string } = {}) {
    this.level = options.level || 'info';
    this.prefix = options.prefix || '[crewswarm]';
  }

  formatMessage(level: string, message: string, ...args: unknown[]) {
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

  info(message: string, ...args: unknown[]) {
    console.log(this.formatMessage('info', message), ...args);
  }

  error(message: string, ...args: unknown[]) {
    console.error(this.formatMessage('error', message), ...args);
  }

  warn(message: string, ...args: unknown[]) {
    console.warn(this.formatMessage('warn', message), ...args);
  }

  success(message: string, ...args: unknown[]) {
    console.log(this.formatMessage('success', message), ...args);
  }

  debug(message: string, ...args: unknown[]) {
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
    // Rich markdown rendering for terminal
    let output = this.highlightCodeBlocks(text);

    // Process line-by-line for headers, bullets, etc.
    output = output.split('\n').map(line => {
      // Headers: # ## ###
      if (/^#{1,3}\s/.test(line)) {
        return color.bold(color.cyan(line));
      }
      // Bullet points
      if (/^\s*[-*]\s/.test(line)) {
        return line.replace(/^(\s*)([-*])(\s)/, `$1${color.cyan('$2')}$3`);
      }
      // Numbered lists
      if (/^\s*\d+\.\s/.test(line)) {
        return line.replace(/^(\s*)(\d+\.)(\s)/, `$1${color.cyan('$2')}$3`);
      }
      return line;
    }).join('\n');

    // Inline formatting (skip inside code blocks)
    // Bold: **text**
    output = output.replace(/\*\*([^*]+)\*\*/g, (_, t) => color.bold(t));
    // Inline code: `text`
    output = output.replace(/`([^`]+)`/g, (_, t) => color.cyan(t));

    console.log(output);
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

/** Shared singleton logger instance for modules that need lightweight logging without injection. */
export const logger = new Logger({ level: process.env.CREW_LOG_LEVEL || 'info' });
