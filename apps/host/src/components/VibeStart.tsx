import { tr } from '../lib/i18n';
/**
 * A new Vibe chat's first screen while it has no project folder: Vibe works in one folder per project (the code, its git save points and
 * the project book live there), so the folder comes first. Pick a recent project, or choose a folder with the system's folder dialog
 * (where a new, empty folder can be made for something new). The message box sends nothing until a folder is chosen (screens/Chat.tsx).
 */
import { useState } from 'react';
import { chooseChatFolder } from '../lib/chat-folder';
import { plainFailureText } from '../lib/plain-errors';
import { pushToast } from '../lib/store';
import type { Session } from '../lib/types';
import { RecentProjects } from './RecentProjects';
import { Btn, Icon } from './ui';

/** Opens the system's folder dialog for this chat; a failure is said in plain words. */
export async function pickVibeFolder(chatId: string) {
  try { return await chooseChatFolder(chatId); }
  catch (e) { pushToast('error', tr('No folder was chosen'), plainFailureText(e instanceof Error ? e.message : String(e)).message); return 'cancelled'; }
}

export function VibeStart({ session }: { session: Session }) {
  const [busy, setBusy] = useState(false);
  const choose = async () => { setBusy(true); try { await pickVibeFolder(session.id); } finally { setBusy(false); } };
  return <section className="vibe-start" aria-label={tr('Pick a project folder')}>
    <div className="vibe-start__head"><Icon name="bolt" size={22} /><h2 className="h4">{tr('First, pick a project folder')}</h2></div>
    <p className="small muted">{tr('Vibe works in one folder per project: everything it builds, its save points and the project book live there. Continue a recent project, or choose a folder. For something new, make an empty folder in the dialog.')}</p>
    <Btn variant="primary" icon="folder-plus" disabled={busy} onClick={() => void choose()}>{tr('Choose a folder…')}</Btn>
    <p className="xs muted vibe-start__or">{tr('Or continue a recent project')}</p>
    <RecentProjects session={session} simple />
  </section>;
}
