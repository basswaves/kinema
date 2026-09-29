/**
 * Rotten Tomatoes scores, through the user's own OMDb key.
 *
 * Only with a key of their own: OMDb's free keys allow 1,000 lookups a day,
 * and a key built into every copy of Kinema would run out within hours for
 * everyone (HISTORY.md, "Picture and sound badges"). The lookups are the
 * user's to spend, so they are spent sparingly:
 *
 *  - one per title, again only after a month (`omdb.rs` decides which);
 *  - at most {@link PER_SCAN} per scan and {@link DAILY_BUDGET} a day, half
 *    the free allowance, leaving the rest for anything else the key does;
 *  - and none at all once OMDb says the key is wrong or the day's allowance
 *    is used up — the rest wait for the next scan.
 */
import { invoke } from '@tauri-apps/api/core';
import { getSetting, setSetting } from './api';
import { OmdbStop, omdbTomatometer } from './providers';

/** Lookups one scan may make. */
export const PER_SCAN = 100;
/** Lookups one day may make: half of OMDb's free 1,000. */
export const DAILY_BUDGET = 500;
/** Setting key: `{ day, used }`, today's spending. */
const BUDGET_KEY = 'omdb_scores_budget';

export interface ScoreResult {
  imdb_id: string;
  tomatometer: number | null;
}

/** What the pass needs, injectable so its rules are tested without a network. */
export interface ScoreDeps {
  omdbKey: () => Promise<string | null>;
  today: () => string;
  readBudget: () => Promise<string | null>;
  writeBudget: (value: string) => Promise<void>;
  listDue: (limit: number) => Promise<string[]>;
  lookup: (key: string, imdbId: string) => Promise<number | null>;
  save: (scores: ScoreResult[]) => Promise<void>;
}

const defaultDeps: ScoreDeps = {
  omdbKey: async () => (await getSetting('omdb_api_key'))?.trim() || null,
  today: () => new Date().toISOString().slice(0, 10),
  readBudget: () => getSetting(BUDGET_KEY),
  writeBudget: (value) => setSetting(BUDGET_KEY, value),
  listDue: (limit) => invoke<string[]>('list_titles_needing_scores', { limit }),
  lookup: omdbTomatometer,
  save: (scores) => invoke<void>('save_omdb_scores', { scores }),
};

export interface ScoreReport {
  looked_up: number;
  /** Set when OMDb stopped the pass: a wrong key, or the day's allowance. */
  stopped: string | null;
}

/** Lookups already spent today. */
function spentToday(stored: string | null, today: string): number {
  try {
    const budget = JSON.parse(stored ?? '') as { day?: string; used?: number };
    return budget.day === today && typeof budget.used === 'number' ? budget.used : 0;
  } catch {
    return 0;
  }
}

/**
 * Look up the scores that are due, within today's budget. Never throws: a
 * missing score is a missing badge, not a failed scan.
 */
export async function refreshTomatometer(deps: ScoreDeps = defaultDeps): Promise<ScoreReport> {
  const report: ScoreReport = { looked_up: 0, stopped: null };
  const key = await deps.omdbKey();
  if (!key) return report;

  const today = deps.today();
  const spent = spentToday(await deps.readBudget(), today);
  const allowance = Math.min(PER_SCAN, DAILY_BUDGET - spent);
  if (allowance <= 0) return report;

  const found: ScoreResult[] = [];
  for (const imdbId of await deps.listDue(allowance)) {
    try {
      const tomatometer = await deps.lookup(key, imdbId);
      report.looked_up++;
      found.push({ imdb_id: imdbId, tomatometer });
    } catch (e) {
      report.looked_up++;
      // A wrong key or a spent allowance will say the same for every title.
      if (e instanceof OmdbStop) {
        report.stopped = e.message;
        break;
      }
      // Anything else — a timeout, one bad answer — is left for next time.
      console.warn(`OMDb score for ${imdbId}:`, e);
    }
  }

  if (found.length > 0) await deps.save(found);
  await deps.writeBudget(JSON.stringify({ day: today, used: spent + report.looked_up }));
  return report;
}
