/**
 * The Vibe tools: how the Head AI of a Vibe chat keeps the project book, moves the work through its stages, and proves a milestone is
 * done. A Harness plugin (plain ESM, loaded by absolute path inside the agent preset, like the tools it sits beside); its only imports
 * are the host's pure modules.
 *
 * The rules are in this code, not in the prompt. A milestone closes only after the project's checks passed on the saved version AND an
 * independent helper (one that changed no files in this milestone) reviewed that same version. The brief goes to the person on one
 * Approve/Deny card before anything is built (a small task skips it); nothing else asks. Git is set up by itself, the person's own unsaved
 * work is committed apart from the assistant's save points, and the work happens on a branch that is merged once it is checked.
 *
 * Every chat's agent has these tools; outside a Vibe chat they answer that they are for Vibe chats (and the profile leaves them out of
 * the model's tool list, ../../profiles.mjs).
 */
import { policyReader } from '../../profiles.mjs';
import {
  BOOK_DIR, MASS_DELETE, SMALL_MAX_FILES, ASK_AFTER, RETHINK_AFTER,
  addDecision, addNote, applyBrief, bookSummary, briefGaps, changesSince, checkpoint, currentBranch, describeScan, dirty, git, gitTop,
  head, identityArgs, initGit, loadBook, loadRun, listOf, rootOfSession, runCommand, sameWork, saveBook, saveRun, scanForGit, slug, unsafeRoot,
} from '../vibe-state.mjs';

export const name = 'strata-vibe';
export const inject = ['tools', 'workingDirectory', 'approval', 'sessions'];

const VIBE = 'vibe';
const NOT_VIBE = 'These project tools are for Vibe chats only. Go on without them.';

export function apply(ctx, config = {}) {
  const stateDir = config.stateDir;
  const defaults = Array.isArray(config.defaults) ? config.defaults : [];
  const profileOf = config.policyFile ? policyReader(config.policyFile) : () => null;

  /** The chat's own session (a helper's chat is its top parent). */
  const rootSession = (session, depth = 0) => {
    const parentId = session?.header?.parentSession;
    if (session?.header?.origin === 'subagent' && parentId && depth < 6) {
      const parent = ctx.sessions.get(parentId);
      if (parent) return rootSession(parent, depth + 1);
    }
    return session;
  };
  const isHelper = session => session?.header?.origin === 'subagent';

  /** Who is calling, from where, and whether this is a Vibe chat at all. */
  async function contextOf(exec) {
    const agent = exec.agent;
    if (!agent) throw new Error('The project tools need a chat session.');
    const top = rootSession(agent.session);
    const profile = profileOf(top.id);
    if (profile?.id !== VIBE) return { vibe: false };
    let root = rootOfSession(stateDir, top.id);
    if (!root) root = await ctx.workingDirectory.ensure(agent, exec.signal);
    return { vibe: true, agent, top, helper: isHelper(agent.session), sessionId: agent.session.id, root };
  }

  const ask = async (exec, reason) => {
    const outcome = await ctx.approval.request({ agent: exec.agent, toolName: exec.name ?? 'vibe', callId: exec.callId, reason, displayReason: { en: reason }, signal: exec.signal });
    return outcome === 'allowed-once' ? 'yes' : outcome === 'cancelled' ? 'cancelled' : 'no';
  };

  const save = (root, run, book) => { if (book) saveBook(root, book); saveRun(stateDir, root, run); };
  const commitBook = (root, message) => checkpoint(root, message);

  const tools = [];
  const tool = (def, run, { headOnly = false, helperOnly = false } = {}) => tools.push({ def, run, headOnly, helperOnly });

  /* ---------------------------------------------------------------------------------------------------------- status --- */
  tool({
    name: 'vibe_status',
    description: 'Show the project book summary and the stage rules for this Vibe project: the goal, requirements, milestones, the last check, recent decisions, lessons. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }, ({ root }) => {
    const run = loadRun(stateDir, root), book = loadBook(root);
    const gaps = briefGaps(book);
    return `${bookSummary(root, run, book, { max: 6000 })}${run.stage === 'discover' && gaps.length ? `\nStill missing before vibe_start: ${gaps.join('; ')}.` : ''}`;
  });

  /* ----------------------------------------------------------------------------------------------------------- brief --- */
  tool({
    name: 'vibe_brief',
    description: [
      'Write or update the project brief (the project book). Give only the fields that change; a list you give replaces the old list.',
      'Mark each requirement "confirmed" (the person said it), "assumed" (you decided it for them; they can overrule it) or "open" (a question for the person; add "question").',
      'The goal is the person\'s outcome in their words: theirs, not yours. The approach is yours: if the person proposed how to do it and a better way exists, put it in "concerns" (about / concern / better) instead of just following them.',
      'size: "small" (a few files, obvious; no approval card, no milestones needed), "medium" or "large" (needs milestones and the person\'s approval).',
      'checks: the commands that must pass for the work to count (tests, build, a script that runs the program), or "none" with the reason.',
      'After approval, changing requirements or milestones is recorded in the history; give "reason".',
    ].join(' '),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Short project name.' },
        goal: { type: 'string', description: 'What the person wants to exist, in plain words.' },
        size: { type: 'string', enum: ['small', 'medium', 'large'] },
        requirements: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', description: 'Keep the id (R1, R2...) of an existing requirement.' }, text: { type: 'string' }, status: { type: 'string', enum: ['confirmed', 'assumed', 'open'] }, why: { type: 'string' }, question: { type: 'string' } }, required: ['text', 'status'] } },
        outOfScope: { type: 'array', items: { type: 'string' } },
        approach: { type: 'string', description: 'How it will be built, in plain words, with the main technical choices and why.' },
        concerns: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { about: { type: 'string' }, concern: { type: 'string' }, better: { type: 'string' } }, required: ['concern'] } },
        milestones: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', description: 'Keep the id (M1, M2...) of an existing milestone.' }, title: { type: 'string' }, detail: { type: 'string', description: 'What exists when it is done, and how that is checked.' } }, required: ['title'] } },
        checks: { type: 'object', additionalProperties: false, properties: { commands: { type: 'array', items: { type: 'string' } }, none: { type: 'string', description: 'Why there is no command to run, when there is none.' } } },
        protected: { type: 'array', items: { type: 'string' }, description: 'Files or folders that must not be changed.' },
        reason: { type: 'string', description: 'Why the brief changes (after approval).' },
      },
    },
  }, ({ root, helper }, args) => {
    const problem = unsafeRoot(root, { defaults });
    if (problem) return `Not saved: ${problem} Ask the person to pick or create a folder for this project (the folder button in the chat), then try again.`;
    let run = loadRun(stateDir, root), book = loadBook(root);
    if (run.stage === 'done') { run = { ...run, stage: 'discover', milestoneStart: null, writers: [], reviews: [], lastCheck: null, failStreak: 0, needRethink: false, needUser: false }; book = { ...book, approvedAt: null, round: (book.round ?? 1) + 1, milestones: [] }; }
    const { book: next, changed } = applyBrief(book, args, { by: helper ? 'helper' : 'head' });
    if (!changed.length) return 'Nothing changed in the brief.';
    // Changing the checks once the work is approved could make a failure pass: the milestone then needs a decision that explains it.
    if (book.approvedAt && changed.includes('checks') && JSON.stringify(book.checks) !== JSON.stringify(next.checks)) run = { ...run, checksChangedAt: new Date().toISOString() };
    save(root, run, next);
    if (run.stage === 'build' && run.branch) commitBook(root, `Project book: brief updated (${changed.join(', ')})`);
    const gaps = briefGaps(next);
    return `Brief saved (${changed.join(', ')}) in ${BOOK_DIR}/BRIEF.md.${run.stage === 'discover' ? (gaps.length ? ` Still missing before vibe_start: ${gaps.join('; ')}.` : ' It is complete: call vibe_start when the open questions are answered.') : ''}`;
  }, { headOnly: true });

  /* ----------------------------------------------------------------------------------------------------------- start --- */
  tool({
    name: 'vibe_start',
    description: 'Ask the person to approve the brief (one Approve/Deny card) and, once approved, start building: save points (git) are set up, a work branch is made and changes are allowed. A "small" task starts without the card. Call it when the brief is complete and no open question blocks the work.',
    parameters: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', description: 'What will be built, in 2-5 plain sentences, for the approval card: the outcome, the main choices you made for them, anything they should know.' } } },
  }, async ({ root }, args, exec) => {
    const problem = unsafeRoot(root, { defaults });
    if (problem) return `Not started: ${problem}`;
    let run = loadRun(stateDir, root), book = loadBook(root);
    if (run.stage === 'build' && book.approvedAt) return 'The work is already approved and building.';
    if (run.stage === 'done') return 'The last round is finished. Update the brief with vibe_brief for the next round first.';
    const gaps = briefGaps(book);
    if (gaps.length) return `The brief is not complete: ${gaps.join('; ')}. Fill it in with vibe_brief first.`;
    const blocking = book.requirements.filter(r => r.status === 'open');
    if (blocking.length && book.size !== 'small') return `These questions are still open: ${blocking.map(r => `${r.id} ${r.question || r.text}`).join('; ')}. Ask the person (ask_user_question), or decide them yourself and mark them "assumed", then call vibe_start again.`;

    if (book.size !== 'small') {
      const assumed = book.requirements.filter(r => r.status === 'assumed');
      const lines = [
        `Start building "${book.title || 'this project'}"?`,
        clip(args.summary || book.goal, 900),
        book.milestones.length ? `Milestones: ${book.milestones.map(m => m.title).join(' → ')}.` : '',
        assumed.length ? `Decided for you (say if any is wrong): ${clip(assumed.map(r => r.text).join('; '), 600)}` : '',
        `The whole brief is in ${BOOK_DIR}/BRIEF.md. Approve and the work runs without asking for each change; it is saved in git step by step and stays on its own branch until you accept it.`,
      ].filter(Boolean);
      const answer = await ask(exec, lines.join('\n\n'));
      if (answer === 'cancelled') return 'Stopped before the person answered.';
      if (answer !== 'yes') return 'The person did not approve the brief. Ask them what to change (ask_user_question or a short question), update the brief with vibe_brief, and propose it again.';
      book = { ...book, approvedAt: new Date().toISOString() };
      saveBook(root, book);
    }

    // Save points: git in this folder (or the repository it is part of).
    const top = gitTop(root);
    // Set up without a question (Vibe runs on its own): the scan keeps secrets, generated folders and big files out, and says so.
    const notes = [];
    if (!top) {
      const scan = scanForGit(root);
      const made = initGit(root, scan);
      if (made.error) return `Git could not be set up: ${made.error}`;
      run = { ...run, gitApproved: true };
      saveRun(stateDir, root, run);
      notes.push(describeScan(scan));
    }
    // The person's own unsaved changes are never mixed into the assistant's save points.
    const theirs = dirty(root).filter(l => !l.slice(3).replace(/^"|"$/g, '').startsWith(BOOK_DIR.replace(/\\/g, '/')));
    if (theirs.length) {
      notes.push(`${theirs.length} file${theirs.length === 1 ? '' : 's'} with changes not yet saved in git were saved first as the person's own commit ("Your work before Vibe"), so the assistant's work stays apart from theirs.`);
      const own = git(root, ['add', '-A', '--', '.', `:(exclude)${BOOK_DIR.replace(/\\/g, '/')}`]);
      if (!own.ok) return `Your changes could not be saved: ${own.err}`;
      const c = git(root, [...identityArgs(root), 'commit', '-q', '--no-verify', '-m', 'Your work before Vibe']);
      if (!c.ok && !/nothing to commit/.test(c.out + c.err)) return `Your changes could not be saved: ${c.err || c.out}`;
    }
    // The work branch.
    const base = currentBranch(root);
    let branch = base;
    if (!base || !base.startsWith('vibe/')) {
      const want = `vibe/${slug(book.title || 'project')}`;
      branch = want;
      for (let n = 2; git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).ok; n++) branch = `${want}-${n}`;
      const b = git(root, ['checkout', '-q', '-b', branch]);
      if (!b.ok) return `The work branch could not be made: ${b.err}`;
    }
    const saved = checkpoint(root, `Vibe: ${book.size === 'small' ? 'small task' : 'brief approved'} - ${book.title || 'project'}`);
    if (saved.error) return `The first save point failed: ${saved.error}`;
    run = { ...loadRun(stateDir, root), stage: 'build', branch, baseBranch: base && !base.startsWith('vibe/') ? base : run.baseBranch ?? base, milestoneStart: head(root), milestoneStartAt: new Date().toISOString(), writers: [], reviews: [], failStreak: 0, needRethink: false, needUser: false, lastCheck: null };
    saveRun(stateDir, root, run);
    const next = book.milestones.find(m => !m.done);
    return [
      ...notes,
      book.size === 'small' ? 'Small task: building now (no approval card needed).' : 'Approved. Building now.',
      `Work branch: ${branch}${run.baseBranch ? ` (from ${run.baseBranch})` : ''}. The app saves a git checkpoint before each builder task.`,
      next ? `First milestone: ${next.id} ${next.title}. Give each task to an @builder helper (one at a time), then run vibe_check and have an @checker review it before vibe_milestone_done.` : 'Make the change (yourself or with one @builder), run vibe_check, then vibe_finish.',
    ].join(' ');
  }, { headOnly: true });

  /* -------------------------------------------------------------------------------------------------------- decisions --- */
  tool({
    name: 'vibe_decide',
    description: 'Record a decision in the project book: what was chosen, why, what was rejected. Use it for every choice that shapes the project (a library, a data format, a change of plan, a dependency, deleting many files) and for anything the person decided ("by": "you"). After repeated failures, record the new approach with kind "rethink".',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string' }, choice: { type: 'string' }, why: { type: 'string' },
        rejected: { type: 'array', items: { type: 'string' }, description: 'Options considered and why each lost.' },
        kind: { type: 'string', enum: ['scope', 'design', 'dependency', 'data', 'rethink', 'other'] },
        by: { type: 'string', enum: ['head', 'you'], description: '"you" when the person made this decision.' },
        replaces: { type: 'string', description: 'The id (D3...) of an earlier decision this one replaces.' },
      },
      required: ['title', 'choice', 'why'],
    },
  }, ({ root, helper }, args) => {
    const run = loadRun(stateDir, root);
    const { book, decision } = addDecision(loadBook(root), args, { by: helper ? 'helper' : 'head' });
    save(root, { ...run, needRethink: false }, book);
    if (run.stage === 'build' && run.branch) commitBook(root, `Project book: decision ${decision.id} ${decision.title}`);
    return `Recorded ${decision.id}: ${decision.title}.${run.needRethink ? ' The rethink is noted; changes are allowed again.' : ''}`;
  });

  tool({
    name: 'vibe_note',
    description: 'Add to the project book: a known problem (knownIssue), a problem that is fixed now (resolved: its id, K1...), or a lesson: an approach that failed and must not be retried, with why.',
    parameters: { type: 'object', additionalProperties: false, properties: { knownIssue: { type: 'string' }, resolved: { type: 'string' }, lesson: { type: 'string' } } },
  }, ({ root }, args) => {
    const run = loadRun(stateDir, root);
    save(root, run, addNote(loadBook(root), args));
    return 'Noted in the project book.';
  });

  /* ------------------------------------------------------------------------------------------------------ save points --- */
  tool({
    name: 'vibe_checkpoint',
    description: 'Save the current state of the project as a git commit on the work branch (the app also does this by itself before each builder task and before checks).',
    parameters: { type: 'object', additionalProperties: false, properties: { message: { type: 'string', description: 'One line: what this state contains.' } }, required: ['message'] },
  }, ({ root }, args) => {
    const run = loadRun(stateDir, root);
    if (run.stage !== 'build') return 'Save points are made while building.';
    const r = checkpoint(root, args.message);
    return r.error ? `The save point failed: ${r.error}` : r.made ? `Saved as ${r.commit.slice(0, 8)}.` : 'Nothing changed since the last save point.';
  }, { headOnly: true });

  /* ----------------------------------------------------------------------------------------------------------- checks --- */
  tool({
    name: 'vibe_check',
    description: 'Run the project\'s checks (the commands in the brief) on the current state, saved first as a git checkpoint, and record the result. A milestone can only be closed after this passed on the latest saved version.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  }, async ({ root }, _args, exec) => {
    let run = loadRun(stateDir, root);
    const book = loadBook(root);
    if (run.stage !== 'build') return 'Checks run while building.';
    if (run.needUser) return 'The checks already failed too often in a row. Ask the person how to go on before running them again.';
    const saved = checkpoint(root, 'Save point before checks');
    if (saved.error) return `The save point before the checks failed: ${saved.error}`;
    const results = [];
    for (const command of book.checks.commands) results.push(await runCommand(root, command, { signal: exec.signal }));
    const ok = results.every(r => r.ok);
    const streak = ok ? 0 : (run.failStreak ?? 0) + 1;
    run = { ...loadRun(stateDir, root), lastCheck: { ok, at: new Date().toISOString(), commit: head(root), results: results.map(r => ({ command: r.command, ok: r.ok, code: r.code, seconds: r.seconds, killed: r.killed })) }, failStreak: streak, needRethink: !ok && streak >= RETHINK_AFTER, needUser: !ok && streak >= ASK_AFTER };
    saveRun(stateDir, root, run);
    if (!results.length) return `No check commands (reason in the brief: ${book.checks.none || 'none given'}). Recorded as passed for ${run.lastCheck.commit?.slice(0, 8)}. Verify by hand what you can (run the program, read the result) and say what you checked.`;
    const lines = results.map(r => `${r.ok ? 'PASS' : 'FAIL'} \`${r.command}\` (${r.killed ? `stopped: ${r.killed}` : `exit ${r.code}`}, ${r.seconds}s)${r.ok ? '' : `\n${r.tail}`}`);
    const after = ok ? 'All checks passed.' : run.needUser ? `Failed ${streak} times in a row. Stop: explain the problem to the person in plain words and ask how to go on. No more changes until they answer.` : run.needRethink ? `Failed ${streak} times in a row. Do not try the same fix again: think about why, record a different approach with vibe_decide (kind "rethink") and a vibe_note lesson about what failed. Changes are blocked until then.` : `Failed (${streak} in a row). Give the failure to an @builder to fix (the root cause, not the symptom), then check again.`;
    return `${lines.join('\n\n')}\n\n${after}`;
  });

  tool({
    name: 'vibe_review',
    description: 'For an @checker helper: record your independent review of the current saved version. Only a helper that changed no files in this milestone can review it. verdict "pass" only when the work does what the brief asks, the checks pass and you found no real bug; otherwise "fail" with each finding (file, problem, fix).',
    parameters: { type: 'object', additionalProperties: false, properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, findings: { type: 'array', items: { type: 'string' } }, checked: { type: 'string', description: 'What you looked at and ran.' } }, required: ['verdict'] },
  }, ({ root, sessionId }, args) => {
    const run = loadRun(stateDir, root);
    if (run.stage !== 'build') return 'Reviews are for work being built.';
    if (run.writers.includes(sessionId)) return 'You changed files in this milestone, so you cannot be its reviewer. Report your findings to the Head instead.';
    const saved = checkpoint(root, 'Save point before review');
    if (saved.error) return `The save point failed: ${saved.error}`;
    const review = { by: sessionId, commit: head(root), verdict: args.verdict === 'pass' ? 'pass' : 'fail', findings: listOf(args.findings).slice(0, 30).map(findingText).filter(Boolean), checked: String(args.checked ?? '').slice(0, 1000), at: new Date().toISOString() };
    saveRun(stateDir, root, { ...run, reviews: [...run.reviews, review].slice(-20) });
    return `Review recorded (${review.verdict}) for ${review.commit?.slice(0, 8)}. Report it to the Head in your answer.`;
  }, { helperOnly: true });

  /* ------------------------------------------------------------------------------------------------------- milestones --- */
  tool({
    name: 'vibe_milestone_done',
    description: 'Close a milestone. The app allows it only when the checks passed on the latest saved version, an independent @checker reviewed that same version with "pass", and every special change in it (a new dependency, many deleted files, a protected file) has a recorded decision.',
    parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', description: 'The milestone (M1...); the first open one when left out.' }, summary: { type: 'string', description: 'What now works, in one or two plain sentences.' } }, required: ['summary'] },
  }, ({ root }, args) => {
    let run = loadRun(stateDir, root);
    let book = loadBook(root);
    if (run.stage !== 'build') return 'Milestones are closed while building.';
    const m = args.id ? book.milestones.find(x => x.id === args.id) : book.milestones.find(x => !x.done);
    if (!m && book.milestones.length) return 'No open milestone has that id.';
    const saved = checkpoint(root, 'Save point before closing the milestone');
    if (saved.error) return `The save point failed: ${saved.error}`;
    const now = head(root);
    const missing = [];
    const checkedHere = run.lastCheck && sameWork(root, run.lastCheck.commit, now);
    if (!run.lastCheck?.ok || !checkedHere) missing.push(checkedHere ? 'the checks failed on this version: fix and run vibe_check again' : 'the checks have not passed on the latest version: run vibe_check');
    const reviewed = run.reviews.find(r => sameWork(root, r.commit, now) && r.verdict === 'pass' && !run.writers.includes(r.by));
    if (book.size !== 'small' && !reviewed) missing.push('no independent review passed on this version: start an @checker helper (it must not be one of the builders) and have it call vibe_review');
    const ch = changesSince(root, run.milestoneStart);
    const since = run.milestoneStartAt ?? '';
    const decided = book.decisions.some(d => d.at >= since);
    const trips = [];
    if (ch.dependencies.length) trips.push(`dependency lists changed (${ch.dependencies.join(', ')})`);
    if (ch.deleted.length > MASS_DELETE) trips.push(`${ch.deleted.length} files were deleted`);
    const prot = book.protected.filter(p => ch.files.some(f => f === p || f.startsWith(p.replace(/\/?$/, '/'))));
    if (prot.length) trips.push(`protected files changed (${prot.join(', ')})`);
    if (run.checksChangedAt && run.checksChangedAt >= since && !book.decisions.some(d => d.at >= run.checksChangedAt)) missing.push('the check commands changed during this milestone: record why with vibe_decide (what changed and why it still proves the work)');
    if (trips.length && !decided) missing.push(`record a decision with vibe_decide about: ${trips.join('; ')}`);
    if (book.size === 'small' && ch.files.filter(f => !f.startsWith('.strata/')).length > SMALL_MAX_FILES) missing.push(`this "small" task changed ${ch.files.length} files, so it is not small: change the size with vibe_brief (medium, with milestones) and get it approved with vibe_start`);
    if (missing.length) return `Not closed yet: ${missing.join('; ')}.`;
    if (m) book = { ...book, milestones: book.milestones.map(x => (x.id === m.id ? { ...x, done: true, doneAt: new Date().toISOString(), summary: String(args.summary).slice(0, 600) } : x)) };
    saveBook(root, book);
    const c = checkpoint(root, `Milestone ${m ? `${m.id} ${m.title}` : 'done'}: ${String(args.summary).slice(0, 200)}`);
    run = { ...loadRun(stateDir, root), milestoneStart: c.commit ?? head(root), milestoneStartAt: new Date().toISOString(), writers: [], reviews: [] };
    saveRun(stateDir, root, run);
    const next = book.milestones.find(x => !x.done);
    return next ? `${m?.id ?? 'Milestone'} closed. Next: ${next.id} ${next.title}. Tell the person in one or two plain sentences what now works.` : 'Every milestone is closed. Hand over with vibe_finish.';
  }, { headOnly: true });

  /* ----------------------------------------------------------------------------------------------------------- finish --- */
  tool({
    name: 'vibe_finish',
    description: 'Hand the finished work over: the app checks every milestone is closed and the checks passed on the latest version, then merges the work branch into the branch the work started from (no question). Then present the result to the person.',
    parameters: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', description: 'What was built, how it was checked, what is not done or known to be limited, and how to try it.' } }, required: ['summary'] },
  }, ({ root }) => {
    let run = loadRun(stateDir, root);
    const book = loadBook(root);
    if (run.stage !== 'build') return 'There is no work being built to hand over.';
    const open = book.milestones.filter(m => !m.done);
    if (open.length) return `Not finished: ${open.map(m => `${m.id} ${m.title}`).join(', ')} still open.`;
    const saved = checkpoint(root, 'Save point before hand-over');
    if (saved.error) return `The save point failed: ${saved.error}`;
    if (!run.lastCheck?.ok || !sameWork(root, run.lastCheck.commit, head(root))) return 'Not finished: the checks have not passed on the latest version. Run vibe_check first.';
    // Presenting the finished work is not a question: it is merged, and the work branch stays so it can be undone.
    const base = run.baseBranch;
    if (base && base !== run.branch) {
      const co = git(root, ['checkout', '-q', base]);
      if (!co.ok) return `Could not switch to "${base}" to merge: ${co.err}. The work stays on "${run.branch}".`;
      const mg = git(root, [...identityArgs(root), 'merge', '--no-ff', '-q', '-m', `Vibe: ${book.title || run.branch}`, run.branch]);
      if (!mg.ok) {
        git(root, ['merge', '--abort']);
        git(root, ['checkout', '-q', run.branch]);
        return `The merge into "${base}" ran into a conflict (someone changed the same files there meanwhile), so nothing was merged and the work stays on "${run.branch}". Resolve it yourself: merge "${base}" into "${run.branch}", fix the conflicts, run vibe_check, then vibe_finish again.`;
      }
    }
    run = { ...loadRun(stateDir, root), stage: 'done', finishedAt: new Date().toISOString() };
    saveRun(stateDir, root, run);
    return base ? `Merged into "${base}"; the work branch "${run.branch}" is kept, so it can be undone. Now present it to the person: what they have, how to try it, how it was checked, what was not checked or is limited.` : 'Handed over. Now present it to the person: what they have, how to try it, how it was checked, what was not checked or is limited.';
  }, { headOnly: true });

  /* ------------------------------------------------------------------------------------------------------- register --- */
  for (const { def, run: body, headOnly, helperOnly } of tools) {
    ctx.tools.register({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        const who = await contextOf(exec);
        if (!who.vibe) return NOT_VIBE;
        if (headOnly && who.helper) return `Only the Head of the project uses ${def.name}. Report what you found or did in your answer instead.`;
        if (helperOnly && !who.helper) return `${def.name} is for an independent @checker helper. Start one with the subagent tool (task starting with "@checker").`;
        return String(await body(who, args && typeof args === 'object' ? args : {}, exec));
      },
    });
  }
}

/** A finding as text, whether the model sent a sentence or an object ({file, line, problem, fix, severity}). */
const findingText = f => (f && typeof f === 'object' ? Object.entries(f).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('; ') : String(f ?? '')).slice(0, 800);
const clip = (text, max) => { const t = String(text ?? '').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
