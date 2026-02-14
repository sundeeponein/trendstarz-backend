export interface EmailProvider {
  send(to: string, subject: string, html: string): Promise<void>;
}

// Example implementation (replace with SendGrid/Mailgun as needed)
export class DummyEmailProvider implements EmailProvider {
  async send(to: string, subject: string, html: string): Promise<void> {
    // Integrate with real provider here
    console.log(`Sending email to ${to}: ${subject}`);
  }
}
