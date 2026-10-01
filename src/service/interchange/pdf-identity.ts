import { normalizeDoi, titleSimilarity } from "../../shared/domain";
import type { Work } from "../../shared/types";
import type { extractPdf } from "./pdf";

type Document = Awaited<ReturnType<typeof extractPdf>>;
export function isAuxiliaryPdf(document: Pick<Document, "title" | "text">) {
  const auxiliary = /^(?:correction to\b|corrigendum\b|erratum\b|supplement(?:ary|al)?(?:\s+information|\s+material|\s+data)?\b|supporting information\b)/i;
  return auxiliary.test(document.title.trim()) || auxiliary.test(document.text.replace(/^\s*\d*\s*/, ""));
}
export function matchesDownloadedPdf(document: Document, work: Work) {
  if (!document.pages || isAuxiliaryPdf(document)) return false;
  const score = titleSimilarity(document.title, work.title);
  const doi = normalizeDoi(work.doi);
  const dois = document.dois.map(normalizeDoi).filter(Boolean);
  const doiMatch = !!doi && dois.includes(doi);
  return (doiMatch && score >= 0.5) || (score >= 0.9 && (!dois.length || doiMatch));
}
