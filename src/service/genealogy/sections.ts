import type { PaperType, TextBasis } from "../../shared/genealogy";
import { bodyWithoutReferences } from "../interchange/pdf-reader";

/** Where a paper's text was cut. Every part is plain text; `body` is everything before the references. */
export interface PaperText {
  source: Exclude<TextBasis, "none">;
  abstract: string;
  introduction: string;
  methods: string;
  results: string;
  discussion: string;
  conclusion: string;
  body: string;
  /** Section titles found, in order, for the notes and the reader. */
  headings: string[];
  /** Problems the reader of a card should know about. */
  notes: string[];
}

type Part = "abstract" | "introduction" | "methods" | "results" | "discussion" | "conclusion";

/** A section title, by the usual names in English and a few other languages. */
export function partOf(title: string): Part | null {
  const t = title.toLowerCase().replace(/^(?:\d{1,2}(?:\.\d{1,2})*|[ivx]{1,4})[.)]?\s+/i, "").replace(/[:.]\s*$/, "").trim();
  if (/^(abstract|summary|요약|초록)$/.test(t)) return "abstract";
  if (/^(introduction|background|rationale|overview|aims?|objectives?|einleitung|introducci[oó]n|서론|배경)\b/.test(t)) return "introduction";
  if (/^(methods?|materials?|patients?|subjects?|participants?|experimental procedures?|study design|methodology|방법|연구 방법)\b/.test(t)) return "methods";
  if (/^(results?|findings|결과)\b/.test(t)) return /discussion/.test(t) ? "discussion" : "results";
  if (/^(discussion|general discussion|comment|고찰|논의)\b/.test(t)) return "discussion";
  if (/^(conclusions?|concluding remarks|summary and conclusions?|결론|맺음)\b/.test(t)) return "conclusion";
  return null;
}

// --- JATS (Europe PMC full text) ---

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: (XmlNode | string)[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) =>
    code[0] === "#"
      ? String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10))
      : (ENTITIES[code.toLowerCase()] ?? whole),
  );

/** A tolerant XML reader for well-formed JATS: elements, attributes, text and CDATA. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  const tag = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g;
  let last = 0;
  for (const match of xml.matchAll(tag)) {
    const top = stack[stack.length - 1];
    if (match.index! > last) top.children.push(decode(xml.slice(last, match.index)));
    last = match.index! + match[0].length;
    if (match[1] !== undefined) top.children.push(match[1]);
    else if (match[2]) {
      const name = match[2];
      for (let i = stack.length - 1; i > 0; i--)
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
    } else if (match[3]) {
      const attrs: Record<string, string> = {};
      for (const a of (match[4] || "").matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3] ?? "");
      const node: XmlNode = { name: match[3], attrs, children: [] };
      top.children.push(node);
      if (!match[5]) stack.push(node);
    }
  }
  if (last < xml.length) stack[stack.length - 1].children.push(decode(xml.slice(last)));
  return root;
}

const find = (node: XmlNode, name: string): XmlNode | null => {
  for (const child of node.children)
    if (typeof child !== "string") {
      if (child.name === name) return child;
      const found = find(child, name);
      if (found) return found;
    }
  return null;
};
const elements = (node: XmlNode, name: string) =>
  node.children.filter((c): c is XmlNode => typeof c !== "string" && c.name === name);

/** Figures, tables and formulas carry no prose a card can use; captions stay out too. */
const SKIP = new Set(["table-wrap", "fig", "disp-formula", "table", "graphic", "media", "supplementary-material", "ref-list", "fn-group", "inline-formula", "tex-math", "mml:math"]);
const BLOCK = new Set(["p", "title", "list-item", "sec", "abstract", "boxed-text", "disp-quote", "def-item"]);
function textOf(node: XmlNode | string): string {
  if (typeof node === "string") return node;
  if (SKIP.has(node.name)) return "";
  const inner = node.children.map(textOf).join("");
  return BLOCK.has(node.name) ? `\n${inner.trim()}\n` : inner;
}
const clean = (text: string) =>
  text
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export function jatsText(xml: string): PaperText | null {
  const article = find(parseXml(xml), "article");
  if (!article) return null;
  const body = find(article, "body");
  const front = find(article, "front");
  const abstract = front ? elements(find(front, "article-meta") ?? front, "abstract").map(textOf).join("\n") : "";
  const result = blank("jats");
  result.abstract = clean(abstract);
  if (!body) {
    result.body = result.abstract;
    result.notes.push("PMC 전문에 본문이 없습니다.");
    return result.abstract ? result : null;
  }
  const loose: string[] = [];
  for (const child of body.children) {
    if (typeof child === "string") {
      loose.push(child);
      continue;
    }
    if (child.name !== "sec") {
      loose.push(textOf(child));
      continue;
    }
    const title = clean(textOf(elements(child, "title")[0] ?? { name: "title", attrs: {}, children: [] }));
    result.headings.push(title);
    const part = partFromSecType(child.attrs["sec-type"]) ?? partOf(title);
    const text = clean(textOf(child));
    if (part) result[part] = [result[part], text].filter(Boolean).join("\n\n");
  }
  // Text before the first titled section is usually the introduction of articles that do not title it.
  const preface = clean(loose.join("\n"));
  if (preface && !result.introduction) result.introduction = preface;
  result.body = clean(textOf(body));
  if (!result.introduction && !result.discussion) result.notes.push("PMC 전문에서 서론·논의 절을 구분하지 못했습니다.");
  return result;
}

function partFromSecType(type: string | undefined): Part | null {
  if (!type) return null;
  const t = type.toLowerCase();
  if (t.startsWith("intro")) return "introduction";
  if (t.includes("method") || t.includes("materials") || t.includes("subjects") || t.includes("cases")) return "methods";
  if (t.startsWith("results") && t.includes("discussion")) return "discussion";
  if (t.startsWith("results")) return "results";
  if (t.startsWith("discussion")) return "discussion";
  if (t.startsWith("conclusion")) return "conclusion";
  return null;
}

function blank(source: PaperText["source"]): PaperText {
  return { source, abstract: "", introduction: "", methods: "", results: "", discussion: "", conclusion: "", body: "", headings: [], notes: [] };
}

// --- PDF text ---

const HEADING =
  /^(?:(?:\d{1,2}|[ivx]{1,4})(?:\.\d{1,2})*\.?\s+)?(abstract|summary|introduction|background|methods?|materials and methods|patients and methods|subjects and methods|methodology|study design|experimental procedures|results(?: and discussion)?|findings|discussion|general discussion|conclusions?|concluding remarks|summary and conclusions?|서론|배경|방법|결과|고찰|논의|결론)\s*[:.]?\s*$/i;

/** Splits text extracted from a PDF at its section headings; references are already gone. */
export function pdfText(raw: string): PaperText {
  const result = blank("pdf");
  const { text, referencesExcluded } = bodyWithoutReferences(raw);
  if (!referencesExcluded) result.notes.push("참고문헌 경계를 찾지 못해 추출한 텍스트 전체를 읽습니다.");
  result.body = clean(text);
  const lines = result.body.split("\n");
  const marks: { line: number; part: Part; title: string }[] = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.length > 60) return;
    const m = t.match(HEADING);
    if (!m) return;
    const part = partOf(m[1]);
    if (!part) return;
    // The first of each kind wins, except that a later Discussion beats an early mention in a table of contents.
    if (marks.some((mark) => mark.part === part) && part !== "discussion" && part !== "conclusion") return;
    marks.push({ line: i, part, title: t });
  });
  marks.sort((a, b) => a.line - b.line);
  result.headings = marks.map((m) => m.title);
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].line + 1;
    const to = i + 1 < marks.length ? marks[i + 1].line : lines.length;
    const part = marks[i].part;
    const chunk = clean(lines.slice(from, to).join("\n"));
    result[part] = [result[part], chunk].filter(Boolean).join("\n\n");
  }
  const first = marks[0]?.line ?? lines.length;
  if (!result.introduction) {
    // No Introduction heading: the introduction runs on after the abstract, or fills the text before the first heading.
    const front = clean(lines.slice(0, first).join("\n"));
    const abstractWords = words(result.abstract);
    if (abstractWords.length > 450) {
      result.introduction = abstractWords.slice(300).join(" ");
      result.abstract = abstractWords.slice(0, 300).join(" ");
      result.notes.push("서론 제목이 없어 초록 뒤 본문을 서론으로 읽었습니다.");
    } else if (marks.length && front.length > 400 && !marks.some((m) => m.part === "abstract")) {
      result.introduction = front;
      result.notes.push("서론 제목이 없어 첫 절 앞 본문을 서론으로 읽었습니다.");
    } else {
      result.introduction = clean(result.body.slice(0, Math.round(result.body.length * 0.25)));
      result.notes.push("절 경계를 찾지 못해 본문 앞 25%를 서론으로 읽었습니다.");
    }
  }
  if (!result.discussion && marks.length) result.notes.push("논의 절을 찾지 못했습니다.");
  return result;
}

// --- What a card reads ---

const words = (text: string) => text.split(/\s+/).filter(Boolean);
const firstWords = (text: string, n: number) => {
  const all = words(text);
  return all.length <= n ? text : `${all.slice(0, n).join(" ")} …`;
};

/**
 * The text a card reads for a paper type, as the genealogy skill reads it:
 * reviews whole, meta-analyses introduction and discussion, original articles
 * introduction with the start of the discussion, peripheral papers briefly.
 */
export function readingText(type: PaperType, text: PaperText | null, abstract: string | null): { text: string; basis: TextBasis; note: string } {
  const abs = (text?.abstract || abstract || "").trim();
  if (!text || !text.body.trim()) return abs ? { text: `[Abstract]\n${abs}`, basis: "abstract", note: "초록만 읽음" } : { text: "", basis: "none", note: "읽을 본문과 초록이 없음" };
  const part = (label: string, value: string) => (value.trim() ? `[${label}]\n${value.trim()}` : "");
  let parts: string[];
  if (type === "R") parts = [part("Abstract", abs), part("Body", text.body)];
  else if (type === "M") parts = [part("Abstract", abs), part("Introduction", text.introduction), part("Discussion", text.discussion || text.conclusion)];
  else if (type === "O")
    parts = [part("Abstract", abs), part("Introduction", text.introduction), part("Discussion (opening)", firstWords(text.discussion, 900)), part("Conclusion", text.conclusion)];
  else parts = [part("Abstract", abs), part("Introduction (opening)", firstWords(text.introduction, 700))];
  const body = parts.filter(Boolean).join("\n\n");
  const found = [text.introduction && "서론", text.discussion && "논의", text.conclusion && "결론"].filter(Boolean).join("·");
  const note = [type === "R" ? "본문 전체" : found ? `${found} 읽음` : "절 구분 없음", ...text.notes].join(" · ");
  return { text: body, basis: text.source, note };
}
