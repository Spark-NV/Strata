import {sessionTitle} from '../lib/session-title';
import { tr } from '../lib/i18n';
import { useNative } from '../lib/native';
import { modelFamilyIcon } from '../lib/model-icons';
/** Quiet navigation, with the same destinations at every window size. */
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { FloatingMenu } from '../components/FloatingMenu';
import { measureScale } from '../lib/overlay-place';
import { QuitStrataDialog } from '../components/QuitStrata';
import { useAppMode } from '../lib/app-mode';
import { href, useLocation, type Route } from '../lib/router';
import { cx, relTime, relTimeShort } from '../lib/format';
import { useMedia } from '../lib/responsive';
import { recentChats, recentChatDescription } from '../lib/recent-chats';
import type { Session } from '../lib/types';
import { MOD, runCommand } from '../lib/commands';
import { bindingFor, bindingKeys, useBindings } from '../lib/shortcut-bindings';
import { Btn, Dialog, Icon, IconBtn, type IconName } from '../components/ui';
import { Brand } from '../components/Brand';
import { deleteSession, go, isUnread, liveChatIds, newSession, profileOf, renameSession, selectSession, setNavOpen, togglePin, toggleRail, setTheme, useStore } from '../lib/store';
import type { SessionProfileId } from '../lib/types';
import { imageModelLine } from '../components/ImageChat';
/** The chat profiles, in the order the sidebar shows them. */
const PROFILE_GROUPS: { id: SessionProfileId; label: string; icon: IconName }[] = [
    { id: 'chat', label: 'Chat', icon: 'chat' },
    { id: 'code', label: 'Code', icon: 'folder' },
    { id: 'vibe', label: 'Vibe', icon: 'bolt' },
    { id: 'rp', label: 'RP', icon: 'skills' },
    { id: 'image', label: 'Image', icon: 'image' },
];
export function Sidebar({ containerRef }: {
    containerRef: RefObject<HTMLElement | null>;
}) {
    useBindings();
    const location = useLocation();
    const compact = useMedia('(max-width: 1279px)');
    const rail = useStore(s => s.rail);
    const theme = useStore(s => s.theme);
    const systemDark = useMedia('(prefers-color-scheme: dark)');
    const dark = theme === 'dark' || theme === 'system' && systemDark;
    const navOpen = useStore(s => s.navOpen);
    const collapsed = compact ? !navOpen : rail;
    const sessions = useStore(s => s.sessions);
    const library = useStore(s => s.library);
    const monitor = useStore(s => s.monitor);
    const profiles = useStore(s => s.profiles);
    const pinned = useStore(s => s.pinned);
    const activeSession = useStore(s => s.activeSession);
    // The chats that have a turn running now (the board reads the same list). The count is what makes this redraw when one starts or ends.
    const liveCount = useStore(s => s.liveChats);
    const working = new Set(liveCount ? liveChatIds() : []);
    const [query, setQuery] = useState('');
    const [searchOpen, setSearchOpen] = useState(false);
    const searchInput = useRef<HTMLInputElement>(null);
    const searchTrigger = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (searchOpen)
            searchInput.current?.focus();
    }, [searchOpen, collapsed]);
    function closeSearch() { setQuery(''); setSearchOpen(false); requestAnimationFrame(() => searchTrigger.current?.focus()); }
    const [recentOpen, setRecentOpen] = useState(false);
    const [includeArchived, setIncludeArchived] = useState(false);
    const [menuId, setMenuId] = useState<string | null>(null);
    const [renameId, setRenameId] = useState<string | null>(null);
    const [name, setName] = useState('');
    const [deleteId, setDeleteId] = useState<string | null>(null);
    const [folders, setFolders] = useState<Record<string, boolean>>({});
    const menuTrigger = useRef<HTMLElement | null>(null);
    const current = library?.variants.find(v => v.id === library.loaded);
    const native = useNative(), nativeCurrent = native?.instances.find(i => i.id === native.defaultId);
    // While the image model has the GPU (Image chats, image-model.mjs) the chip is about it.
    const imageModel = useStore(s => s.imageModel);
    const imageActive = !!imageModel?.enabled && ['freeing', 'loading', 'ready', 'stopping'].includes(imageModel.phase);
    const modelName = (imageActive ? imageModel!.name : null) ?? (pinned?.enabled ? pinned.name : null) ?? nativeCurrent?.label ?? (current?.local ? current.name : current?.family) ?? tr('No model loaded');
    // The version from the catalog and the card it runs on ("Q2_0 · GPU 2"), not the file id.
    const nativeSize = nativeCurrent ? native?.catalog?.families.flatMap(f => f.sizes).find(s => s.id === nativeCurrent.model) : undefined;
    const nativeSecond = nativeCurrent ? [nativeSize?.model ?? nativeCurrent.model.toUpperCase(), nativeCurrent.gpus.length ? nativeCurrent.gpus.map(g => `GPU ${g + 1}`).join(' + ') : ''].filter(Boolean).join(' · ') : null;
    // The pinned model's own state (pinned-model.mjs); released = stopped for a game or after idle time (model-release.mjs).
    const pinnedLine = !pinned?.enabled ? null : pinned.phase === 'ready' ? tr('Running · {0}K context', [Math.round((pinned.context ?? 0) / 1000)]) : pinned.phase === 'error' ? (pinned.error ?? tr('Not running')) : pinned.phase === 'released' ? (pinned.released?.reason === 'game' ? tr('Stopped for a game · starts when you write') : pinned.released?.reason === 'image' ? tr('Stopped for images · starts when you write') : tr('Stopped while idle · starts when you write')) : pinned.phase === 'stopping' ? tr('Stopping…') : pinned.phase === 'checking' ? tr('Checking…') : tr('Starting…');
    const modelQuant = (imageActive ? imageModelLine(imageModel) : null) ?? pinnedLine ?? nativeSecond ?? current?.quant ?? tr('View model versions');
    const phase = nativeCurrent ? (nativeCurrent.status === 'ready' ? nativeCurrent.phase : nativeCurrent.status) : monitor?.phase ?? 'idle';
    const status = imageActive ? (imageModel!.phase === 'ready' ? (imageModel!.job ? 'Generating' : 'Ready') : imageModel!.phase === 'stopping' ? 'Stopping' : 'Loading') : pinned?.enabled ? (pinned.phase === 'ready' ? 'Ready' : pinned.phase === 'error' ? 'Error' : pinned.phase === 'released' ? 'Stopped' : pinned.phase === 'stopping' ? 'Stopping' : 'Loading') : phase === 'unavailable' ? 'Status unavailable' : phase === 'error' ? 'Error' : phase === 'loading' ? 'Loading' : !current && !nativeCurrent ? 'No model loaded' : phase === 'reading' ? 'Reading prompt' : phase === 'thinking' ? 'Thinking' : phase === 'generating' ? 'Generating' : 'Ready';
    // The model is busy with a chat that is not the one in front of the person: the chip says which one (a title, or how many).
    const awayChats = [...working].filter(id => !(location.route === 'chat' && id === activeSession));
    const awayTitle = awayChats.length === 1 ? sessions.find(s => s.id === awayChats[0]) : undefined;
    const workingLine = awayChats.length === 1 && awayTitle ? tr("Working · {0}", [sessionTitle(awayTitle)]) : awayChats.length > 1 ? tr("{0} chats working", [awayChats.length]) : null;
    const menuSession = sessions.find(s => s.id === menuId);
    const q = query.trim().toLowerCase();
    const matching = sessions.filter(s => (!s.archived || q || includeArchived) && (!q || `${sessionTitle(s)} ${s.messages.map(m => m.content).join(' ')}`.toLowerCase().includes(q))).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
    function openMenu(id: string, trigger: HTMLElement) { menuTrigger.current = trigger; setMenuId(id); }
    function closeMenu() { setMenuId(null); menuTrigger.current?.focus(); }
    return <>
    <aside className="nav" ref={containerRef} aria-label={tr("Main navigation")} aria-modal={navOpen && compact ? true : undefined} role={navOpen && compact ? 'dialog' : undefined} tabIndex={-1}>
      <div className="nav__top">{tr(!collapsed ? <a className="nav__brand" href={href('chat')} aria-label={tr("Strata — open chat")}><Brand variant="lockup" height={28} decorative className="nav__brand-lockup"/></a> : null)}<button type="button" className="nav__collapse" aria-label={tr(collapsed ? 'Show sidebar' : 'Hide sidebar')} title={tr(collapsed ? 'Show sidebar' : 'Hide sidebar')} onClick={() => compact ? setNavOpen(!navOpen) : toggleRail()}><Icon name="panel" size={20}/></button></div>
      <div className="nav__scroll">
        {tr(collapsed ? <button className="st-btn st-btn--primary nav-new" aria-label={tr("New chat")} title={tr("New chat")} onClick={() => runCommand('new')}><Icon name="new-chat" size={18}/></button> : null)}
        {tr(collapsed ? <div className="nav-recent" aria-label={tr("Recent chats")}>{tr(recentChats(sessions, activeSession).map((session, index) => <RecentChatLink key={session.id} session={session} slot={index + 1} active={activeSession === session.id && location.route === 'chat'}/>))}</div> : null)}
        {!collapsed ? <div className="ws">
          <div className="ws__head">{tr(searchOpen ? <div className="nav-search"><Icon name="search" size={16}/><input ref={searchInput} className="st-input st-input--bare" type="search" placeholder={tr("Search chats…")} aria-label={tr("Search chats")} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        closeSearch();
                    }
                }}/><IconBtn name="x" title={tr("Close chat search")} onClick={closeSearch}/></div> : <><span className="navgroup__label">{tr("Chats")}</span><div className="ws__tools"><button ref={searchTrigger} type="button" className="st-btn st-btn--icon" aria-label={tr("Search chats")} title={tr("Search chats")} onClick={() => setSearchOpen(true)}><Icon name="search" size={18}/></button></div></>)}</div>
          {PROFILE_GROUPS.map(g => {
                // One group per chat profile (Chat, Code, RP): its own new-chat button and its own chats (server/profiles.mjs).
                const expanded = folders[g.id] !== false || !!q;
                const rows = matching.filter(s => (s.profile === 'image' ? 'image' : profileOf(s)) === g.id);
                const shown = q ? rows : rows.slice(0, 20);
                const name = (g.id === 'image' ? null : profiles?.profiles[g.id]?.name) ?? g.label;
                return <div className="ws__group" key={g.id}>
              <div className="ws__row"><button className="ws__name" aria-expanded={expanded} onClick={() => setFolders(f => ({ ...f, [g.id]: !expanded }))}><Icon name="chevron" size={14} className={cx('ws__chev', expanded && 'is-open')}/><Icon name={g.icon} size={17}/><span>{name}</span></button><button type="button" className="st-btn st-btn--icon ws__new" aria-label={tr("New {0} chat", [name])} title={tr("New {0} chat", [name])} onClick={() => { setNavOpen(false); if (g.id === 'rp') { go('characters'); return; } const s = newSession(g.id); go('chat', s.id); }}><Icon name="new-chat" size={18}/></button></div>
              {tr(expanded ? <div className="navsessions">
                {tr(shown.map(s => <div key={s.id}>
                  <div className="ws__session row"><a className="navsession" href={href('chat', s.id)} data-working={working.has(s.id) || undefined} aria-current={activeSession === s.id && location.route === 'chat' ? 'page' : undefined} onClick={() => selectSession(s.id)} onContextMenu={e => { e.preventDefault(); openMenu(s.id, e.currentTarget); }} title={sessionTitle(s)}>{tr(working.has(s.id) ? <span className="navsession__working" role="img" aria-label={tr("Working")} title={tr("Working")}><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle className="navsession__track" cx="8" cy="8" r="6"/><circle className="navsession__arc" cx="8" cy="8" r="6" pathLength="100"/></svg></span> : null)}<span className="navsession__title">{sessionTitle(s)}</span>{tr(s.pinned ? <span aria-label={tr("Pinned")}><Icon name="pin" size={12}/></span> : <span className="navsession__time">{relTimeShort(s.updatedAt)}</span>)}{tr(!working.has(s.id) && isUnread(s, activeSession) ? <span className="navsession__unread" aria-label={tr("Unread")}/> : null)}{tr(s.archived ? <span className="xs muted">{tr("Archived")}</span> : null)}</a><button className="st-btn st-btn--icon session-overflow" aria-label={tr("Actions for {0}", [sessionTitle(s)])} onClick={e => openMenu(s.id, e.currentTarget)}><Icon name="ellipsis" size={16}/></button></div>
                </div>))}
                {tr(!shown.length ? <p className="small muted ws__empty">{tr(q ? 'No matching chats' : 'No chats yet')}</p> : null)}
                {tr(!q && rows.length > shown.length ? <button className="ws-view small" onClick={() => { setNavOpen(false); setRecentOpen(true); }}>{tr("View all chats")}</button> : null)}
              </div> : null)}
            </div>;
            })}
        </div> : null}
      </div>
      <div className="nav__foot">
        <button className="enginechip" data-state={status === 'Ready' ? 'ready' : ['Reading prompt', 'Thinking', 'Generating', 'Loading'].includes(status) ? 'busy' : 'off'} onClick={() => go(pinned?.enabled ? 'monitor' : 'models')} title={tr("{0} \u00B7 {1} \u00B7 {2}", [modelName, workingLine ?? modelQuant, tr(status)])} aria-label={tr("{0} \u00B7 {1}", [modelName, modelQuant])}><span className="enginechip__family"><Icon name={modelFamilyIcon(current?.family)} size={20}/><span className="enginechip__dot"/></span><span className="enginechip__text nav__rail-hide"><span className="enginechip__title">{modelName}</span><span className="enginechip__sub">{workingLine ?? modelQuant}</span></span></button>
        <NavLink route="skills" label={tr("Skills")} icon="skills" current={location.route}/>
        <NavLink route="monitor" label={tr("Monitor")} icon="activity" current={location.route}/>
        {tr(pinned?.enabled ? null : <NavLink route="models" label={tr("Models")} icon="models" current={location.route === 'tuning' ? 'models' : location.route}/>)}
        <div className="nav__bottom"><MoreMenu current={location.route}/><button className="st-btn st-btn--icon theme-switch" aria-label={tr(dark ? 'Switch to light mode' : 'Switch to dark mode')} title={tr(dark ? 'Switch to light mode' : 'Switch to dark mode')} onClick={() => setTheme(dark ? 'light' : 'dark')}><span key={String(dark)} className="theme-switch__icon"><Icon name={dark ? 'sun' : 'moon'} size={19}/></span></button></div>
      </div>
    </aside>
    {tr(menuId && menuSession ? <FloatingMenu anchor={menuTrigger.current} title={tr("Actions for {0}", [sessionTitle(menuSession)])} onClose={closeMenu}>
      <button role="menuitem" className="menu__item" onClick={() => { setName(sessionTitle(menuSession)); setNavOpen(false); setRenameId(menuId); setMenuId(null); }}><Icon name="pencil"/>{tr("Rename")}</button>
      <button role="menuitem" className="menu__item" onClick={() => { togglePin(menuId); closeMenu(); }}><Icon name="pin"/>{tr(menuSession.pinned ? 'Unpin' : 'Pin')}</button>
      <button role="menuitem" className="menu__item menu__item--danger" onClick={() => { setNavOpen(false); setDeleteId(menuId); setMenuId(null); }}><Icon name="trash"/>{tr("Delete chat")}</button>
    </FloatingMenu> : null)}
    <Dialog open={!!renameId} compact title={tr("Rename chat")} onClose={() => setRenameId(null)} actions={<><Btn onClick={() => setRenameId(null)}>{tr("Cancel")}</Btn><Btn variant="primary" disabled={!name.trim()} onClick={() => {
                if (renameId)
                    renameSession(renameId, name.trim());
                setRenameId(null);
            }}>{tr("Save name")}</Btn></>}><label className="input-field" htmlFor="chat-name"><span>{tr("Chat name")}</span><input className="st-input" id="chat-name" value={name} onFocus={e => e.currentTarget.select()} onChange={e => setName(e.target.value)}/></label></Dialog>
    <Dialog open={!!deleteId} compact title={tr("Delete this chat?")} onClose={() => setDeleteId(null)} actions={<><Btn onClick={() => setDeleteId(null)}>{tr("Keep chat")}</Btn><Btn variant="danger" onClick={() => {
                if (deleteId)
                    deleteSession(deleteId);
                setDeleteId(null);
            }}>{tr("Delete chat")}</Btn></>}><p>{tr("This chat will be permanently deleted.")}</p></Dialog>
    <Dialog open={recentOpen} title={tr("All chats")} onClose={() => setRecentOpen(false)}><div className="stack"><label className="row small"><input type="checkbox" checked={includeArchived} onChange={e => setIncludeArchived(e.target.checked)}/>{tr("Include archived chats")}</label><input type="search" className="st-input" placeholder={tr("Search chats…")} aria-label={tr("Search all chats")} value={query} onChange={e => setQuery(e.target.value)}/>{tr(matching.map(s => <button className="recent-chat" key={s.id} onClick={() => { selectSession(s.id); go('chat', s.id); setRecentOpen(false); }}><span>{sessionTitle(s)}</span><span className="xs muted">{tr(relTime(s.updatedAt))}</span></button>))}{tr(!matching.length ? <p className="small muted">{tr("No matching chats. Try another search.")}</p> : null)}</div></Dialog>
  </>;
}
function RecentChatLink({ session, active, slot }: {
    session: Session;
    active: boolean;
    slot: number;
}) {
    const binding = bindingFor('chat:slot:' + slot, { key: String(slot), mod: true, shift: false, alt: false });
    const keys = bindingKeys(binding, MOD);
    const anchor = useRef<HTMLAnchorElement>(null);
    const tooltip = useRef<HTMLDivElement>(null);
    const id = useId();
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState({ left: 0, top: 0 });
    useLayoutEffect(() => {
        if (!open)
            return;
        const place = () => {
            const rect = anchor.current?.getBoundingClientRect();
            if (!rect)
                return;
            const scale = measureScale();
            const height = tooltip.current?.getBoundingClientRect().height ?? 80 * scale;
            setPosition({ left: (rect.right + 12) / scale, top: Math.max(12, Math.min(rect.top, window.innerHeight - height - 12)) / scale });
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
    }, [open]);
    return <>
    <a ref={anchor} className="navitem nav-recent__chat" href={href('chat', session.id)} aria-label={sessionTitle(session)} aria-current={active ? 'page' : undefined} aria-describedby={open ? id : undefined} onClick={() => { setOpen(false); selectSession(session.id); }} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={event => {
            if (event.key === 'Escape' && open) {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
            }
        }}><Icon name="chat"/><span className="nav-chat-number" aria-hidden="true">{tr(slot)}</span></a>
    {open ? createPortal(<div ref={tooltip} id={id} role="tooltip" className="nav-chat-tooltip" style={position}><strong>{sessionTitle(session)}</strong><span>{session.messages.length ? recentChatDescription(session) : tr(recentChatDescription(session))}</span>{tr(binding ? <kbd className="nav-chat-shortcut">{tr(keys.join(" "))}</kbd> : null)}</div>, document.body) : null}
  </>;
}
function NavLink({ route, label, icon, current, meta }: {
    route: Route;
    label: string;
    icon: IconName;
    current: string;
    meta?: string;
}) {
    return <a className="navitem" href={href(route)} aria-current={current === route ? 'page' : undefined} title={tr(label)} aria-label={tr(label)}><Icon name={icon}/><span className="navitem__text">{tr(label)}</span>{tr(meta ? <span className="navitem__meta">{tr(meta)}</span> : null)}</a>;
}
function MoreMenu({ current }: {
    current: string;
}) {
    const [open, setOpen] = useState(false);
    const [quitOpen, setQuitOpen] = useState(false);
    const appMode = useAppMode();
    const ref = useRef<HTMLButtonElement>(null);
    return <><button ref={ref} className="navitem nav__more" title={tr("More — Serving and Settings")} aria-label={tr("More — Serving and Settings")} aria-haspopup="menu" aria-expanded={open} data-active={['serving', 'settings'].includes(current) || undefined} aria-current={['serving', 'settings'].includes(current) ? 'page' : undefined} onClick={() => setOpen(v => !v)}><Icon name="ellipsis"/><span className="navitem__text">{tr("More")}</span></button>{tr(open ? <FloatingMenu anchor={ref.current} title={tr("More")} onClose={() => { setOpen(false); ref.current?.focus(); }}>{tr(([{ route: 'serving', label: 'Serving', icon: 'link' }, { route: 'settings', label: 'Settings', icon: 'settings' }] as const).map(d => <a key={d.route} role="menuitem" className="menu__item" href={href(d.route)} onClick={() => setOpen(false)}><Icon name={d.icon}/>{tr(d.label)}</a>))}{appMode.canQuit ? <button type="button" role="menuitem" className="menu__item" onClick={() => { setOpen(false); setNavOpen(false); setQuitOpen(true); }}><Icon name="x"/>{tr("Quit Strata")}</button> : null}</FloatingMenu> : null)}<QuitStrataDialog open={quitOpen} onClose={() => setQuitOpen(false)}/></>;
}
