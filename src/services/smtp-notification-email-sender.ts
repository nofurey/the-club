import nodemailer from "nodemailer";

import type { NotificationEmail, NotificationEmailSender } from "./notification-email-delivery";

export interface SmtpNotificationEmailOptions {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  user?: string;
  password?: string;
}

export class SmtpNotificationEmailSender implements NotificationEmailSender {
  private readonly transporter: ReturnType<typeof nodemailer.createTransport>;

  constructor(private readonly options: SmtpNotificationEmailOptions) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      ...(options.user && options.password ? { auth: { user: options.user, pass: options.password } } : {}),
    });
  }

  async send(email: NotificationEmail): Promise<void> {
    await this.transporter.sendMail({
      from: this.options.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
    });
  }

  close(): void {
    this.transporter.close();
  }
}

export function createSmtpNotificationEmailSender(environment: NodeJS.ProcessEnv = process.env): SmtpNotificationEmailSender | null {
  const host = environment.NOTIFICATION_SMTP_HOST?.trim();
  const from = environment.NOTIFICATION_SMTP_FROM?.trim();
  if (!host && !from) return null;
  if (!host || !from) {
    throw new Error("NOTIFICATION_SMTP_HOST and NOTIFICATION_SMTP_FROM must both be configured.");
  }

  const user = environment.NOTIFICATION_SMTP_USER?.trim() || undefined;
  const password = environment.NOTIFICATION_SMTP_PASSWORD || undefined;
  if (Boolean(user) !== Boolean(password)) {
    throw new Error("Both NOTIFICATION_SMTP_USER and NOTIFICATION_SMTP_PASSWORD must be configured together.");
  }

  const port = Number(environment.NOTIFICATION_SMTP_PORT ?? "587");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("NOTIFICATION_SMTP_PORT must be a valid TCP port.");
  }

  return new SmtpNotificationEmailSender({
    host,
    port,
    secure: environment.NOTIFICATION_SMTP_SECURE === "true",
    from,
    user,
    password,
  });
}