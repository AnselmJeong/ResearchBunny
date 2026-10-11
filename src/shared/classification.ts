import type { ArchiveTopic, WorkView } from "./types";

export const MAX_ARCHIVE_TOPICS = 10;
export const TOPIC_COLORS = [
  "#4e91d0", "#e19342", "#aa78c6", "#42a59a", "#df7188",
  "#90a84b", "#7c8cdb", "#be8863", "#c397c1", "#63adca",
] as const;
export const UNCLASSIFIED_COLOR = "#92999e";

/** Shelf subfolders: the largest drawn groups get colours; smaller ones and loose files stay neutral. */
export function subfolderColors(ids: string[], subfolders: Record<string, string>) {
  const counts = new Map<string, number>();
  for (const id of ids)
    if (subfolders[id]) counts.set(subfolders[id], (counts.get(subfolders[id]) || 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const colors = new Map<string, string>(ranked.slice(0, TOPIC_COLORS.length).map(([path], index) => [path, TOPIC_COLORS[index]]));
  return {
    groups: [...colors].map(([path, color]) => ({ path, name: path.slice(path.lastIndexOf("/") + 1), color })),
    others: ranked.length - colors.size,
    loose: ids.some((id) => !subfolders[id]),
    color: (id: string) => colors.get(subfolders[id]) ?? UNCLASSIFIED_COLOR,
  };
}

export function archiveNodeColor(work: Pick<WorkView, "archiveTopicId" | "state">, topics: ArchiveTopic[]): string | null {
  if (work.state.screening !== "included") return null;
  return topics.find(topic => topic.id === work.archiveTopicId)?.color || UNCLASSIFIED_COLOR;
}
