/**
 * Which Claude process owns which session.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * The SessionEnd hook closes open sessions so that a session never ends up
 * with a NULL summary (see tools/autoClose.ts for why that matters). It did
 * that by closing EVERY open session in the project, which is correct right up
 * until two Claude processes overlap — and they overlap on every restart,
 * because the new process's SessionStart runs before the old process's
 * SessionEnd:
 *
 *   13:56:02  new Claude · SessionStart · opens session #477
 *   13:56:12  old Claude · SessionEnd   · autoCloseAll closes #477
 *   13:56:52  the agent in the NEW process tries to write → SESSION_NOT_ACTIVE
 *
 * Measured, not hypothesised. #477 was stamped `[auto]` with "0m open, 0
 * observations saved, nothing was recorded and nothing was committed" — a
 * description of the session the user was sitting in. Worse than the error: the
 * generated close becomes the module's newest close, so it wins every
 * "last closed session" lookup and pushes the handoff a human wrote one level
 * down into `curatedResume`. One restart per burial.
 *
 * WHY NOT A TIME HEURISTIC
 * ------------------------
 * "Do not close sessions younger than N seconds" was the obvious fix and is
 * wrong: N is a guess about process startup order, it fails on a slow machine,
 * and when it fails it fails silently in the same way. The question is not how
 * young a session is, it is who it belongs to — so answer that question
 * instead.
 *
 * HOW
 * ---
 * Claude Code hands every hook a JSON payload on stdin carrying `session_id`,
 * its own identifier for the editor session, and the SAME id arrives at
 * SessionStart and at SessionEnd of one process. So SessionStart writes a claim
 * file naming the brain sessions it opened, and SessionEnd closes what its own
 * claim names plus anything unclaimed, while skipping sessions another live
 * claim is holding. The exiting process can no longer touch the newcomer's
 * session, because the newcomer said so in writing first.
 *
 * Claims live next to the brain rather than in it. They are process-lifetime
 * state, not memory: a stale one must be ignorable and deletable without a
 * migration, and nothing here should ever be worth backing up.
 *
 * WHAT IS DELIBERATELY STILL CLOSED
 * ---------------------------------
 * An UNCLAIMED open session is still closed, which keeps the whole point of
 * the feature intact — an agent that opened a session through the MCP server
 * and never called `end_session` still gets closed on exit. The claim only
 * protects sessions some other process has said out loud that it is using.
 *
 * THE ASSUMPTION, STATED OUT LOUD
 * -------------------------------
 * This rests on `session_id` being the SAME at the SessionStart and the
 * SessionEnd of one editor session. Claude Code's hook reference documents
 * that `session_id` is always sent and that stdin is closed after the payload,
 * but it does NOT document that the value is stable across a session's
 * lifetime — that part is inference from what the field is for (it also names
 * the transcript, and `resume` is a SessionStart source, both of which require
 * stability).
 *
 * So the failure is designed for rather than assumed away. If the id ever
 * differs between the two events, SessionEnd finds no claim of its own, says
 * so on stderr, and closes only unclaimed sessions. Its own session then stays
 * open until `autoCloseStaleInModule` closes it retroactively at the next
 * `start_session` in that module — later than ideal, never lost, and visible
 * in the hook log instead of silent. Nothing is overwritten and nothing is
 * closed that someone is using, which are the two outcomes worth protecting.
 *
 * AND WHAT IS NOT GUARANTEED
 * --------------------------
 * A Claude that is killed outright leaves its claim behind, and that claim
 * protects its session from other processes' SessionEnd hooks. That is not a
 * new hole: no hook fires for a killed process either way, which is exactly
 * why `autoCloseStaleInModule` runs from `start_session` as well. The claim
 * only delays the retroactive close, it cannot prevent it. Claims older than
 * CLAIM_MAX_AGE_MS are pruned so the directory cannot grow without bound.
 *
 * Deliberately NOT keyed on a process id. The hook scripts are launched
 * through a shell, so a hook's parent may be a transient wrapper rather than
 * Claude itself — a claim keyed on that pid would look dead to the very next
 * hook and would reintroduce the race it exists to close. An undocumented-but-
 * near-certain id with a safe degradation beats a liveness check whose failure
 * mode is the original bug.
 */

import * as fs from 'fs';
import * as path from 'path';
import { myjarbisHome } from './resolve.js';

/** A claim is worthless after this long: no editor session runs for a week,
 *  and a file older than that is debris from a process that was killed. */
const CLAIM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionClaim {
  /** Claude Code's own session identifier, from the hook payload. */
  claudeSessionId: string;
  projectId: number;
  /** Brain sessions this process opened. */
  sessionIds: number[];
  /** ISO timestamp of the claim, used only for pruning. */
  at: string;
}

function runDir(): string {
  return path.join(myjarbisHome(), 'run');
}

/**
 * Claude's session ids reach the filesystem as a filename, so anything that
 * could escape the run directory or collide is stripped rather than trusted.
 * A payload is input, even when it comes from the editor.
 */
function claimFile(claudeSessionId: string): string | null {
  const safe = claudeSessionId.replace(/[^A-Za-z0-9._-]/g, '');
  if (!safe) return null;
  return path.join(runDir(), `claude-${safe}.json`);
}

/**
 * Record that this Claude process is using a brain session.
 *
 * Appends rather than replaces: one editor session legitimately opens several
 * brain sessions as the user switches modules, and all of them belong to it.
 *
 * Best-effort throughout. A hook that cannot write a claim must still let the
 * user open or close their editor, so every failure here is swallowed — the
 * cost of a missing claim is the old behaviour, not a broken session.
 */
export function claimSession(
  claudeSessionId: string | null,
  projectId: number,
  sessionId: number,
): void {
  if (!claudeSessionId) return;
  const file = claimFile(claudeSessionId);
  if (!file) return;

  try {
    fs.mkdirSync(runDir(), { recursive: true });
    let claim: SessionClaim = {
      claudeSessionId,
      projectId,
      sessionIds: [],
      at: new Date().toISOString(),
    };
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf-8')) as SessionClaim;
      if (existing && Array.isArray(existing.sessionIds)) {
        claim = { ...claim, sessionIds: existing.sessionIds };
      }
    } catch {
      // No claim yet, or an unreadable one. Either way, start fresh.
    }
    if (!claim.sessionIds.includes(sessionId)) claim.sessionIds.push(sessionId);

    // Written by rename, for the reason bin/myjarbis-update learned the hard
    // way: a reader must see either the old file or the new one, never half.
    const staging = `${file}.incoming`;
    fs.writeFileSync(staging, `${JSON.stringify(claim, null, 2)}\n`, 'utf-8');
    fs.renameSync(staging, file);
  } catch {
    /* best-effort by design — see the comment above */
  }
}

/** Every readable claim. Unreadable or malformed files are skipped, not fatal. */
export function readClaims(): SessionClaim[] {
  let names: string[];
  try {
    names = fs.readdirSync(runDir());
  } catch {
    return [];
  }

  const claims: SessionClaim[] = [];
  for (const name of names) {
    if (!name.startsWith('claude-') || !name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(runDir(), name), 'utf-8'));
      if (
        raw &&
        typeof raw.claudeSessionId === 'string' &&
        typeof raw.projectId === 'number' &&
        Array.isArray(raw.sessionIds)
      ) {
        claims.push({
          claudeSessionId: raw.claudeSessionId,
          projectId: raw.projectId,
          sessionIds: raw.sessionIds.filter((n: unknown) => typeof n === 'number'),
          at: typeof raw.at === 'string' ? raw.at : new Date(0).toISOString(),
        });
      }
    } catch {
      /* a claim we cannot read protects nothing, which is the safe default */
    }
  }
  return claims;
}

/**
 * Sessions in this project that a DIFFERENT live Claude process is using.
 *
 * `claudeSessionId` is our own id so our own claim is not read back as someone
 * else's. With no id — a hook invoked by hand, or an editor that sent no
 * payload — every claim counts as foreign, which errs toward leaving sessions
 * open rather than closing one that is in use.
 */
export function sessionsClaimedByOthers(
  claudeSessionId: string | null,
  projectId: number,
): Set<number> {
  const out = new Set<number>();
  for (const claim of readClaims()) {
    if (claim.claudeSessionId === claudeSessionId) continue;
    if (claim.projectId !== projectId) continue;
    for (const id of claim.sessionIds) out.add(id);
  }
  return out;
}

/**
 * The newest claim for a project, so a session opened through the MCP server
 * can be attributed to the editor session that is driving it.
 *
 * The MCP server is started by Claude Code without being told which editor
 * session it serves, so this is an inference rather than a fact: the newest
 * claim for this project is the process that just started. It is wrong only
 * when two Claude instances are open in the same project at once, and then it
 * is wrong in the harmless direction — a session gets attributed to the wrong
 * one of the two, so nobody's SessionEnd closes it and `start_session` closes
 * it retroactively later.
 */
export function claimSessionForProject(projectId: number, sessionId: number): void {
  const mine = readClaims()
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  if (!mine) return;
  claimSession(mine.claudeSessionId, projectId, sessionId);
}

/**
 * Whether this editor session left a claim of its own.
 *
 * SessionEnd uses this to tell two situations apart that otherwise look
 * identical: it started without a module selected, so SessionStart opened no
 * session and there is nothing to claim — versus the id it was handed does not
 * match the one SessionStart was handed, which would mean the stability this
 * module assumes does not hold. Only the second is worth a line of output, and
 * only if something was actually skipped because of it.
 */
export function hasOwnClaim(claudeSessionId: string | null): boolean {
  if (!claudeSessionId) return false;
  const file = claimFile(claudeSessionId);
  if (!file) return false;
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/** Drop this process's claim. Called when its editor session ends. */
export function releaseClaim(claudeSessionId: string | null): void {
  if (!claudeSessionId) return;
  const file = claimFile(claudeSessionId);
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone, or never written */
  }
}

/** Remove debris from processes that were killed before SessionEnd could run. */
export function pruneStaleClaims(now: number = Date.now()): number {
  let removed = 0;
  for (const claim of readClaims()) {
    const age = now - new Date(claim.at).getTime();
    if (!Number.isFinite(age) || age <= CLAIM_MAX_AGE_MS) continue;
    const file = claimFile(claim.claudeSessionId);
    if (!file) continue;
    try {
      fs.unlinkSync(file);
      removed++;
    } catch {
      /* best-effort */
    }
  }
  return removed;
}
