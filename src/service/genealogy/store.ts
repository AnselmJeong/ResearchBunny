import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Library } from "../db/database";
import { AppError, now, type Work } from "../../shared/types";
import type {
  Branch,
  CheckItem,
  GapCandidate,
  Genealogy,
  GenealogyCard,
  GenealogyOutputs,
  GenealogyPaper,
  GenealogySettings,
  GenealogySummary,
  Outline,
  PaperOrigin,
} from "../../shared/genealogy";

/** Readable folder names: letters of any script, digits and single dashes. */
export function slug(title: string) {
  return (
    title
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "genealogy"
  );
}

export const EMPTY_OUTPUTS: GenealogyOutputs = { markdown: null, bib: null, epub: null, pdf: null, renderedAt: null, errors: [] };

/** Rows of the genealogy side tables. Content that people read lives in the workspace folder. */
export class GenealogyStore {
  constructor(public db: Library) {}

  create(input: { projectId: string; collectionId: string; title: string; settings: GenealogySettings; workspace?: string }): Genealogy {
    this.db.project(input.projectId);
    if (!this.db.collections(input.projectId).some((c) => c.id === input.collectionId))
      throw new AppError("INVALID", "대상 컬렉션을 확인하세요.");
    const id = randomUUID();
    const genealogy: Genealogy = {
      id,
      projectId: input.projectId,
      collectionId: input.collectionId,
      title: input.title.trim(),
      workspace: input.workspace || join(this.db.root, "genealogies", `${slug(input.title)}-${id.slice(0, 8)}`),
      settings: input.settings,
      completed: {},
      job: null,
      rounds: 0,
      startSize: 0,
      outlineApproved: false,
      createdAt: now(),
      updatedAt: now(),
    };
    this.db.db
      .prepare("INSERT INTO genealogies VALUES(?,?,?,?)")
      .run(id, input.projectId, input.collectionId, JSON.stringify(genealogy));
    return genealogy;
  }

  get(id: string): Genealogy {
    const row = this.db.db.prepare("SELECT data FROM genealogies WHERE id=?").get(id) as { data: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", "계보 리포트를 찾을 수 없습니다.");
    return JSON.parse(row.data) as Genealogy;
  }

  save(genealogy: Genealogy) {
    genealogy.updatedAt = now();
    this.db.db.prepare("UPDATE genealogies SET data=? WHERE id=?").run(JSON.stringify(genealogy), genealogy.id);
  }

  remove(id: string) {
    this.db.db.prepare("DELETE FROM genealogies WHERE id=?").run(id);
  }

  all(): Genealogy[] {
    return (this.db.db.prepare("SELECT data FROM genealogies").all() as { data: string }[]).map((r) => JSON.parse(r.data) as Genealogy);
  }

  list(projectId: string): GenealogySummary[] {
    return (
      this.db.db
        .prepare(
          "SELECT g.data,(SELECT count(*) FROM genealogy_papers p WHERE p.genealogy_id=g.id AND json_extract(p.data,'$.included')=1) AS papers FROM genealogies g WHERE g.project_id=?",
        )
        .all(projectId) as { data: string; papers: number }[]
    )
      .map(({ data, papers }) => {
        const g = JSON.parse(data) as Genealogy;
        return { id: g.id, title: g.title, collectionId: g.collectionId, papers, job: g.job, updatedAt: g.updatedAt };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  papers(id: string, includedOnly = false): GenealogyPaper[] {
    return (
      this.db.db.prepare("SELECT work_id,data FROM genealogy_papers WHERE genealogy_id=?").all(id) as { work_id: string; data: string }[]
    )
      .map((r) => ({ ...(JSON.parse(r.data) as GenealogyPaper), workId: r.work_id }))
      .filter((p) => !includedOnly || p.included)
      .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.key.localeCompare(b.key));
  }

  paper(id: string, workId: string): GenealogyPaper | null {
    const row = this.db.db.prepare("SELECT data FROM genealogy_papers WHERE genealogy_id=? AND work_id=?").get(id, workId) as { data: string } | undefined;
    return row ? { ...(JSON.parse(row.data) as GenealogyPaper), workId } : null;
  }

  savePaper(id: string, paper: GenealogyPaper) {
    this.db.db
      .prepare("INSERT INTO genealogy_papers(genealogy_id,work_id,data) VALUES(?,?,?) ON CONFLICT(genealogy_id,work_id) DO UPDATE SET data=excluded.data")
      .run(id, paper.workId, JSON.stringify(paper));
  }

  /** A paper row from the work's current metadata, keeping what the genealogy learned about it. */
  paperFrom(work: Work, prior: GenealogyPaper | null, origin: PaperOrigin, extra: Partial<GenealogyPaper> = {}): GenealogyPaper {
    return {
      workId: work.id,
      key: work.citekey,
      title: work.title,
      authors: work.authors.slice(0, 3),
      year: work.year,
      venue: work.venue,
      doi: work.doi,
      origin: prior?.origin ?? origin,
      round: prior?.round ?? 0,
      reason: prior?.reason ?? "",
      type: prior?.type ?? null,
      typeSource: prior?.typeSource ?? null,
      typeReason: prior?.typeReason ?? "",
      basis: prior?.basis ?? "none",
      textNote: prior?.textNote ?? "",
      textSize: prior?.textSize ?? 0,
      cardStatus: prior?.cardStatus ?? "none",
      cardError: prior?.cardError ?? "",
      included: true,
      hasPdf: prior?.hasPdf ?? false,
      pmcid: prior?.pmcid ?? null,
      pmcChecked: prior?.pmcChecked ?? false,
      ...(prior?.placed !== undefined ? { placed: prior.placed } : {}),
      ...(prior?.adoptedFrom !== undefined ? { adoptedFrom: prior.adoptedFrom } : {}),
      addedAt: prior?.addedAt ?? now(),
      ...extra,
    };
  }

  card(id: string, workId: string): GenealogyCard | null {
    const row = this.db.db.prepare("SELECT card FROM genealogy_papers WHERE genealogy_id=? AND work_id=?").get(id, workId) as { card: string | null } | undefined;
    return row?.card ? (JSON.parse(row.card) as GenealogyCard) : null;
  }

  cards(id: string): Map<string, GenealogyCard> {
    const rows = this.db.db
      .prepare("SELECT work_id,card FROM genealogy_papers WHERE genealogy_id=? AND card IS NOT NULL AND json_extract(data,'$.included')=1")
      .all(id) as { work_id: string; card: string }[];
    return new Map(rows.map((r) => [r.work_id, JSON.parse(r.card) as GenealogyCard]));
  }

  saveCard(id: string, workId: string, card: GenealogyCard | null) {
    this.db.db.prepare("UPDATE genealogy_papers SET card=? WHERE genealogy_id=? AND work_id=?").run(card ? JSON.stringify(card) : null, id, workId);
  }

  candidates(id: string): GapCandidate[] {
    return (this.db.db.prepare("SELECT data FROM genealogy_candidates WHERE genealogy_id=?").all(id) as { data: string }[])
      .map((r) => JSON.parse(r.data) as GapCandidate)
      .sort((a, b) => b.score - a.score);
  }

  saveCandidate(id: string, candidate: GapCandidate) {
    this.db.db
      .prepare("INSERT INTO genealogy_candidates VALUES(?,?,?) ON CONFLICT(genealogy_id,id) DO UPDATE SET data=excluded.data")
      .run(id, candidate.id, JSON.stringify(candidate));
  }

  state<T>(id: string, key: "outline", value?: Outline | null): T | null;
  state<T>(id: string, key: "branches", value?: Branch[]): T | null;
  state<T>(id: string, key: "checks", value?: CheckItem[]): T | null;
  state<T>(id: string, key: "outputs", value?: GenealogyOutputs): T | null;
  state<T>(id: string, key: "pack" | "hashes", value?: unknown): T | null;
  state<T>(id: string, key: string, value?: unknown): T | null {
    if (value !== undefined) {
      if (value === null) this.db.db.prepare("DELETE FROM genealogy_state WHERE genealogy_id=? AND key=?").run(id, key);
      else
        this.db.db
          .prepare("INSERT INTO genealogy_state VALUES(?,?,?) ON CONFLICT(genealogy_id,key) DO UPDATE SET data=excluded.data")
          .run(id, key, JSON.stringify(value));
      return (value as T) ?? null;
    }
    const row = this.db.db.prepare("SELECT data FROM genealogy_state WHERE genealogy_id=? AND key=?").get(id, key) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }

  /** Written section texts by section uid. */
  sectionTexts(id: string): Map<string, string> {
    const rows = this.db.db.prepare("SELECT key,data FROM genealogy_state WHERE genealogy_id=? AND key LIKE 'text:%'").all(id) as { key: string; data: string }[];
    return new Map(rows.map((r) => [r.key.slice(5), JSON.parse(r.data) as string]));
  }

  saveSectionText(id: string, uid: string, text: string) {
    this.db.db
      .prepare("INSERT INTO genealogy_state VALUES(?,?,?) ON CONFLICT(genealogy_id,key) DO UPDATE SET data=excluded.data")
      .run(id, `text:${uid}`, JSON.stringify(text));
  }

  text<T>(key: string, value?: T): T | null {
    if (value !== undefined) {
      this.db.db.prepare("INSERT OR REPLACE INTO genealogy_texts VALUES(?,?,?)").run(key, JSON.stringify(value), now());
      return value;
    }
    const row = this.db.db.prepare("SELECT data FROM genealogy_texts WHERE key=?").get(key) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }

  /** Members of the genealogy's collection that are not in the trash. */
  collectionIds(genealogy: Genealogy): string[] {
    return (
      this.db.db
        .prepare(
          "SELECT cw.work_id AS id FROM collection_works cw JOIN project_works pw ON pw.work_id=cw.work_id AND pw.project_id=? WHERE cw.collection_id=? AND json_extract(pw.state,'$.screening')!='trash'",
        )
        .all(genealogy.projectId, genealogy.collectionId) as { id: string }[]
    ).map((r) => r.id);
  }
}
