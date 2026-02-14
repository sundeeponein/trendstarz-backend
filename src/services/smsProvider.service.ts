export interface SmsProvider {
  send(mobile: string, message: string): Promise<void>;
}

// Example implementation (replace with Twilio/MSG91 as needed)
export class DummySmsProvider implements SmsProvider {
  async send(mobile: string, message: string): Promise<void> {
    // Integrate with real provider here
    console.log(`Sending SMS to ${mobile}: ${message}`);
  }
}
