// Simple console logger — intentionally missing return type annotations
// (benchmark task: add TypeScript return types to all functions)

const PREFIX = '[app]';

function formatTimestamp() {
  return new Date().toISOString();
}

function formatMessage(level: string, msg: string) {
  return `${formatTimestamp()} ${PREFIX} ${level.toUpperCase()} ${msg}`;
}

export const logger = {
  info(msg: string) {
    console.log(formatMessage('info', msg));
  },

  warn(msg: string) {
    console.warn(formatMessage('warn', msg));
  },

  error(msg: string) {
    console.error(formatMessage('error', msg));
  },

  debug(msg: string) {
    if (process.env.DEBUG) {
      console.debug(formatMessage('debug', msg));
    }
  },
};
