import nodemailer from 'nodemailer';
import type { Settings } from '@akb/shared';

export async function sendEmail(
  smtp: NonNullable<Settings['smtp']>,
  subject: string,
  body: string,
): Promise<void> {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  await transport.sendMail({
    from: smtp.from,
    to: smtp.to,
    subject: `[Agent Kanban] ${subject}`,
    text: body,
  });
}
