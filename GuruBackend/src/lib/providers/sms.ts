export interface SmsProvider {
  send(destination: string, code: string): Promise<void>
  // Free-text SMS (e.g. the parental-consent message, which carries its own wording).
  sendMessage(destination: string, text: string): Promise<void>
}

// Test mode keeps what was "sent" so tests can read OTP codes out of the message, as with the mailer's outbox.
export const smsOutbox: { to: string; text: string }[] = []

// No SMS gateway is wired up yet — this just logs to the server console. Swap for a real
// provider by writing another class with the same interface, not by changing call sites.
export const consoleSmsProvider: SmsProvider = {
  async send(destination, code) {
    console.log(`[dev-sms] OTP for ${destination}: ${code}`)
  },
  async sendMessage(destination, text) {
    if (process.env.NODE_ENV === 'test') smsOutbox.push({ to: destination, text })
    else console.log(`[dev-sms] to ${destination}: ${text}`)
  },
}
