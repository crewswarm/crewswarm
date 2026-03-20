import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export class ConfigManager {
  constructor() {
    this.config = {};
    this.configPath = join(homedir(), '.crewswarm', 'crewswarm.json');
    this.loadConfig();
  }

  loadConfig() {
    try {
      if (existsSync(this.configPath)) {
        const configData = readFileSync(this.configPath, 'utf8');
        this.config = JSON.parse(configData);
      } else {
        // Default configuration
        this.config = {
          rtBusUrl: 'ws://localhost:18889',
          crewLeadUrl: 'http://localhost:5010',
          dashboardUrl: 'http://localhost:4319',
          timeout: 30000,
          agents: []
        };
      }
    } catch (error) {
      console.warn('Failed to load config, using defaults:', error.message);
      this.config = {
        rtBusUrl: 'ws://localhost:18889',
        crewLeadUrl: 'http://localhost:5010',
        dashboardUrl: 'http://localhost:4319',
        timeout: 30000,
        agents: []
      };
    }
  }

  get(key) {
    return this.config[key];
  }

  set(key, value) {
    this.config[key] = value;
  }

  getAll() {
    return { ...this.config };
  }
}
