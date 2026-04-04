import { Command } from 'commander';

// Inline stubs for missing lib modules
const logger = {
  info: (...args: unknown[]) => console.log('[monitor]', ...args),
  error: (...args: unknown[]) => console.error('[monitor]', ...args),
};
async function healthCheck(): Promise<{ agents: Record<string, unknown>; services: Record<string, unknown> }> {
  return { agents: {}, services: {} };
}

export function createMonitorCommand(): Command {
  const monitor = new Command('monitor');
  
  monitor
    .description('Monitor system health and agent status')
    .option('-i, --interval <ms>', 'Check interval in milliseconds', '5000')
    .option('-v, --verbose', 'Verbose output')
    .action(async (options) => {
      const interval = parseInt(options.interval, 10);
      const verbose = options.verbose;
      
      logger.info('Starting system monitor...');
      
      const monitorLoop = async () => {
        try {
          const status = await healthCheck();
          
          if (verbose) {
            logger.info('Health check results:', status);
          } else {
            const { agents, services } = status;
            const agentCount = Object.keys(agents).length;
            const healthyAgents = Object.values(agents).filter((a: unknown) => (a as Record<string, unknown>).status === 'online').length;
            const healthyServices = Object.values(services).filter((s: unknown) => (s as Record<string, unknown>).status === 'healthy').length;
            
            logger.info(`Agents: ${healthyAgents}/${agentCount} online | Services: ${healthyServices}/${Object.keys(services).length} healthy`);
          }
        } catch (error) {
          logger.error('Health check failed:', error);
        }
      };
      
      // Initial check
      await monitorLoop();
      
      // Set up interval monitoring
      setInterval(monitorLoop, interval);
    });
    
  return monitor;
}
