// ScholarPen folder links. ScholarPen keeps each manuscript project as a folder
// under one shared root. A ResearchBunny project can be linked to one such
// folder: ResearchBunny then writes plain files into its hidden `.researchbunny/`
// folder and reads the folder's references.bib once, when a project is made from
// it. Each file has one writer. The library itself never moves into the folder.

/** ResearchBunny's own files in a linked folder; ScholarPen hides dot-folders. */
export const LINK_DIR = ".researchbunny";
export const LINK_FILES = {
  project: "project.json",
  archive: "archive.json",
  evidenceCsv: "evidence.csv",
  evidenceMd: "evidence.md",
} as const;
/** The format of the files above; readers check it. */
export const LINK_FORMAT = 1;

export interface ScholarPenFolder {
  /** The folder's name under the root, which is how links are stored. */
  name: string;
  path: string;
  /** The ResearchBunny project linked to it. */
  projectId: string | null;
  hasReferences: boolean;
}
export interface ScholarPenState {
  root: string | null;
  /** False when the root is set but cannot be read (Drive offline, folder moved). */
  online: boolean;
  folders: ScholarPenFolder[];
  /** Project id → linked folder name. */
  links: Record<string, string>;
  /** When each linked project's files were last written, and any write error. */
  synced: Record<string, { at: string; error?: string }>;
}

/** `.researchbunny/project.json`: the link and the project's question and criteria. */
export interface LinkedProjectFile {
  format: number;
  app: "ResearchBunny";
  projectId: string;
  name: string;
  question: string;
  screening: {
    purpose: string;
    intent: string;
    include: string[];
    exclude: string[];
    version: number;
  };
  updatedAt: string;
}
/** One archive paper in `.researchbunny/archive.json`. */
export interface LinkedWork {
  id: string;
  doi: string | null;
  pmid: string | null;
  title: string;
  authors: string[];
  year: number | null;
  venue: string;
  /** R 종설·논평 · M 체계적 고찰·메타분석 · O 원저, when judged. */
  type: string | null;
  contributions: string[];
  collections: string[];
  topic: string | null;
  /** A PDF is in the shelf or attached, and whether its passages are indexed. */
  pdf: boolean;
  indexed: boolean;
}
export interface LinkedArchiveFile {
  format: number;
  projectId: string;
  updatedAt: string;
  works: LinkedWork[];
}
