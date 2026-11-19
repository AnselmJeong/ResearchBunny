import { randomUUID } from "node:crypto";
import type Database from "../db/sqlite";
import type { Work } from "../../shared/types";
import {
  defaultProfile,
  screenView,
  type Criterion,
  type PaperCharacter,
  type ScreenResult,
  type ScreenView,
  type ScreeningProfile,
} from "../../shared/screening";
import type { ScreenExample, ScreenPaper } from "./pipeline";

const clean = (list: Criterion[]) =>
  list
    .map((c) => ({ id: c.id || randomUUID().slice(0, 8), text: c.text.replace(/\s+/g, " ").trim() }))
    .filter((c) => c.text);
const same = (a: Criterion[], b: Criterion[]) => JSON.stringify(a.map((c) => [c.id, c.text])) === JSON.stringify(b.map((c) => [c.id, c.text]));

/** Reads and writes screening state. Read-only callers (the connector) pass a read-only connection and only read. */
export class ScreeningStore {
  constructor(private db: Database, private question: (projectId: string) => string = () => "") {}

  profile(projectId: string): ScreeningProfile {
    const row = this.db.prepare("SELECT data FROM screening_profiles WHERE project_id=?").get(projectId) as { data: string } | undefined;
    const base = defaultProfile(projectId, this.question(projectId));
    return row ? { ...base, ...(JSON.parse(row.data) as Partial<ScreeningProfile>), projectId } : base;
  }
  hasProfile(projectId: string) {
    return !!this.db.prepare("SELECT 1 FROM screening_profiles WHERE project_id=?").get(projectId);
  }
  /**
   * Saves a profile. Changing the intent or a criterion raises the version, so
   * judgments made under the old criteria show as stale; the purpose, mode and
   * model are not criteria and keep it.
   */
  saveProfile(projectId: string, patch: Partial<Omit<ScreeningProfile, "projectId" | "version" | "updatedAt">>): ScreeningProfile {
    const before = this.profile(projectId);
    const next: ScreeningProfile = {
      ...before,
      ...patch,
      include: patch.include ? clean(patch.include) : before.include,
      exclude: patch.exclude ? clean(patch.exclude) : before.exclude,
      intent: patch.intent !== undefined ? patch.intent.trim() : before.intent,
      custom: patch.custom
        ? { label: patch.custom.label.trim(), questions: patch.custom.questions.map((q) => ({ ...q, id: q.id || randomUUID().slice(0, 8), question: q.question.trim(), label: q.label.trim() || q.question.trim().slice(0, 40) })).filter((q) => q.question) }
        : before.custom,
      projectId,
      updatedAt: new Date().toISOString(),
    };
    const changed = next.intent !== before.intent || !same(next.include, before.include) || !same(next.exclude, before.exclude);
    next.version = before.version + (changed && this.hasProfile(projectId) ? 1 : 0);
    this.db.prepare("INSERT INTO screening_profiles VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET data=excluded.data").run(projectId, JSON.stringify(next));
    return next;
  }
  /** A one-line reason the person gave for turning a recommendation down, kept as a proposed exclusion criterion. */
  suggest(projectId: string, workId: string, text: string): ScreeningProfile {
    const profile = this.profile(projectId);
    const trimmed = text.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!trimmed) return profile;
    const suggestions = [...profile.suggestions.filter((s) => s.workId !== workId), { id: randomUUID().slice(0, 8), text: trimmed, workId, createdAt: new Date().toISOString() }].slice(-30);
    return this.saveProfile(projectId, { suggestions });
  }

  results(projectId: string, ids?: string[]): Map<string, ScreenResult> {
    const rows = ids
      ? (this.db.prepare("SELECT work_id,data FROM screenings WHERE project_id=? AND work_id IN (SELECT value FROM json_each(?))").all(projectId, JSON.stringify(ids)) as { work_id: string; data: string }[])
      : (this.db.prepare("SELECT work_id,data FROM screenings WHERE project_id=?").all(projectId) as { work_id: string; data: string }[]);
    return new Map(rows.map((r) => [r.work_id, JSON.parse(r.data) as ScreenResult]));
  }
  saveResult(projectId: string, workId: string, result: ScreenResult) {
    this.db.prepare("INSERT INTO screenings VALUES(?,?,?) ON CONFLICT(project_id,work_id) DO UPDATE SET data=excluded.data").run(projectId, workId, JSON.stringify(result));
  }
  characters(ids: string[]): Map<string, PaperCharacter> {
    if (!ids.length) return new Map();
    const rows = this.db.prepare("SELECT work_id,data FROM work_characters WHERE work_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as { work_id: string; data: string }[];
    return new Map(rows.map((r) => [r.work_id, JSON.parse(r.data) as PaperCharacter]));
  }
  saveCharacter(workId: string, character: PaperCharacter) {
    this.db.prepare("INSERT INTO work_characters VALUES(?,?) ON CONFLICT(work_id) DO UPDATE SET data=excluded.data").run(workId, JSON.stringify(character));
  }
  /** List rows' screening, computed for the project's current purpose and criteria. */
  views(projectId: string, ids: string[]): Map<string, ScreenView> {
    const results = this.results(projectId, ids);
    if (!results.size) return new Map();
    const profile = this.profile(projectId);
    return new Map([...results].map(([id, result]) => [id, screenView(profile, result)]));
  }

  /** The person's latest decisions in the project, for the generative model to learn from. */
  examples(projectId: string, limit = 8): ScreenExample[] {
    const rows = this.db.prepare(
      `SELECT json_extract(w.data,'$.title') AS title,json_extract(pw.state,'$.screening') AS screening,json_extract(pw.state,'$.reason') AS reason
       FROM project_works pw JOIN works w ON w.id=pw.work_id
       WHERE pw.project_id=? AND json_extract(pw.state,'$.screening') IN ('included','excluded','trash')
       ORDER BY json_extract(pw.state,'$.updatedAt') DESC LIMIT 200`,
    ).all(projectId) as { title: string; screening: string; reason: string | null }[];
    const included = rows.filter((r) => r.screening === "included").slice(0, Math.ceil(limit / 2));
    const rejected = rows.filter((r) => r.screening !== "included").slice(0, Math.floor(limit / 2));
    return [...included, ...rejected].map((r) => ({
      title: r.title,
      decision: r.screening === "included" ? ("included" as const) : ("rejected" as const),
      ...(r.reason?.trim() ? { reason: r.reason.trim().slice(0, 200) } : {}),
    }));
  }
}

export const screenPaper = (work: Work): ScreenPaper => ({
  id: work.id,
  title: work.title,
  abstract: work.abstract,
  year: work.year,
  venue: work.venue,
  type: work.type,
});
