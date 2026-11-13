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

/**
 * One-hue (blue) ramps for publication year, older to newer. Light runs light
 * to dark, dark runs dark to light, so newer papers always stand out from the
 * graph surface. Both pass the dataviz ordinal checks against the graph
 * backgrounds (#f7f8f5 light, #242c29 dark): monotone lightness, visible gaps,
 * the faint end at ≥ 2:1.
 */
export const YEAR_RAMP = {
  light: ["#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"],
  dark: ["#1c5cab", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"],
} as const;

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Colour for a year inside `range`, interpolated along the theme's ramp; no year is neutral grey. */
export function yearColor(year: number | null, range: [number, number] | null, dark: boolean): string {
  if (year === null || !range) return UNCLASSIFIED_COLOR;
  const ramp = YEAR_RAMP[dark ? "dark" : "light"];
  const [low, high] = range;
  const t = high > low ? Math.min(1, Math.max(0, (year - low) / (high - low))) : 1;
  const position = t * (ramp.length - 1);
  const index = Math.min(ramp.length - 2, Math.floor(position));
  const [a, b] = [rgb(ramp[index]), rgb(ramp[index + 1])];
  const mix = position - index;
  return "#" + a.map((value, i) => Math.round(value + (b[i] - value) * mix).toString(16).padStart(2, "0")).join("");
}

export function archiveNodeColor(work: Pick<WorkView, "archiveTopicId" | "state">, topics: ArchiveTopic[]): string | null {
  if (work.state.screening !== "included") return null;
  return topics.find(topic => topic.id === work.archiveTopicId)?.color || UNCLASSIFIED_COLOR;
}
