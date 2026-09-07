import type { EmailMessage, Mailer } from "../../src/lib/mailer.ts";

export interface FakeMailer extends Mailer {
  readonly messages: EmailMessage[];
  /** The most recent message sent to `to`, or undefined. */
  lastTo(to: string): EmailMessage | undefined;
  /** The first URL in the most recent message to `to`. */
  lastLink(to: string): string;
}

/**
 * The payoff of Mailer being an interface: verification and reset tokens are
 * captured in-process, so the tests follow exactly the link a real user would
 * click without any mail service existing.
 */
export const createFakeMailer = (): FakeMailer => {
  const messages: EmailMessage[] = [];

  const lastTo = (to: string): EmailMessage | undefined =>
    [...messages].reverse().find((message) => message.to === to);

  return {
    messages,
    lastTo,
    send: async (message) => {
      messages.push(message);
    },
    lastLink: (to) => {
      const message = lastTo(to);
      if (!message) throw new Error(`No email was sent to ${to}`);

      const match = /https?:\/\/\S+/.exec(message.text);
      if (!match) throw new Error(`No link in the email sent to ${to}`);

      return match[0];
    },
  };
};
