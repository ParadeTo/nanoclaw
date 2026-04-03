import http from 'http';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const DEFAULT_PORT = 3200;

export class WebhookChannel implements Channel {
  name = 'webhook';

  private server: http.Server | null = null;
  private port: number;
  private linkedJid: string;
  private siblingChannels: Channel[] = [];
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;

  constructor(
    port: number,
    linkedJid: string,
    onMessage: OnInboundMessage,
    onChatMetadata: OnChatMetadata,
  ) {
    this.port = port;
    this.linkedJid = linkedJid;
    this.onMessage = onMessage;
    this.onChatMetadata = onChatMetadata;
  }

  setSiblingChannels(channels: Channel[]): void {
    this.siblingChannels = channels;
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (req.method === 'POST' && req.url === '/webhook') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1_000_000) {
            res.writeHead(413);
            res.end('Payload too large');
            req.destroy();
          }
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const jid = 'webhook:default';
            const timestamp = new Date().toISOString();
            const msgId = `wh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const senderName: string = data.sender || 'webhook';
            // Pass raw JSON as message content — business logic lives in CLAUDE.md
            const content: string = typeof data.message === 'string'
              ? data.message
              : JSON.stringify(data);

            this.onChatMetadata(jid, timestamp, 'Webhook', 'webhook', false);
            this.onMessage(jid, {
              id: msgId,
              chat_jid: jid,
              sender: 'webhook',
              sender_name: senderName,
              content,
              timestamp,
              is_from_me: false,
            });

            logger.info({ sender: senderName, length: content.length }, 'Webhook message received');
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'accepted', id: msgId }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, () => {
        logger.info({ port: this.port }, 'Webhook server listening');
        console.log(`\n  Webhook: http://localhost:${this.port}/webhook`);
        console.log(`  Health:  http://localhost:${this.port}/health\n`);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    if (!this.linkedJid) {
      logger.warn('Webhook: WEBHOOK_LINKED_JID not set, cannot forward response');
      return;
    }
    const target = this.siblingChannels.find((ch) => ch.ownsJid(this.linkedJid));
    if (!target) {
      logger.warn({ linkedJid: this.linkedJid }, 'Webhook: no channel owns linked JID');
      return;
    }
    await target.sendMessage(this.linkedJid, text);
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('webhook:');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      logger.info('Webhook server stopped');
    }
  }
}

registerChannel('webhook', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['WEBHOOK_PORT', 'WEBHOOK_LINKED_JID']);
  const linkedJid = process.env.WEBHOOK_LINKED_JID || envVars.WEBHOOK_LINKED_JID || '';
  if (!linkedJid) {
    logger.warn('Webhook: WEBHOOK_LINKED_JID not set — skipping');
    return null;
  }
  const port = parseInt(
    process.env.WEBHOOK_PORT || envVars.WEBHOOK_PORT || String(DEFAULT_PORT),
    10,
  );
  return new WebhookChannel(port, linkedJid, opts.onMessage, opts.onChatMetadata);
});
