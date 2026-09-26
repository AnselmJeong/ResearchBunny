import { Cite, plugins } from "@citation-js/core";
import "@citation-js/plugin-bibtex";
import type { Work, WorkView } from "../../shared/types";
import { blankWork, normalizeDoi } from "../../shared/domain";
export interface BibEntry {
  work?: Work;
  error?: string;
  name: string;
}
interface RawEntry {
  type: string;
  label: string;
  properties: Record<string, string>;
}
// This scanner isolates records for partial-error recovery. Citation.js parses the grammar.
export function splitBib(text: string): string[] {
  const blocks: string[] = [];
  let start = -1,
    depth = 0,
    quoted = false,
    escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) {
      if (c === "@" && /^@\w+\s*[{(]/.test(text.slice(i))) {
        start = i;
        depth = 0;
        quoted = false;
      } else continue;
    }
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"' && depth <= 1) quoted = !quoted;
    if (!quoted) {
      if (c === "{" || (c === "(" && depth === 0)) depth++;
      if (c === "}" || (c === ")" && depth === 1)) depth--;
    }
    if (depth === 0 && (c === "}" || c === ")")) {
      blocks.push(text.slice(start, i + 1));
      start = -1;
    } else if (
      c === "\n" &&
      /^\s*@\w+\s*[{(]/.test(text.slice(i + 1)) &&
      depth === 1 &&
      !quoted
    ) {
      blocks.push(text.slice(start, i));
      start = -1;
    }
  }
  if (start >= 0) blocks.push(text.slice(start));
  return blocks;
}
export function parseBib(text: string): BibEntry[] {
  const blocks = splitBib(text);
  if (!blocks.length)
    return [{ name: "BibTeX", error: "BibTeX 엔트리를 찾지 못했습니다." }];
  const macros = blocks
    .filter((b) => /^@(?:string|preamble)\b/i.test(b))
    .join("\n");
  const entries: RawEntry[] = [];
  const originals = new Map<string, string>();
  const errors: BibEntry[] = [];
  for (const block of blocks) {
    if (/^@(?:string|preamble|comment)\b/i.test(block)) continue;
    try {
      const raw = plugins.input.chain(`${macros}\n${block}`, {
        target: "@bibtex/entries+list",
        forceType: "@bibtex/text",
      }) as RawEntry[];
      for (const entry of raw) {
        entries.push(entry);
        originals.set(entry.label, `${macros}\n${block}`);
      }
    } catch {
      errors.push({
        name: block.slice(0, 80).split("\n")[0],
        error: "구문을 해석하지 못했습니다. 중괄호·따옴표를 확인하세요.",
      });
    }
  }
  const resolved = new Map(entries.map((e) => [e.label, e]));
  const result: BibEntry[] = entries.map((entry) => {
    try {
      const inherit = (
        e: RawEntry,
        seen = new Set<string>(),
      ): Record<string, string> => {
        if (seen.has(e.label)) return e.properties;
        seen.add(e.label);
        const parent = resolved.get(e.properties.crossref);
        return parent
          ? { ...inherit(parent, seen), ...e.properties }
          : e.properties;
      };
      const props = inherit(entry);
      const csl = new Cite([{ ...entry, properties: props }], {
        forceType: "@bibtex/entries+list",
      }).data[0];
      const authors = (csl.author || []).map(
        (a: any) => a.literal || [a.family, a.given].filter(Boolean).join(", "),
      );
      const year = csl.issued?.["date-parts"]?.[0]?.[0];
      return {
        name: entry.label,
        work: blankWork({
          title: csl.title || props.title || "제목 미확인",
          authors,
          year: typeof year === "number" && year > 0 ? year : null,
          doi: normalizeDoi(csl.DOI),
          type: entry.type,
          venue: csl["container-title"] || "",
          abstract: csl.abstract || null,
          url: csl.URL || null,
          volume: String(csl.volume || ""),
          issue: String(csl.issue || ""),
          pages: String(csl.page || ""),
          publisher: csl.publisher || "",
          citekey: entry.label,
          source: "bibtex",
          bibFields: props,
          bibType: entry.type,
          originalBib: originals.get(entry.label),
          raw: { entry, csl },
        }),
      };
    } catch {
      return {
        name: entry.label,
        error:
          "필드 형식을 해석하지 못했습니다. 원 엔트리를 수정해 다시 가져오세요.",
      };
    }
  });
  return [...result, ...errors];
}
const escapeBib = (v: string) =>
  v
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/[{}]/g, (c) => `\\${c}`)
    .replace(/[&%$#_]/g, (c) => `\\${c}`)
    .replace(/\n/g, " ");
export function exportBib(
  works: (Work | WorkView)[],
  opts: {
    includeNotes?: boolean;
    includeFiles?: boolean;
    files?: Record<string, string[]>;
  } = {},
): { text: string; mappings: { from: string; to: string }[] } {
  const unique = [...new Map(works.map((w) => [w.id, w])).values()];
  const used = new Set<string>();
  const mapping = new Map<string, string>();
  for (const w of unique) {
    const base = w.citekey || "Work";
    let key = base,
      n = 1;
    while (used.has(key)) key = `${base}_${n++}`;
    used.add(key);
    mapping.set(w.citekey, key);
  }
  const entries = unique.map((w) => {
    const fields: Record<string, string> = { ...w.bibFields };
    const set = (field: string, value: unknown, edited: string) => {
      if (!fields[field] || Object.hasOwn(w.edits, edited)) {
        if (value !== null && value !== undefined && value !== "")
          fields[field] = escapeBib(String(value));
        else delete fields[field];
      }
    };
    set("title", w.title, "title");
    if (!fields.author || Object.hasOwn(w.edits, "authors"))
      fields.author = w.authors
        .map((a) => (a.includes(",") ? escapeBib(a) : `{${escapeBib(a)}}`))
        .join(" and ");
    set("year", w.year, "year");
    set("journal", w.venue, "venue");
    set("doi", w.doi, "doi");
    set("url", w.url, "url");
    set("volume", w.volume, "volume");
    set("number", w.issue, "issue");
    set("pages", w.pages, "pages");
    set("publisher", w.publisher, "publisher");
    if (fields.crossref) {
      const parent = mapping.get(fields.crossref);
      if (parent) fields.crossref = parent;
      else delete fields.crossref;
    }
    for (const key of Object.keys(fields)) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9_:+.-]*$/.test(key) ||
        /^(file|pdf|attachment|local-url|annote|annotation|keywords|note)$/i.test(
          key,
        ) ||
        /(?:file:\/\/|\/Users\/|\/Volumes\/|[A-Z]:\\)/.test(fields[key])
      )
        delete fields[key];
    }
    if (opts.includeNotes && "state" in w) {
      if (w.state.note) fields.note = escapeBib(w.state.note);
      if (w.state.tags.length)
        fields.keywords = escapeBib(w.state.tags.join(", "));
    }
    if (opts.includeFiles && opts.files?.[w.id]?.length)
      fields.file = escapeBib(opts.files[w.id].join(";"));
    const type =
      (
        w.bibType ||
        {
          review: "article",
          article: "article",
          preprint: "unpublished",
          "book-chapter": "incollection",
          "proceedings-article": "inproceedings",
        }[w.type] ||
        w.type
      ).replace(/[^a-z]/gi, "") || "misc";
    return `@${type}{${mapping.get(w.citekey)},\n${Object.entries(fields)
      .filter(([, v]) => v !== "")
      .map(([k, v]) => `  ${k} = {${v}}`)
      .join(",\n")}\n}`;
  });
  return {
    text: entries.join("\n\n") + "\n",
    mappings: unique.map((w) => ({
      from: w.citekey,
      to: mapping.get(w.citekey)!,
    })),
  };
}
