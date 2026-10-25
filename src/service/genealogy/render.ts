import { spawn } from "node:child_process";
import type { CheckItem, Genealogy, GenealogyPaper, Outline } from "../../shared/genealogy";
import { NUMERIC_CITATION, citedKeys } from "../../shared/citations";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a tool with a time limit; output is kept to the last megabyte. */
export function runTool(command: string, args: string[], cwd: string, signal: AbortSignal, timeoutMs = 300_000): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PATH: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", process.env.PATH ?? ""].join(":") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout = (stdout + d).slice(-1_000_000)));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-1_000_000)));
    const stop = () => child.kill("SIGTERM");
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (signal.aborted) reject(signal.reason);
      else resolve({ code, stdout, stderr });
    });
  });
}

/** The first Korean serif typst can use: a static Noto CJK, Nanum, the variable Noto, then the system's own. */
export async function typstFont(typst: string, signal: AbortSignal): Promise<string> {
  const preferred = ["Noto Serif CJK KR", "NanumMyeongjo", "Noto Serif KR", "AppleMyungjo"];
  try {
    const { stdout } = await runTool(typst, ["fonts"], "/", signal, 30_000);
    const available = new Set(stdout.split("\n").map((l) => l.trim()));
    return preferred.find((f) => available.has(f)) ?? "AppleMyungjo";
  } catch {
    return "AppleMyungjo";
  }
}

const yaml = (value: string) => JSON.stringify(value);

const PARTICLES = new Set(["van", "von", "de", "der", "den", "da", "di", "del", "della", "du", "le", "la", "dos", "das", "ter", "ten", "bin", "al"]);
/**
 * "Robin L. Carhart-Harris" as "Carhart-Harris, Robin L.", so a citation style
 * can abbreviate given names. Names already in that form, single-word names
 * and names written without spaces (as Korean names often are) stay as they are.
 */
export function familyFirst(name: string): string {
  const trimmed = name.trim();
  if (trimmed.includes(",")) return trimmed;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return trimmed;
  let start = parts.length - 1;
  while (start > 1 && PARTICLES.has(parts[start - 1].toLowerCase())) start--;
  return `${parts.slice(start).join(" ")}, ${parts.slice(0, start).join(" ")}`;
}

/** The whole report as one Pandoc document: front matter, summary, chapters, then the branch ledger. */
export function assemble(g: Genealogy, outline: Outline, chapters: string[], ledger: string | null, files: { bib: string; csl: string }) {
  const header = [
    "---",
    `title: ${yaml(outline.title || g.title)}`,
    ...(outline.subtitle ? [`subtitle: ${yaml(outline.subtitle)}`] : []),
    `date: ${yaml(new Date().toISOString().slice(0, 10))}`,
    "lang: ko",
    `bibliography: ${yaml(files.bib)}`,
    `csl: ${yaml(files.csl)}`,
    `reference-section-title: ${yaml("참고문헌")}`,
    "link-citations: true",
    "---",
    "",
  ];
  const body = [...(outline.summary ? [`> ${outline.summary}`] : []), ...chapters.map((c) => c.trim()), ...(ledger?.includes("\n## ") ? [ledger.trim()] : [])];
  return `${header.join("\n")}\n${body.join("\n\n")}\n`;
}

export const EPUB_CSS = `body { font-family: serif; line-height: 1.7; }
h1 { font-size: 1.5em; margin: 1.6em 0 0.8em; }
h2 { font-size: 1.2em; margin: 1.4em 0 0.6em; }
h3 { font-size: 1.05em; margin: 1.2em 0 0.4em; }
p { margin: 0 0 0.8em; text-align: justify; word-break: keep-all; }
blockquote { margin: 0.8em 1.2em; color: #555; }
table { border-collapse: collapse; font-size: 0.9em; }
td, th { border: 1px solid #ccc; padding: 0.3em 0.5em; vertical-align: top; }
.references div { margin-bottom: 0.5em; }
`;

const EXCLUSIVE = /(최초|처음으로|유일(?:하게|한)?|오직|가장 먼저|\bfirst\b|\bonly\b|\bsole\b)/i;

/** The skill's checklist over the chapters as they are on disk, including the user's edits. */
export function reviewChecks(input: {
  outline: Outline;
  chapters: { file: string; text: string | null; editedByUser: boolean; pendingNew: boolean }[];
  papers: GenealogyPaper[];
  citeprocWarnings: string[] | null;
}): CheckItem[] {
  const { outline, chapters, papers } = input;
  const text = chapters.map((c) => c.text ?? "").join("\n\n");
  const keys = new Set(papers.map((p) => p.key));
  const cited = citedKeys(text);
  const unknown = cited.filter((k) => !keys.has(k));
  const sections = outline.chapters.flatMap((c) => c.sections);
  const unwritten = sections.filter((s) => s.status === "planned" || s.status === "stale");
  const numeric = text.match(NUMERIC_CITATION) ?? [];
  const uncited = papers.filter((p) => !cited.includes(p.key));
  const sentences = text
    .replace(/^#.*$/gm, "")
    .split(/(?<=[.!?。])\s+/)
    .filter((s) => EXCLUSIVE.test(s))
    .map((s) => s.trim().slice(0, 240));
  const numbers = sections.flatMap((s) => s.problems.filter((p) => p.startsWith("카드에서 찾지 못한 수치")).map((p) => `${s.id} ${s.title}: ${p}`));
  const otherProblems = sections.flatMap((s) => s.problems.filter((p) => !p.startsWith("카드에서 찾지 못한 수치")).map((p) => `${s.id} ${s.title}: ${p}`));
  const missing = sections.flatMap((s) => s.missing.map((m) => `${s.id} ${s.title}: ${m.need}${m.hint ? ` (${m.hint})` : ""}`));
  const items: CheckItem[] = [
    { id: "written", label: "모든 절을 썼는가", ok: !unwritten.length && chapters.every((c) => c.text !== null), details: [...unwritten.map((s) => `${s.id} ${s.title}`), ...chapters.filter((c) => c.text === null).map((c) => `${c.file} 없음`)] },
    { id: "keys", label: "인용 키가 모두 계보 문헌에 있는가(= bib에 들어가는가)", ok: !unknown.length, details: unknown },
    { id: "numeric", label: "번호 인용·평문 인용 없이 [@key]만 쓰는가", ok: !numeric.length, details: numeric.slice(0, 20) },
    { id: "citeproc", label: "pandoc 시험 렌더에서 해석되지 않는 인용이 없는가", ok: input.citeprocWarnings !== null && !input.citeprocWarnings.length, details: input.citeprocWarnings ?? ["pandoc을 찾지 못해 확인하지 못했습니다."] },
    { id: "coverage", label: "계보 문헌이 모두 본문에 등장하는가", ok: !uncited.length, details: uncited.map((p) => `@${p.key} · ${p.year ?? ""} ${p.title}`) },
    { id: "numbers", label: "본문의 수치가 카드에 있는가", ok: !numbers.length, details: numbers },
    { id: "exclusive", label: "배타적·비교 주장(최초·유일 등)을 원문과 대조할 목록", ok: !sentences.length, details: sentences.slice(0, 40) },
    { id: "missing", label: "집필 중 요청한 근거", ok: !missing.length, details: missing },
    { id: "problems", label: "집필 검사에서 고친 것", ok: !otherProblems.length, details: otherProblems },
    { id: "edited", label: "직접 고친 장 파일", ok: !chapters.some((c) => c.pendingNew), details: chapters.filter((c) => c.editedByUser).map((c) => `${c.file}${c.pendingNew ? " · 새로 쓴 판은 .rb-new.md로 옆에 두었습니다" : " · 그대로 사용"}`) },
  ];
  return items;
}

/** "[WARNING] Citeproc: citation x not found" lines from a pandoc run. */
export const citeprocWarnings = (stderr: string) => stderr.split("\n").filter((l) => /citeproc|citation .* not found/i.test(l)).map((l) => l.trim());
