export interface Logger {
  info(message: string, data?: any): void;
  error(message: string, error?: any): void;
  warn(message: string, data?: any): void;
  debug(message: string, data?: any): void;
}

class ConsoleLogger implements Logger {
  info(message: string, data?: any) {
    console.log(`[INFO] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }
  
  error(message: string, error?: any) {
    console.error(`[ERROR] ${message}`, error ? JSON.stringify(error, null, 2) : '');
  }
  
  warn(message: string, data?: any) {
    console.warn(`[WARN] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }
  
  debug(message: string, data?: any) {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[DEBUG] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
  }
}

export const logger: Logger = new ConsoleLogger();
