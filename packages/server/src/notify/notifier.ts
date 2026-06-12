import { desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AppNotification, NotificationType } from '@akb/shared';
import { schema, type Db } from '../db/index.js';
import { toNotification } from '../db/mappers.js';
import type { SettingsStore } from '../db/settings-store.js';
import type { WsHub } from '../ws/hub.js';
import { macosNotify } from './macos.js';
import { sendEmail } from './email.js';

export class Notifier {
  constructor(
    private db: Db,
    private hub: WsHub,
    private settings: SettingsStore,
  ) {}

  async notify(
    type: NotificationType,
    title: string,
    body: string,
    projectId?: string | null,
  ): Promise<AppNotification> {
    const channels: string[] = ['in-app'];
    const settings = this.settings.get();

    if (settings.notifyMacos) {
      macosNotify(title, body);
      channels.push('macos');
    }
    if (settings.notifyEmail && settings.smtp) {
      try {
        await sendEmail(settings.smtp, title, body);
        channels.push('email');
      } catch {
        /* email failures must never break the pipeline */
      }
    }

    const id = nanoid(10);
    this.db
      .insert(schema.notifications)
      .values({
        id,
        type,
        title,
        body,
        projectId: projectId ?? null,
        channelsSentJson: JSON.stringify(channels),
        createdAt: Date.now(),
      })
      .run();
    const notification = toNotification(
      this.db.select().from(schema.notifications).where(eq(schema.notifications.id, id)).get()!,
    );
    this.hub.publish('global', { type: 'notification.new', notification });
    return notification;
  }

  list(limit = 50): AppNotification[] {
    return this.db
      .select()
      .from(schema.notifications)
      .orderBy(desc(schema.notifications.createdAt))
      .limit(limit)
      .all()
      .map(toNotification);
  }

  markRead(id: string): void {
    this.db
      .update(schema.notifications)
      .set({ read: 1 })
      .where(eq(schema.notifications.id, id))
      .run();
  }
}
