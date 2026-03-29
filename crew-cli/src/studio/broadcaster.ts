/**
 * Studio Broadcaster
 * Sends file changes from CLI to Studio via WebSocket
 */

import WebSocket from 'ws';
import { readFile } from 'node:fs/promises';
import { Logger } from '../utils/logger.js';

export interface FileBroadcastEvent {
  type: 'file-changed' | 'file-created' | 'file-deleted';
  path: string;
  content?: string;
  timestamp: number;
}

export class StudioBroadcaster {
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private logger: Logger;
  private studioUrl: string;

  constructor(studioUrl = 'ws://127.0.0.1:3334/ws', logger?: Logger) {
    this.studioUrl = studioUrl;
    this.logger = logger || new Logger({ prefix: 'studio' });
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.studioUrl);

        this.ws.on('open', () => {
          this.connected = true;
          this.logger.info('Connected to Studio watch server');
          resolve();
        });

        this.ws.on('close', () => {
          this.connected = false;
          this.logger.info('Disconnected from Studio');
          this.scheduleReconnect();
        });

        this.ws.on('error', (err: any) => {
          this.logger.error('Studio WebSocket error:', err.message);
          if (!this.connected) {
            reject(err);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.logger.info('Attempting to reconnect to Studio...');
      this.connect().catch(() => {
        // Will retry again via scheduleReconnect
      });
    }, 5000);
  }

  async broadcastFileChange(filePath: string, includeContent = true): Promise<void> {
    if (!this.connected || !this.ws) {
      // Silently skip if not connected
      return;
    }

    try {
      const event: FileBroadcastEvent = {
        type: 'file-changed',
        path: filePath,
        timestamp: Date.now()
      };

      if (includeContent) {
        try {
          event.content = await readFile(filePath, 'utf8');
        } catch {
          // File might be binary or deleted - send without content
          event.content = undefined;
        }
      }

      this.ws.send(JSON.stringify(event));
    } catch (err) {
      this.logger.error('Failed to broadcast file change:', err);
    }
  }

  async broadcastFileCreated(filePath: string, content?: string): Promise<void> {
    if (!this.connected || !this.ws) return;

    try {
      const event: FileBroadcastEvent = {
        type: 'file-created',
        path: filePath,
        content,
        timestamp: Date.now()
      };

      this.ws.send(JSON.stringify(event));
    } catch (err) {
      this.logger.error('Failed to broadcast file creation:', err);
    }
  }

  async broadcastFileDeleted(filePath: string): Promise<void> {
    if (!this.connected || !this.ws) return;

    try {
      const event: FileBroadcastEvent = {
        type: 'file-deleted',
        path: filePath,
        timestamp: Date.now()
      };

      this.ws.send(JSON.stringify(event));
    } catch (err) {
      this.logger.error('Failed to broadcast file deletion:', err);
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
