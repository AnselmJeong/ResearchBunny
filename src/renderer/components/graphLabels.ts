import type { Core } from "cytoscape";

/** Labels keep this on-screen size at every zoom level, so zooming out still leaves names readable. */
export const LABEL_FONT_PX = 11;
const LABEL_GAP_PX = 8;
const LABEL_PAD_PX = 3;
const LABEL_MAX_PX = 150;
/** Enough names to orient a 1,000-paper map without covering it. */
export const LABEL_LIMIT = 60;

export interface LabelCandidate {
  id: string;
  /** Rendered (screen) coordinates of the node centre. */
  x: number;
  y: number;
  radius: number;
  text: string;
  /** Shown even when it overlaps another label: the inspected or hovered paper. */
  forced?: boolean;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const WIDE = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/;

/** Rough rendered width: Hangul and CJK glyphs take a full em, Latin about 0.6 of one. */
export function labelWidth(text: string): number {
  let width = 0;
  for (const char of text) width += WIDE.test(char) ? LABEL_FONT_PX : LABEL_FONT_PX * 0.6;
  return Math.min(LABEL_MAX_PX, width) + 2 * LABEL_PAD_PX;
}

/** Where Cytoscape draws a bottom label: centred under the node, a fixed gap below its edge. */
function labelBox(candidate: LabelCandidate): Box {
  const half = labelWidth(candidate.text) / 2;
  const top = candidate.y + candidate.radius + LABEL_GAP_PX - LABEL_PAD_PX;
  return {
    left: candidate.x - half,
    right: candidate.x + half,
    top,
    bottom: top + LABEL_FONT_PX * 1.3 + 2 * LABEL_PAD_PX,
  };
}

const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Greedy placement in priority order. Forced labels always show; every other
 * label shows only when it is on screen and clear of the labels already placed,
 * up to `limit` of them.
 */
export function pickLabels(
  candidates: LabelCandidate[],
  viewport: { width: number; height: number },
  limit = LABEL_LIMIT,
): Set<string> {
  const chosen = new Set<string>();
  const placed: Box[] = [];
  for (const candidate of candidates)
    if (candidate.forced && !chosen.has(candidate.id)) {
      chosen.add(candidate.id);
      placed.push(labelBox(candidate));
    }
  let optional = 0;
  for (const candidate of candidates) {
    if (optional >= limit) break;
    if (chosen.has(candidate.id) || !candidate.text) continue;
    const box = labelBox(candidate);
    if (box.right < 0 || box.left > viewport.width || box.bottom < 0 || box.top > viewport.height) continue;
    if (placed.some((other) => overlaps(box, other))) continue;
    chosen.add(candidate.id);
    placed.push(box);
    optional++;
  }
  return chosen;
}

/** Model-space label geometry that renders at a constant screen size for this zoom. */
export function labelGeometry(zoom: number) {
  const scale = zoom > 0 && Number.isFinite(zoom) ? 1 / zoom : 1;
  return {
    labelSize: LABEL_FONT_PX * scale,
    labelMargin: LABEL_GAP_PX * scale,
    labelWidth: LABEL_MAX_PX * scale,
    labelPad: LABEL_PAD_PX * scale,
  };
}

/**
 * Write each node's visible label from its `fullLabel`. Candidates come in
 * priority order: `forced` first, then `boosted` (hover neighbours, search
 * matches, the selection), then `order` when ordinary labels are enabled.
 * Faded papers only get a label when forced or boosted.
 */
export function refreshLabels(
  instance: Core,
  options: {
    order: string[];
    forced?: string[];
    boosted?: string[];
    enabled: boolean;
    viewport?: { width: number; height: number };
  },
): Set<string> {
  const seen = new Set<string>();
  const candidates: LabelCandidate[] = [];
  const add = (id: string, kind: "forced" | "boosted" | "ordinary") => {
    if (seen.has(id)) return;
    const node = instance.getElementById(id);
    if (node.empty() || !node.isNode()) return;
    if (kind === "ordinary" && (node.hasClass("faded") || node.hasClass("hover-dim") || node.hasClass("cluster-dim"))) return;
    seen.add(id);
    const position = node.renderedPosition();
    candidates.push({
      id,
      x: position.x,
      y: position.y,
      radius: node.renderedWidth() / 2,
      text: String(node.data("fullLabel") ?? ""),
      forced: kind === "forced",
    });
  };
  for (const id of options.forced ?? []) add(id, "forced");
  for (const id of options.boosted ?? []) add(id, "boosted");
  if (options.enabled) for (const id of options.order) add(id, "ordinary");
  const chosen = pickLabels(
    candidates,
    options.viewport ?? { width: instance.width(), height: instance.height() },
  );
  const geometry = labelGeometry(instance.zoom());
  instance.batch(() => {
    instance.nodes().forEach((node) => {
      const show = chosen.has(node.id());
      const label = show ? String(node.data("fullLabel") ?? "") : "";
      if (node.data("label") !== label) node.data("label", label);
      if (show && node.data("labelSize") !== geometry.labelSize) node.data(geometry);
    });
  });
  return chosen;
}
