export interface EmailProvider {
  send(destination: string, subject: string, body: string): Promise<void>
}

// No email/SES provider is wired up yet for the app — same console-logging stand-in as sms.ts.
export const consoleEmailProvider: EmailProvider = {
  async send(destination, subject, body) {
    console.log(`[dev-email] to=${destination} subject="${subject}"\n${body}`)
  },
}
