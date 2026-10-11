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
      if (existing.empty()) instance.add(definition);
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
        existing.toggleClass("topic-colored", String(definition.classes).includes("topic-colored"));
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
    forceLayout(instance);
  }
}

/**
 * Barnes-Hut force layout: cytoscape's cose repels every node pair on every
 * iteration and takes ~15 s at 1,000 linked papers; this takes about one.
 */
export function forceLayout(instance: Core) {
  type Point = SimulationNodeDatum & { id: string; radius: number };
  const points: Point[] = instance.nodes().map((node) => ({
    id: node.id(),
    radius: (Number(node.data("diameter")) || 24) / 2,
  }));
  const links = instance.edges().map((edge) => ({
    source: edge.source().id(),
    target: edge.target().id(),
  }));
  // Without a start position d3 seeds a deterministic spiral, so a reset is reproducible.
  const simulation = forceSimulation(points)
    .force("link", forceLink<Point, SimulationLinkDatum<Point>>(links).id((point) => point.id).distance(110))
    .force("charge", forceManyBody<Point>().strength(-320).distanceMax(1200))
    .force("collide", forceCollide<Point>((point) => point.radius + 14))
    // Weak gravity keeps separate citation clusters on one screen.
    .force("x", forceX<Point>(0).strength(0.05))
    .force("y", forceY<Point>(0).strength(0.05))
    .stop();
  simulation.tick(Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay())));
  instance.batch(() => {
    for (const point of points)
      instance.getElementById(point.id).position({ x: point.x ?? 0, y: point.y ?? 0 });
  });
  instance.fit(undefined, 50);
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
