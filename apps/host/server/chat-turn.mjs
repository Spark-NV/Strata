// The Chat, Code and Vibe turn Strata saves itself (persisted-turn.mjs): the chat as it is written before the model answers.
import { refusal } from './persisted-turn.mjs';
import { photosOf, shortTitle, validMessageId } from './turn-record.mjs';

/** A new message, or Ask again (rewindTo, with an optional edit), of a Chat, Code or Vibe chat: the chat as Strata saves it before the turn. */
export function prepareChatTurn(body, s) {
  const at = new Date().toISOString();
  const msgs = Array.isArray(s.messages) ? s.messages : [];
  const replyId = body.replyId;
  if (!validMessageId(replyId)) throw refusal(400, 'replyId is required.', 'bad-message');
  if (msgs.some(m => m.id === replyId)) throw refusal(409, 'That reply id is already a message in this chat.', 'id-taken');
  let kept, asked = null, before, ids = [];
  if (typeof body.rewindTo === 'string') {
    const i = msgs.findIndex(m => m.id === body.rewindTo && m.role === 'user');
    if (i < 0) throw refusal(400, 'rewindTo must name a message of the person in this chat.', 'bad-message');
    asked = typeof body.edit === 'string' ? { ...msgs[i], content: body.edit } : msgs[i];
    before = msgs.slice(0, i); kept = [...before, asked];
  } else if (body.userMessage && typeof body.userMessage === 'object') {
    const u = body.userMessage;
    if (!validMessageId(u.id) || u.role !== 'user' || typeof u.content !== 'string') throw refusal(400, 'userMessage needs an id, role "user" and content.', 'bad-message');
    const i = msgs.findIndex(m => m.id === u.id);
    asked = i >= 0 ? msgs[i] : { ...u, at: typeof u.at === 'string' ? u.at : at };
    before = i >= 0 ? msgs.slice(0, i) : msgs; kept = i >= 0 ? msgs.slice(0, i + 1) : [...msgs, asked];
    ids.push(asked.id);
  } else if (body.goalAction === 'resume') { before = msgs; kept = msgs; }
  else throw refusal(400, 'userMessage (a new message) or rewindTo (Ask again) is required.', 'bad-message');
  const message = asked ? String(asked.content) : '/goal resume';
  if (asked && !message.trim() && !photosOf(asked).length) throw refusal(400, 'The message is empty.', 'bad-message');
  const reply = { id: replyId, role: 'assistant', content: '', at, streaming: true };
  // The first message names the chat, unless the person (or a roleplay's characters) already named it: defaultTitle false.
  const naming = msgs.length === 0 && asked && s.defaultTitle !== false;
  const session = { ...s, ...(naming ? { title: shortTitle(message.trim() || 'Describe this picture.'), defaultTitle: false } : {}), updatedAt: at, messages: [...kept, reply] };
  return { session, replyId, messageIds: [...ids, replyId], message: message.trim() || (asked && photosOf(asked).length ? 'Describe this picture.' : ''), photos: asked ? photosOf(asked) : [], before };
}
