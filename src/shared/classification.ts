import type { ArchiveTopic, WorkView } from "./types";

export const MAX_ARCHIVE_TOPICS = 10;
export const TOPIC_COLORS = [
  "#4e91d0", "#e19342", "#aa78c6", "#42a59a", "#df7188",
  "#90a84b", "#7c8cdb", "#be8863", "#c397c1", "#63adca",
] as const;
export const UNCLASSIFIED_COLOR = "#92999e";

export function archiveNodeColor(work: Pick<WorkView, "archiveTopicId" | "state">, topics: ArchiveTopic[]): string | null {
  if (work.state.screening !== "included") return null;
  return topics.find(topic => topic.id === work.archiveTopicId)?.color || UNCLASSIFIED_COLOR;
}
