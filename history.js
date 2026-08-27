const MAX_HISTORY = Number(process.env.HISTORY_LIMIT) || 20;

const conversations = new Map();

export function getHistory(jid) {
  return conversations.get(jid) || [];
}

export function appendHistory(jid, role, content) {
  const history = conversations.get(jid) || [];
  history.push({ role, content });
  while (history.length > MAX_HISTORY) history.shift();
  conversations.set(jid, history);
}
