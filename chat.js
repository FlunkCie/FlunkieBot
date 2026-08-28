// Chat orchestration. It owns WhatsApp normalization, addressed-message
// routing, per-conversation ordering, presence updates, sending, and
// coordination across the memory and reply-generation interfaces.
//
// It has two entry points: `handleMessage` for an incoming message, and
// `considerInitiative` for the unprompted message that may piggyback on a turn
// that was just handled.
//
// It issues no SQL, constructs no prompts, validates no model output, and never
// calls a provider adapter directly. It also decides nothing about who gets an
// unprompted message or when: that is memory policy.

export const FAILURE_NOTIFICATION_TEXT =
  'Kankerzooi, mijn orakel ligt plat. Probeer het straks nog eens.';

export function createChat({ memory, replyGeneration, sender, logger, clock = () => Date.now() }) {
  // One FIFO promise queue per normalized conversation address: messages in one
  // conversation can never race or reorder, while different conversations may
  // wait on different providers concurrently.
  //
  // The queue slot spans observation up to and including the sent reply and its
  // committed turn outcome. Remembering happens behind that slot, so extraction
  // never adds latency to the next message in the same conversation. The
  // returned promise still settles only once that follow-up work is done.
  const queues = new Map();

  function enqueue(conversationAddress, task) {
    const previous = queues.get(conversationAddress) ?? Promise.resolve();
    const replied = previous.then(task, task);
    queues.set(
      conversationAddress,
      replied.then(
        () => {},
        () => {}
      )
    );
    return replied.then((result) => result?.background);
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

  // The outcome is committed before this returns; the promise it hands back
  // covers only the remembering that follows, which the caller keeps out of the
  // conversation's FIFO slot.
  function finish(addressedTurnId, outcome) {
    if (addressedTurnId === null) return Promise.resolve();
    let settling;
    try {
      settling = memory.finishAddressedTurn(addressedTurnId, outcome);
    } catch (err) {
      logger?.error?.({ err, addressedTurnId }, 'Failed to finish addressed turn');
      return Promise.resolve();
    }
    return Promise.resolve(settling).then(
      () => {},
      (err) => {
        logger?.error?.({ err, addressedTurnId }, 'Failed to finish addressed turn');
      }
    );
  }

  async function respond(message, addressedTurnId) {
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
      return {
        background: finish(addressedTurnId, {
          kind: 'failed',
          stage: 'generation',
          notificationMessage,
        }),
      };
    }

    if (outcome.kind === 'silence') {
      logger?.info?.({ conversationAddress: message.conversationAddress }, 'Intentional silence');
      return {
        background: finish(addressedTurnId, { kind: 'intentional-silence' }),
        completedTurnId: addressedTurnId,
      };
    }

    let sentMessage;
    try {
      sentMessage = await sender.sendText(message.conversationAddress, outcome.text, {
        quoted: message.quoted,
      });
    } catch (err) {
      logger?.error?.({ err }, 'Failed to send reply');
      return {
        background: finish(addressedTurnId, {
          kind: 'failed',
          stage: 'send',
          notificationMessage: null,
        }),
      };
    }

    return {
      background: finish(addressedTurnId, { kind: 'reply-sent', sentMessage }),
      completedTurnId: addressedTurnId,
    };
  }

  // An unprompted message piggybacks on a turn FlunkieBot just handled: no
  // scheduler, no background loop, and no outgoing traffic in an otherwise
  // silent account. Whether anything is sent at all is entirely the memory
  // module's call; orchestration only carries out what it hands back.
  async function sendInitiative(prepared) {
    const address = prepared.conversationAddress;

    let outcome;
    try {
      outcome = await replyGeneration.generateInitiative(prepared.context);
    } catch (err) {
      logger?.warn?.({ err, address }, 'All providers failed for an unprompted message, sending nothing');
      await memory.finishInitiative(prepared.initiativeId, { kind: 'not-sent' });
      return;
    }

    try {
      await sender.sendPresence?.(address, 'composing');
    } catch (err) {
      logger?.warn?.({ err }, 'Failed to send composing presence');
    }

    try {
      let sentMessage;
      try {
        sentMessage = await sender.sendText(address, outcome.text);
      } catch (err) {
        logger?.error?.({ err, address }, 'Failed to send an unprompted message');
        await memory.finishInitiative(prepared.initiativeId, { kind: 'not-sent' });
        return;
      }

      // The message is out. A recording failure is reported and nothing more:
      // abandoning it here would hand its budget slot back for a message that
      // has already arrived.
      try {
        await memory.finishInitiative(prepared.initiativeId, { kind: 'sent', sentMessage });
        logger?.info?.({ address, occasion: prepared.context.occasion }, 'Sent an unprompted message');
      } catch (err) {
        logger?.error?.({ err, address }, 'Sent an unprompted message but could not record it');
      }
    } finally {
      try {
        await sender.sendPresence?.(address, 'paused');
      } catch (err) {
        logger?.warn?.({ err }, 'Failed to send paused presence');
      }
    }
  }

  async function considerInitiative(completedTurnId = null) {
    let prepared;
    try {
      prepared = await memory.prepareInitiative(completedTurnId);
    } catch (err) {
      logger?.warn?.({ err }, 'Could not consider an unprompted message');
      return;
    }
    if (!prepared) return;

    return enqueue(prepared.conversationAddress, () => sendInitiative(prepared)).catch((err) => {
      logger?.error?.({ err }, 'Unhandled error while sending an unprompted message');
    });
  }

  async function process(message) {
    // Every supported incoming message is observed before reply routing,
    // including ambient group messages.
    const observed = await observe(message);

    if (!message.addressed) return null;

    // Observation succeeded but handed back no addressed turn: this envelope was
    // already answered before a reconnect replayed it. Replying again would
    // duplicate the reply, the turn outcome and the extraction work.
    if (observed && observed.addressedTurnId === null) {
      logger?.debug?.(
        { whatsappMessageId: message.whatsappMessageId },
        'Skipping a replayed addressed message that was already handled'
      );
      return null;
    }

    try {
      await sender.sendPresence?.(message.conversationAddress, 'composing');
    } catch (err) {
      logger?.warn?.({ err }, 'Failed to send composing presence');
    }

    try {
      const result = await respond(message, observed?.addressedTurnId ?? null);
      if (result?.completedTurnId === undefined || result.completedTurnId === null) return result;
      // Both the remembering and the initiative run behind the FIFO slot, so
      // neither delays the next message in this conversation.
      return {
        background: Promise.all([
          result.background,
          considerInitiative(result.completedTurnId),
        ]).then(() => {}),
      };
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

    /**
     * The second entry point, taken after a completed turn. Selection happens
     * first because it is what decides who the recipient is; the send itself
     * then runs in the FIFO slot of that *recipient*, never of the conversation
     * that triggered it, so an unprompted message can never cut in front of a
     * message arriving from the same person at the same moment.
     */
    considerInitiative,
  };
}
