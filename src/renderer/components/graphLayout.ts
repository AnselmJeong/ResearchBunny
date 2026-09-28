import type { Core, ElementDefinition, EventObject } from "cytoscape";

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
    instance
      .layout({
        name: "cose",
        animate: false,
        randomize: true,
        nodeDimensionsIncludeLabels: true,
        nodeRepulsion: () => 18000,
        idealEdgeLength: () => 130,
        componentSpacing: 90,
        numIter: 600,
        padding: 50,
      })
      .run();
  }
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
