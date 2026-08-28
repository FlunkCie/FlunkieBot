/** A fake WhatsApp sender: records sends and presence, never touches network. */
export function createFakeSender({ clock, failSend = false } = {}) {
  const sent = [];
  const presence = [];
  let counter = 0;

  return {
    sent,
    presence,
    failSend,
    async sendText(conversationAddress, text) {
      if (this.failSend) throw new Error('WhatsApp send failed');
      counter += 1;
      const message = {
        whatsappMessageId: `OUT-${counter}`,
        text,
        sentAt: clock ? clock.now() : Date.now(),
        conversationAddress,
      };
      sent.push(message);
      return message;
    },
    async sendPresence(conversationAddress, state) {
      presence.push({ conversationAddress, state });
    },
  };
}
