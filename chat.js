// Chat orchestration. It owns WhatsApp normalization, addressed-message
// routing, per-conversation ordering, presence updates, sending, and
// coordination across the memory and reply-generation interfaces.
//
// It issues no SQL, constructs no prompts, validates no model output, and never
// calls a provider adapter directly.

export const FAILURE_NOTIFICATION_TEXT =
  'Kankerzooi, mijn orakel ligt plat. Probeer het straks nog eens.';

export function createChat({ memory, replyGeneration, sender, logger, clock = () => Date.now() }) {
  // One FIFO promise queue per normalized conversation address: messages in one
  // conversation can never race or reorder, while different conversations may
  // wait on different providers concurrently.
  const queues = new Map();

  function enqueue(conversationAddress, task) {
    const previous = queues.get(conversationAddress) ?? Promise.resolve();
    const next = previous.then(task, task);
    queues.set(
      conversationAddress,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }

  async function observe(message) {
    try {
      return await memory.observeMessage({
        conversationAddress: message.conversationAddress,
        conversationKind: message.conversationKind,
        conversationLabel: message.conversationLabel ?? null,
        whatsappMessageId: message.whatsappMessageId,
        direction: 'incoming',
        text: message.text,
        observedAt: message.observedAt ?? clock(),
        addressed: message.addressed,
        senderLabel: message.senderLabel ?? null,
        senderAlias: message.senderAlias ?? null,
        pairedAlias: message.pairedAlias ?? null,
      });
    } catch (err) {
      // A persistence failure is logged and may degrade to a current-message-only
      // reply, but it never creates in-memory durable state.
      logger?.error?.({ err, conversationAddress: message.conversationAddress }, 'Failed to observe message');
      return null;
    }
  }

  // The degraded reply context used when persistence or context loading failed.
  // It carries only the current message; no memory is ever fabricated.
  function currentMessageOnlyContext(message) {
    return {
      conversation: { kind: message.conversationKind, label: message.conversationLabel ?? null },
      addressedParticipant: { id: null, label: message.senderLabel ?? null },
      messageToAnswer: { messageId: null, text: message.text },
      recentMessages: [],
      retrievedMemory: null,
    };
  }

  async function finish(addressedTurnId, outcome) {
    if (addressedTurnId === null) return;
    try {
      await memory.finishAddressedTurn(addressedTurnId, outcome);
    } catch (err) {
      logger?.error?.({ err, addressedTurnId }, 'Failed to finish addressed turn');
    }
  }

  async function respond(message, observed) {
    const addressedTurnId = observed?.addressedTurnId ?? null;

    let replyContext;
    if (addressedTurnId !== null) {
      try {
        replyContext = await memory.prepareAddressedTurn(addressedTurnId);
      } catch (err) {
        logger?.warn?.({ err }, 'Could not prepare addressed turn, replying from the current message only');
        replyContext = currentMessageOnlyContext(message);
      }
    } else {
      replyContext = currentMessageOnlyContext(message);
    }

    let outcome;
    try {
      outcome = await replyGeneration.generateReply(replyContext);
    } catch (err) {
      logger?.error?.({ err }, 'All reply providers failed');
      // Exhausted reply fallback is a generation failure, never intentional
      // silence. Attempt exactly one fixed in-character notification.
      let notificationMessage = null;
      try {
        notificationMessage = await sender.sendText(
          message.conversationAddress,
          FAILURE_NOTIFICATION_TEXT,
          { quoted: message.quoted }
        );
      } catch (sendErr) {
        logger?.error?.({ err: sendErr }, 'Failed to send the fixed failure notification');
      }
      await finish(addressedTurnId, {
        kind: 'failed',
        stage: 'generation',
        notificationMessage,
      });
      return;
    }

    if (outcome.kind === 'silence') {
      logger?.info?.({ conversationAddress: message.conversationAddress }, 'Intentional silence');
      await finish(addressedTurnId, { kind: 'intentional-silence' });
      return;
    }

    let sentMessage;
    try {
      sentMessage = await sender.sendText(message.conversationAddress, outcome.text, {
        quoted: message.quoted,
      });
    } catch (err) {
      logger?.error?.({ err }, 'Failed to send reply');
      await finish(addressedTurnId, { kind: 'failed', stage: 'send', notificationMessage: null });
      return;
    }

    await finish(addressedTurnId, { kind: 'reply-sent', sentMessage });
  }

  async function process(message) {
    // Every supported incoming message is observed before reply routing,
    // including ambient group messages.
    const observed = await observe(message);

    if (!message.addressed) return;

    try {
      await sender.sendPresence?.(message.conversationAddress, 'composing');
    } catch (err) {
      logger?.warn?.({ err }, 'Failed to send composing presence');
    }

    try {
      await respond(message, observed);
    } finally {
      try {
        await sender.sendPresence?.(message.conversationAddress, 'paused');
      } catch (err) {
        logger?.warn?.({ err }, 'Failed to send paused presence');
      }
    }
  }

  return {
    /** Routes one normalized message through its conversation's FIFO queue. */
    handleMessage(message) {
      return enqueue(message.conversationAddress, () => process(message));
    },
  };
}
