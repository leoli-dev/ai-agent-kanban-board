import { useEffect, useRef } from 'react';
import type { WsServerMessage } from '@akb/shared';

type Listener = (msg: WsServerMessage) => void;

/**
 * Singleton WebSocket client with auto-reconnect and topic re-subscription.
 * Components register listeners + topics via useWsTopics.
 */
class WsClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private topics = new Map<string, number>(); // topic -> refcount
  private reconnectDelay = 1000;
  private reconnectListeners = new Set<() => void>();

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}/ws`);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectDelay = 1000;
      const topics = [...this.topics.keys()];
      if (topics.length) socket.send(JSON.stringify({ type: 'subscribe', topics }));
      this.reconnectListeners.forEach((fn) => fn());
    };
    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as WsServerMessage;
        this.listeners.forEach((fn) => fn(msg));
      } catch {
        /* ignore malformed */
      }
    };
    socket.onclose = () => {
      this.socket = null;
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
    };
  }

  onMessage(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called after a reconnect so callers can refetch missed state. */
  onReconnect(fn: () => void): () => void {
    this.reconnectListeners.add(fn);
    return () => this.reconnectListeners.delete(fn);
  }

  subscribe(topics: string[]): () => void {
    const fresh: string[] = [];
    for (const t of topics) {
      const n = this.topics.get(t) ?? 0;
      this.topics.set(t, n + 1);
      if (n === 0) fresh.push(t);
    }
    if (fresh.length && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'subscribe', topics: fresh }));
    }
    return () => {
      const gone: string[] = [];
      for (const t of topics) {
        const n = (this.topics.get(t) ?? 1) - 1;
        if (n <= 0) {
          this.topics.delete(t);
          gone.push(t);
        } else this.topics.set(t, n);
      }
      if (gone.length && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'unsubscribe', topics: gone }));
      }
    };
  }
}

export const wsClient = new WsClient();

export function useWsTopics(topics: string[], onMessage: Listener): void {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;
  const key = JSON.stringify(topics);
  useEffect(() => {
    wsClient.connect();
    const parsed = JSON.parse(key) as string[];
    const unsubTopics = wsClient.subscribe(parsed);
    const unsubMsg = wsClient.onMessage((msg) => handlerRef.current(msg));
    return () => {
      unsubTopics();
      unsubMsg();
    };
  }, [key]);
}
