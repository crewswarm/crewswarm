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
}

/** Shared singleton logger instance. Import this instead of creating new Logger(). */
export const logger = new Logger({ level: process.env.CREW_LOG_LEVEL || 'info' });
