export interface SmsProvider {
  send(mobile: string, message: string): Promise<void>;
}

// Example implementation (replace with Twilio/MSG91 as needed)
export class DummySmsProvider implements SmsProvider {
  async send(mobile: string, message: string): Promise<void> {
    // FIX #33: Don't log sensitive user info (phone numbers, message content)
    console.warn("[DummySmsProvider] SMS provider not configured. Skipping send.");
    // Integrate with real provider here (Twilio, MSG91, etc.)
  }
}
