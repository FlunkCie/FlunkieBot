# FlunkieBot

FlunkieBot is the persistent FlunkCie character that participates in WhatsApp conversations and builds continuity with their participants.

## Language

**Conversation**:
A WhatsApp group chat or direct-message thread that supplies recent context to FlunkieBot. Participant knowledge can be reused across conversations.
_Avoid_: Session, channel

**Participant**:
A person recognized across conversations independently from the messages and display names associated with them.
_Avoid_: User, contact

**Ambient message**:
A group message FlunkieBot can observe for context without being addressed or producing a reply.
_Avoid_: Background message, passive message

**Durable memory**:
Participant knowledge selected from conversation evidence and retained permanently for possible later recall.
A durable memory is a participant claim, episode, or interaction pattern.
_Avoid_: Chat history, running gag

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

**Evidence snapshot**:
The minimal source context retained with a durable memory so FlunkieBot does not turn a report or joke into an unsupported fact after recent conversation history expires.
_Avoid_: Transcript, citation

**Callback**:
A reply that creatively weaponizes relevant participant knowledge or an episode instead of merely reciting it.

**Initiative**:
One message FlunkieBot sends without having been addressed, to a single participant who already started a direct-message conversation with him.
It is bounded by a budget rather than by its occasion, and every one that was actually delivered is recorded, including whether it was ever answered.
_Avoid_: Notification, broadcast, nudge campaign

**Occasion**:
The reason an initiative exists at this moment: someone being discussed in a group while absent, or a durable memory that has become ripe.
A name dropped in a one-on-one thread is a private remark and is never an occasion.
An occasion only ever selects which moment is taken; it never decides how many initiatives are sent.
_Avoid_: Trigger, event

**Intentional silence**:
A deliberate decision not to reply after being addressed because silence itself continues an established interaction pattern and strengthens FlunkieBot's personality.
It is distinct from a failed or lost reply.
_Avoid_: Error, timeout, accidental ghosting
