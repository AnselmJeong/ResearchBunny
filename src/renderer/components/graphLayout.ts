import type { Core, ElementDefinition, EventObject } from "cytoscape";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

export type GraphPositions = Record<string, { x: number; y: number }>;

export function capturePositions(instance: Core): GraphPositions {
  return Object.fromEntries(
    instance.nodes().map((node) => [node.id(), { ...node.position() }]),
  );
}

/** Keep existing node objects alive so selection/inspection cannot interrupt a drag. */
export function reconcileGraph(
  instance: Core,
  definitions: ElementDefinition[],
) {
  const ids = new Set(definitions.map((element) => element.data.id));
  instance.batch(() => {
    instance
      .elements()
      .filter((element) => !ids.has(element.id()))
      .remove();
    for (const definition of definitions) {
      const existing = instance.getElementById(definition.data.id!);
      // Cytoscape keeps the position object it is given and moves the node by
      // mutating it, which would rewrite the caller's saved network layout
      // (e.g. with timeline coordinates). Hand it a copy.
      if (existing.empty())
        instance.add({ ...definition, position: definition.position && { ...definition.position } });
      else {
        existing.data(definition.data);
        existing.toggleClass(
          "questionable",
          String(definition.classes).includes("questionable"),
        );
        existing.toggleClass(
          "seed",
          String(definition.classes).includes("seed"),
        );
        existing.toggleClass(
          "saved",
          String(definition.classes).includes("saved"),
        );
        existing.toggleClass("color-mapped", String(definition.classes).includes("color-mapped"));
      }
    }
  });
}

export function placeGraph(
  instance: Core,
  works: { id: string; year: number | null }[],
  timeline: boolean,
  previousTimeline: boolean | null,
  savedPositions: GraphPositions,
  reset = false,
) {
  if (timeline) {
    const years = [...new Set(works.map((work) => work.year))].sort(
      (a, b) => (a ?? Infinity) - (b ?? Infinity),
    );
    const lanes = new Map<number | null, number>();
    for (const work of works) {
      const lane = lanes.get(work.year) ?? 0;
      lanes.set(work.year, lane + 1);
      instance.getElementById(work.id).position({
        x: years.indexOf(work.year) * 170,
        y: lane * 90,
      });
    }
    instance.fit(undefined, 50);
    return;
  }
  // Timeline coordinates must never be treated as a saved network layout.
  if (!reset && works.every((work) => savedPositions[work.id])) {
    instance.nodes().forEach((node) => {
      node.position(savedPositions[node.id()]);
    });
    if (previousTimeline !== false) instance.fit(undefined, 50);
  } else {
    // A few new papers join a layout the person may have arranged by hand: the placed papers stay
    // where they are and only the new ones are fitted in. With little to hold on to, lay out afresh.
    const placed = works.filter((work) => savedPositions[work.id]).length;
    if (!reset && placed >= works.length / 2) forceLayout(instance, savedPositions, previousTimeline !== false);
    else forceLayout(instance);
  }
}

/**
 * Barnes-Hut force layout: cytoscape's cose repels every node pair on every
 * iteration and takes ~15 s at 1,000 linked papers; this takes about one.
 */
export function forceLayout(instance: Core, pinned: GraphPositions = {}, fit = true) {
  type Point = SimulationNodeDatum & { id: string; radius: number };
  const partial = Object.keys(pinned).length > 0;
  const points: Point[] = instance.nodes().map((node) => {
    const at = pinned[node.id()];
    return {
      id: node.id(),
      radius: (Number(node.data("diameter")) || 24) / 2,
      ...(at ? { x: at.x, y: at.y, fx: at.x, fy: at.y } : {}),
    };
  });
  const links = instance.edges().map((edge) => ({
    source: edge.source().id(),
    target: edge.target().id(),
  }));
  if (partial) {
    // A new paper starts beside the papers it links to, not at the centre of the whole graph.
    const byId = new Map(points.map((point) => [point.id, point]));
    points.forEach((point, index) => {
      if (point.fx !== undefined) return;
      const near = links
        .filter((link) => link.source === point.id || link.target === point.id)
        .map((link) => pinned[link.source === point.id ? link.target : link.source])
        .filter(Boolean);
      const anchor = near.length ? near : Object.values(pinned);
      const angle = index * 2.4;
      byId.get(point.id)!.x = anchor.reduce((sum, p) => sum + p.x, 0) / anchor.length + Math.cos(angle) * 60;
      byId.get(point.id)!.y = anchor.reduce((sum, p) => sum + p.y, 0) / anchor.length + Math.sin(angle) * 60;
    });
  }
  // Without a start position d3 seeds a deterministic spiral, so a reset is reproducible.
  const simulation = forceSimulation(points)
    .force("link", forceLink<Point, SimulationLinkDatum<Point>>(links).id((point) => point.id).distance(110))
    .force("charge", forceManyBody<Point>().strength(-320).distanceMax(1200))
    .force("collide", forceCollide<Point>((point) => point.radius + 14))
    // Weak gravity keeps separate citation clusters on one screen.
    .force("x", forceX<Point>(0).strength(0.05))
    .force("y", forceY<Point>(0).strength(0.05))
    .stop();
  // Only the unplaced papers move in a partial layout, so far fewer steps settle them.
  simulation.tick(partial ? 120 : Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay())));
  instance.batch(() => {
    for (const point of points)
      instance.getElementById(point.id).position({ x: point.x ?? 0, y: point.y ?? 0 });
  });
  if (fit) instance.fit(undefined, 50);
}

/** Paper selection must not turn a single-node drag into a group drag. */
export function individualNodeDragging(instance: Core) {
  let held = instance.collection();
  const release = () => {
    held.unlock();
    held = instance.collection();
  };
  const grab = (event: EventObject) => {
    release();
    held = instance.nodes(":selected:unlocked").difference(event.target);
    held.lock();
  };
  instance.on("grabon", "node", grab);
  instance.on("freeon", "node", release);
  return () => {
    release();
    instance.off("grabon", "node", grab);
    instance.off("freeon", "node", release);
  };
}
