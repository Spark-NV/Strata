/**
 * Did a reply promise questions it never asked? The last paragraph of what the Head wrote talks about asking ("a few questions", "I need
 * to know") and holds no question mark: the person would see an announcement and nothing to answer.
 * Pure; the bridge sends the Head back once to ask with its question tool (agent-bridge.mjs).
 */
export function announcesQuestions(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  const last = t.split(/\n\s*\n/).filter(p => p.trim()).pop() ?? '';
  if (last.includes('?')) return false;
  const talksAboutAsking = /\b(questions?|ask (you|a few|some)|need to (know|pin down|check with you)|clarify|confirm with you|before I (write|start|build|plan))\b/i.test(last);
  return talksAboutAsking;
}
