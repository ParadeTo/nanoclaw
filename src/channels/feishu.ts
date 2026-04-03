/**
 * Feishu (Lark) channel — WebSocket (Long Connection) mode.
 *
 * Required Feishu app permissions:
 *   im:message              — receive messages
 *   im:message:send_as_bot  — send messages
 *   im:chat                 — read chat info
 *   contact:user.base:readonly — resolve sender names (optional, falls back to open_id)
 *
 * Required env vars:
 *   FEISHU_APP_ID     — App ID from Feishu Open Platform
 *   FEISHU_APP_SECRET — App Secret
 *
 * Optional env vars:
 *   FEISHU_MAIN_CHAT_ID — chat_id to auto-register as main group on startup
 *
 * JID format: feishu:{chat_id}
 * Works for both P2P chats and group chats (Feishu chat_ids are globally unique).
 */

import * as lark from '@larksuiteoapi/node-sdk';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

class FeishuChannel implements Channel {
  readonly name = 'feishu';

  private client: lark.Client;
  private wsClient: lark.WSClient;
  private connected = false;
  private nameCache = new Map<string, string>(); // open_id → display name
  private botOpenId = ''; // bot's own open_id, fetched on connect

  constructor(
    private opts: ChannelOpts,
    appId: string,
    appSecret: string,
    private mainChatId?: string,
  ) {
    this.client = new lark.Client({ appId, appSecret });
    this.wsClient = new lark.WSClient({ appId, appSecret });
  }

  async connect(): Promise<void> {
    // Fetch bot's own open_id so we can detect when it's @mentioned.
    // Falls back to FEISHU_BOT_OPEN_ID env var if the API call fails.
    this.botOpenId = process.env.FEISHU_BOT_OPEN_ID ?? '';
    if (!this.botOpenId) {
      try {
        const res = await this.client.request({
          method: 'GET',
          url: '/open-apis/bot/v3/info',
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.botOpenId = (res as any)?.bot?.open_id ?? '';
        if (this.botOpenId) {
          logger.info(
            { botOpenId: this.botOpenId },
            'Feishu: fetched bot open_id',
          );
        }
      } catch (err) {
        logger.warn(
          { err },
          'Feishu: failed to fetch bot open_id, mention detection disabled',
        );
      }
    }

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        await this.handleIncomingMessage(data).catch((err) =>
          logger.error({ err }, 'Feishu: error handling incoming message'),
        );
      },
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    this.connected = true;
    logger.info('Feishu channel connected via WebSocket');

    // Auto-register main channel if configured
    if (this.mainChatId) {
      const jid = `feishu:${this.mainChatId}`;
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) {
        this.opts.onChatMetadata(
          jid,
          new Date().toISOString(),
          'Feishu Main',
          'feishu',
          false,
        );
        logger.info({ jid }, 'Feishu: pre-registered main chat from env');
      }
    }
  }

  private async handleIncomingMessage(data: {
    message: {
      message_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
      create_time?: string;
      mentions?: Array<{
        key: string;
        id?: { open_id?: string };
        name?: string;
      }>;
    };
    sender?: { sender_id?: { open_id?: string } };
  }): Promise<void> {
    const msg = data.message;

    // Only handle text messages
    if (msg.message_type !== 'text') return;

    const chatId = msg.chat_id;
    if (!chatId) return;
    const jid = `feishu:${chatId}`;
    const isGroup = msg.chat_type === 'group';
    const openId = data.sender?.sender_id?.open_id ?? '';
    const senderName = await this.getSenderName(openId);
    const timestamp = new Date(parseInt(msg.create_time ?? '0')).toISOString();

    let content: string;
    try {
      content = (JSON.parse(msg.content ?? '') as { text: string }).text ?? '';
    } catch {
      logger.warn(
        { messageId: msg.message_id },
        'Feishu: failed to parse message content',
      );
      return;
    }

    if (!content.trim()) return;

    // Detect if the bot was @mentioned via Feishu's native mention data.
    // If so, normalize the mention key (e.g. "@_user_1") to "@AssistantName"
    // so trigger detection works regardless of how the user typed the mention.
    const assistantName = this.opts.assistantName ?? 'Andy';
    const botMention = this.botOpenId
      ? msg.mentions?.find((m) => m.id?.open_id === this.botOpenId)
      : undefined;
    if (botMention) {
      content = content.replace(botMention.key, `@${assistantName}`).trim();
    }

    this.opts.onChatMetadata(jid, timestamp, undefined, 'feishu', isGroup);

    // Auto-register unregistered groups when bot is first @mentioned
    if (botMention && this.opts.autoRegisterGroup) {
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) {
        this.opts.autoRegisterGroup(jid, jid, isGroup);
      }
    }

    const newMsg: NewMessage = {
      id: msg.message_id ?? '',
      chat_jid: jid,
      sender: openId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    };

    this.opts.onMessage(jid, newMsg);
  }

  private async getSenderName(openId: string): Promise<string> {
    const cached = this.nameCache.get(openId);
    if (cached) return cached;

    try {
      const res = await this.client.contact.user.get({
        params: { user_id_type: 'open_id' },
        path: { user_id: openId },
      });
      const name = res.data?.user?.name ?? openId;
      this.nameCache.set(openId, name);
      return name;
    } catch {
      // Fallback to open_id — enterprise may restrict contact API
      return openId;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace('feishu:', '');
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    // WSClient auto-reconnects; setting connected=false prevents new message routing.
    // The WebSocket connection itself closes when the process exits.
  }
}

registerChannel('feishu', (opts: ChannelOpts) => {
  const env = readEnvFile([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_MAIN_CHAT_ID',
  ]);
  const appId = process.env.FEISHU_APP_ID ?? env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET ?? env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  return new FeishuChannel(opts, appId, appSecret, env.FEISHU_MAIN_CHAT_ID);
});
