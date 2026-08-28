/**
 * Builds a normalized incoming message as chat orchestration expects one.
 * `observedAt` stays undefined unless a test pins it, so the injected clock
 * decides observation time and participant creation order.
 */
export function incoming(overrides = {}) {
  const {
    address = '3120000@s.whatsapp.net',
    kind = 'direct',
    id = 'IN-1',
    text = 'hoi',
    observedAt = undefined,
    addressed = kind === 'direct',
    senderLabel = 'Alex',
    senderAlias = { kind: 'phone', value: '31600000001@s.whatsapp.net' },
    pairedAlias = null,
    conversationLabel = null,
  } = overrides;

  return {
    conversationAddress: address,
    conversationKind: kind,
    conversationLabel,
    whatsappMessageId: id,
    text,
    observedAt,
    addressed,
    senderLabel,
    senderAlias,
    pairedAlias,
    quoted: null,
  };
}

/** An observation as the memory module's first operation expects one. */
export function observation(overrides = {}) {
  const message = incoming(overrides);
  return {
    conversationAddress: message.conversationAddress,
    conversationKind: message.conversationKind,
    conversationLabel: message.conversationLabel,
    whatsappMessageId: message.whatsappMessageId,
    direction: overrides.direction ?? 'incoming',
    text: message.text,
    observedAt: message.observedAt,
    addressed: message.addressed,
    senderLabel: message.senderLabel,
    senderAlias: message.senderAlias,
    pairedAlias: message.pairedAlias,
  };
}
