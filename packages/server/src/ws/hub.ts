import type { WebSocket } from 'ws';
import type { WsClientMessage, WsServerMessage } from '@akb/shared';

/**
 * Topic-based pub/sub over WebSocket. Topics: 'global', `board:<projectId>`,
 * `run:<runId>`. Clients send {type:'subscribe', topics:[...]}.
 */
export class WsHub {
  private clients = new Map<WebSocket, Set<string>>();

  register(socket: WebSocket): void {
    this.clients.set(socket, new Set(['global']));
    socket.on('message', (raw) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(String(raw)) as WsClientMessage;
      } catch {
        return;
      }
      const topics = this.clients.get(socket);
      if (!topics) return;
      if (msg.type === 'subscribe') for (const t of msg.topics) topics.add(t);
      else if (msg.type === 'unsubscribe') for (const t of msg.topics) topics.delete(t);
      else if (msg.type === 'ping') this.send(socket, { type: 'pong' });
    });
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
  }

  publish(topic: string, message: WsServerMessage): void {
    const payload = JSON.stringify(message);
    for (const [socket, topics] of this.clients) {
      if (topics.has(topic) && socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }

  private send(socket: WebSocket, message: WsServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }
}
