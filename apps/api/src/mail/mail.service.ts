import { Injectable } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly webOrigin: string;

  constructor() {
    this.transporter = nodemailer.createTransport(process.env.SMTP_URL ?? 'smtp://localhost:1025');
    this.from = process.env.MAIL_FROM ?? 'Nexus CRM <noreply@nexus.local>';
    this.webOrigin = (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',')[0]!;
  }

  get resetBaseUrl(): string {
    return `${this.webOrigin}/reset-password`;
  }

  get inviteBaseUrl(): string {
    return `${this.webOrigin}/accept-invite`;
  }

  async sendPasswordReset(to: string, orgName: string, token: string): Promise<void> {
    const link = `${this.resetBaseUrl}?token=${token}`;
    await this.transporter.sendMail({
      from: this.from,
      to,
      subject: `Reset your Nexus CRM password (${orgName})`,
      text: `You requested a password reset for your ${orgName} workspace.\n\nReset link (expires in 1 hour): ${link}\n\nIf you did not request this, ignore this email.`,
      html: `<p>You requested a password reset for your <strong>${orgName}</strong> workspace.</p><p><a href="${link}">Reset password</a> (expires in 1 hour).</p><p>If you did not request this, ignore this email.</p>`,
    });
  }

  async sendInvite(to: string, orgName: string, roleName: string, token: string): Promise<void> {
    const link = `${this.inviteBaseUrl}?token=${token}`;
    await this.transporter.sendMail({
      from: this.from,
      to,
      subject: `You've been invited to join ${orgName} on Nexus CRM`,
      text: `You've been invited to join ${orgName} as ${roleName}.\n\nAccept invitation (expires in 7 days): ${link}`,
      html: `<p>You've been invited to join <strong>${orgName}</strong> as ${roleName}.</p><p><a href="${link}">Accept invitation</a> (expires in 7 days).</p>`,
    });
  }

  async sendExportReady(to: string, orgName: string, exportId: string): Promise<void> {
    const link = `${this.webOrigin}/settings/privacy?export=${exportId}`;
    await this.transporter.sendMail({
      from: this.from,
      to,
      subject: `Your ${orgName} data export is ready`,
      text: `Your personal data export for ${orgName} is ready to download (expires in 7 days): ${link}`,
      html: `<p>Your personal data export for <strong>${orgName}</strong> is ready.</p><p><a href="${link}">Download export</a> (expires in 7 days).</p>`,
    });
  }

  async sendImportComplete(
    to: string,
    orgName: string,
    entityType: string,
    stats: { created: number; skipped: number; failed: number; total: number },
  ): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to,
      subject: `Your ${orgName} ${entityType} import finished`,
      text:
        `Your import of ${stats.total} ${entityType} rows finished: ` +
        `${stats.created} created, ${stats.skipped} skipped, ${stats.failed} failed.`,
    });
  }
}
