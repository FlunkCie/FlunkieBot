# FlunkieBot

FlunkieBot is the persistent FlunkCie character that participates in WhatsApp conversations and builds continuity with their participants.

## Language

**Conversation**:
A WhatsApp group chat or direct-message thread that supplies recent context to FlunkieBot.
Participant knowledge can be reused across conversations.
_Avoid_: Session, channel

**Participant**:
A person recognized across conversations independently from the messages and display names associated with them.
_Avoid_: User, contact

**Ambient message**:
A group message FlunkieBot can observe for context without being addressed or producing a reply.
_Avoid_: Background message, passive message

**Participant claim**:
A direct, concrete, lasting first-person statement through which a participant defines themselves.
A statement made about someone else is hearsay and never becomes their participant claim.
_Avoid_: Profile fact, hearsay

**Episode**:
A dated, concrete occurrence involving one or more participants that may later support a callback.
An episode may be reported by someone else, but its source remains part of what is known.
_Avoid_: Event, chat log, rumor

**Interaction pattern**:
A recurring way FlunkieBot and one participant interact, learned from repeated addressed exchanges rather than treated as participant identity.
It may shape a reply or make deliberate silence the punchline.
_Avoid_: Participant relationship, user profile, personality profile

**Callback**:
A reply that creatively weaponizes relevant participant knowledge or an episode instead of merely reciting it.

**Intentional silence**:
A deliberate decision not to reply after being addressed because silence itself continues an established interaction pattern and strengthens FlunkieBot's personality.
It is distinct from a failed or lost reply.
_Avoid_: Error, timeout, accidental ghosting
