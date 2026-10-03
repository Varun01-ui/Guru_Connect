import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { env } from '../config/env.js'

export type Mail = { to: string; subject: string; text: string }

// Test mode keeps an in-memory outbox so tests can assert on (and read links out of) sent mail.
export const outbox: Mail[] = []

let transport: Transporter | null = null

function getTransport() {
  transport ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  })
  return transport
}

// Never throws: a mail outage must not fail a login or password reset. Failures are logged instead.
export async function sendMail(mail: Mail): Promise<void> {
  try {
    if (env.NODE_ENV === 'test') {
      outbox.push(mail)
      return
    }
    if (!env.SMTP_HOST) {
      console.log(`[dev-email] to=${mail.to} subject="${mail.subject}"\n${mail.text}`)
      return
    }
    await getTransport().sendMail({ from: env.MAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text })
  } catch (err) {
    console.error(`[mailer] failed to send "${mail.subject}" to ${mail.to}:`, err instanceof Error ? err.message : err)
  }
}
