import { useCallback, useEffect, useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/client';
import { useFolderPrompt } from '../lib/folder-pick';
import { Btn, Dialog, Icon } from './ui';

interface FolderEntry { name: string; path: string; kind: 'folder' | 'file'; hidden?: boolean; project?: boolean }
interface Place { name: string; path: string; kind: string }
interface Listing { path: string; name: string; parent: string | null; refused: string | null; project: boolean; entries: FolderEntry[]; truncated: boolean; places: Place[] }

const PLACE_NAMES: Record<string, string> = { home: 'Home', desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads', projects: 'Projects', workspace: 'Strata workspace' };

/**
 * Choosing a folder where the PC's own folder window cannot open: a page opened from another computer or a phone, or a system with no
 * chooser. It browses the PC's folders (/api/folders), makes a new one, or takes a typed path. "Use this folder" answers the folder on screen.
 */
export function FolderPathDialog() {
  const prompt = useFolderPrompt();
  const [listing, setListing] = useState<Listing | null>(null);
  const [path, setPath] = useState('');
  const [hidden, setHidden] = useState(false);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);

  const open = useCallback(async (target: string, showHidden = hidden) => {
    setBusy(true); setProblem('');
    try {
      const next = await api.get<Listing>(`/api/folders?path=${encodeURIComponent(target)}${showHidden ? '&hidden=1' : ''}`);
      setListing(next); setPath(next.path); setNewName(null);
    } catch (e) { setProblem(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [hidden]);

  useEffect(() => { if (prompt) { setListing(null); setPath(''); setProblem(''); setNewName(null); void open(''); } }, [prompt]); // eslint-disable-line react-hooks/exhaustive-deps

  const make = async () => {
    const name = (newName ?? '').trim();
    if (!name || !listing) return;
    setBusy(true); setProblem('');
    try { const made = await api.post<{ folder: { path: string } }>('/api/folders', { parent: listing.path, name }); setBusy(false); await open(made.folder.path); }
    catch (e) { setProblem(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  // A path typed but not opened yet is what the person means; the host checks it the same way as a browsed one.
  const choose = () => { const typed = path.trim(); const chosen = typed && typed !== listing?.path ? typed : listing?.path; if (chosen) prompt?.resolve(chosen); };
  const folders = listing?.entries.filter(e => e.kind === 'folder') ?? [];

  return <Dialog open={!!prompt} title={tr("Choose a folder")} onClose={() => prompt?.resolve(null)} className="folder-browser"
    actions={<><Btn onClick={() => prompt?.resolve(null)}>{tr("Cancel")}</Btn><Btn variant="primary" disabled={busy || (!path.trim() && !listing) || (!!listing?.refused && path.trim() === listing.path)} onClick={choose}>{tr("Use this folder")}</Btn></>}>
    <div className="stack">
      {prompt?.message ? <p className="small" role="status">{tr(prompt.message)}</p> : null}
      <form className="folder-browser__path" onSubmit={event => { event.preventDefault(); if (path.trim()) void open(path.trim()); }}>
        <Btn size="sm" disabled={busy || !listing?.parent} onClick={() => listing?.parent && void open(listing.parent)} title={tr("Up one folder")} aria-label={tr("Up one folder")}>{tr("Up")}</Btn>
        <input className="st-input" value={path} onChange={event => setPath(event.target.value)} placeholder={tr("/home/you/Documents")} spellCheck={false} aria-label={tr("Folder path")}/>
        <Btn size="sm" type="submit" disabled={busy || !path.trim()}>{tr("Go")}</Btn>
      </form>
      {listing?.places?.length ? <div className="folder-browser__places" role="list" aria-label={tr("Places")}>
        {listing.places.map(place => <button key={place.path} type="button" role="listitem" className={`folder-browser__place${place.path === listing.path ? ' is-here' : ''}`} onClick={() => void open(place.path)} title={place.path}>{tr(PLACE_NAMES[place.kind] ?? place.name)}</button>)}
      </div> : null}
      {listing?.refused ? <p className="small folder-browser__problem">{tr(listing.refused)}</p> : null}
      <ul className="folder-browser__list" aria-label={tr("Folders")} aria-busy={busy}>
        {folders.map(entry => <li key={entry.path}>
          <button type="button" className="folder-browser__entry" onClick={() => void open(entry.path)} title={entry.path}>
            <Icon name="folder"/><span className="folder-browser__name">{entry.name}</span>
            {entry.project ? <span className="folder-browser__tag">{tr("project")}</span> : null}
            <Icon name="chevron"/>
          </button>
        </li>)}
        {listing && !folders.length ? <li className="small folder-browser__empty">{tr("No folders in here.")}</li> : null}
        {listing?.truncated ? <li className="small folder-browser__empty">{tr("Only the first 2,000 are shown. Type the path to go further.")}</li> : null}
      </ul>
      {problem ? <p className="small folder-browser__problem" role="alert">{tr(problem)}</p> : null}
      <div className="folder-browser__tools">
        {newName === null
          ? <Btn size="sm" icon="folder-plus" disabled={busy || !listing || !!listing.refused} onClick={() => setNewName('')}>{tr("New folder")}</Btn>
          : <form className="folder-browser__new" onSubmit={event => { event.preventDefault(); void make(); }}>
              <input className="st-input" autoFocus value={newName} onChange={event => setNewName(event.target.value)} placeholder={tr("Folder name")} aria-label={tr("New folder name")} spellCheck={false}/>
              <Btn size="sm" type="submit" variant="primary" disabled={busy || !newName.trim()}>{tr("Make it")}</Btn>
              <Btn size="sm" onClick={() => setNewName(null)}>{tr("Cancel")}</Btn>
            </form>}
        <label className="small folder-browser__hidden"><input type="checkbox" checked={hidden} onChange={event => { setHidden(event.target.checked); if (listing) void open(listing.path, event.target.checked); }}/> {tr("Show hidden folders")}</label>
      </div>
    </div>
  </Dialog>;
}
