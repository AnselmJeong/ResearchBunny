import { citationWarnings, citationNodeDiameter, graphNodeIds, incomingCitationCounts, resultWindow, GRAPH_LIMIT } from "../../src/shared/graph";
import { restoreNavigation } from "../../src/shared/navigation";
import { test, expect } from "bun:test";
import cytoscape from "cytoscape";
import { archiveNodeColor, subfolderColors, TOPIC_COLORS, UNCLASSIFIED_COLOR } from "../../src/shared/classification";
import { defaultState } from "../../src/shared/types";
import {
  individualNodeDragging,
  capturePositions,
  forceLayout,
  placeGraph,
  reconcileGraph,
} from "../../src/renderer/components/graphLayout";

const works = [
  { id: "a", year: 2020 },
  { id: "b", year: 2021 },
  { id: "c", year: 2020 },
];
const definitions = works.map(({ id }) => ({
  data: { id, label: id },
  classes: "saved",
}));

test("node sizes count incoming citations from distinct visible papers", () => {
  const counts = incomingCitationCounts(["hub", "a", "b", "isolated"], [
    { source: "a", target: "hub" },
    { source: "b", target: "hub" },
    { source: "a", target: "hub" },
    { source: "hub", target: "a" },
    { source: "hub", target: "hub" },
    { source: "hidden", target: "hub" },
    { source: "hub", target: "hidden" },
  ]);
  expect(Object.fromEntries(counts)).toEqual({ hub: 2, a: 1, b: 0, isolated: 0 });
  expect(citationNodeDiameter(counts.get("hub")!, 2)).toBeGreaterThan(citationNodeDiameter(counts.get("a")!, 2));
});

test("log scaling keeps empty and sparse graphs usable and compresses citation outliers", () => {
  expect(citationNodeDiameter(0, 0)).toBe(24);
  expect(citationNodeDiameter(1, 1)).toBeLessThan(40);
  const diameters = [0, 1, 10, 100, 10000].map((count) => citationNodeDiameter(count, 10000));
  expect(diameters[4]).toBe(64);
  for (let i = 1; i < diameters.length; i++) {
    expect(diameters[i]).toBeGreaterThan(diameters[i - 1]);
    expect(diameters[i]).toBeLessThanOrEqual(64);
  }
  expect(citationNodeDiameter(10, 10000) - diameters[0]).toBeGreaterThan((64 - 24) * 10 / 10000);
  for (const count of [null, -1, NaN, Infinity]) {
    expect(citationNodeDiameter(count as number, 0)).toBe(24);
  }
});

test("seed and saved circles resize on refresh while retaining selection and position", () => {
  const cy = cytoscape({ headless: true, styleEnabled: true, style: [
    { selector: "node", style: { shape: "ellipse", width: "data(diameter)", height: "data(diameter)" } },
  ] });
  try {
    const definitions = [
      { data: { id: "seed", diameter: citationNodeDiameter(0, 20) }, classes: "saved seed" },
      { data: { id: "saved", diameter: citationNodeDiameter(20, 20) }, classes: "saved" },
    ];
    reconcileGraph(cy, definitions);
    const node = cy.getElementById("seed").position({ x: 44, y: 55 }).select();
    expect(node.width()).toBe(24);
    expect(cy.getElementById("saved").width()).toBe(64);
    reconcileGraph(cy, [
      { ...definitions[0], data: { id: "seed", diameter: citationNodeDiameter(20, 20) } },
      definitions[1],
    ]);
    expect(node.width()).toBe(64);
    expect(node.height()).toBe(64);
    expect(node.style("shape")).toBe("ellipse");
    expect(cy.getElementById("saved").style("shape")).toBe("ellipse");
    expect(node.position()).toEqual({ x: 44, y: 55 });
    expect(node.selected()).toBe(true);
  } finally { cy.destroy(); }
});

test("topic colors distinguish classified, unclassified and unsaved works without changing node positions", () => {
  const topics = [{ id: "t", name: "Topic", description: "", color: TOPIC_COLORS[0], count: 1 }];
  const saved = { state: { ...defaultState(), screening: "included" as const }, archiveTopicId: "t" };
  expect(archiveNodeColor(saved, topics)).toBe(TOPIC_COLORS[0]);
  expect(archiveNodeColor({ ...saved, archiveTopicId: undefined }, topics)).toBe(UNCLASSIFIED_COLOR);
  expect(archiveNodeColor({ ...saved, state: defaultState() }, topics)).toBeNull();
  const cy = cytoscape({ headless: true, styleEnabled: true, style: [
    { selector: "node", style: { shape: "ellipse", "background-color": "#111111" } },
    { selector: "node.topic-colored", style: { "background-color": "data(topicColor)" } },
  ] });
  try {
    reconcileGraph(cy, [{ data: { id: "a", topicColor: TOPIC_COLORS[0] }, classes: "saved seed topic-colored" }]);
    const node = cy.getElementById("a").position({ x: 44, y: 55 }).select();
    expect(node.style("background-color")).toBe("rgb(78,145,208)");
    expect(node.style("shape")).toBe("ellipse");
    reconcileGraph(cy, [{ data: { id: "a", topicColor: TOPIC_COLORS[1] }, classes: "saved seed topic-colored" }]);
    expect(node.style("background-color")).toBe("rgb(225,147,66)");
    expect(node.position()).toEqual({ x: 44, y: 55 });
    expect(node.selected()).toBe(true);
    reconcileGraph(cy, [{ data: { id: "a", topicColor: TOPIC_COLORS[1] }, classes: "saved seed" }]);
    expect(node.hasClass("topic-colored")).toBe(false);
    expect(node.style("background-color")).toBe("rgb(17,17,17)");
  } finally { cy.destroy(); }
});

test("graph refresh retains node identity, selection and dragged positions", () => {
  const cy = cytoscape({ headless: true });
  try {
    reconcileGraph(cy, definitions);
    const node = cy.getElementById("a");
    node.select().position({ x: 230, y: 140 });
    reconcileGraph(cy, [
      ...definitions,
      { data: { id: "ab", source: "a", target: "b" }, classes: "similarity" },
    ]);
    expect(cy.getElementById("a")[0]).toBe(node[0]);
    expect(node.selected()).toBe(true);
    expect(node.position()).toEqual({ x: 230, y: 140 });
    expect(node.grabbable()).toBe(true);
    reconcileGraph(cy, definitions);
    expect(cy.edges().length).toBe(0);
    expect(cy.getElementById("a")[0]).toBe(node[0]);
  } finally {
    cy.destroy();
  }
});

test("timeline round trip restores network coordinates, including a prior drag", () => {
  const cy = cytoscape({ headless: true });
  try {
    reconcileGraph(cy, definitions);
    const saved = {
      a: { x: 20, y: 320 },
      b: { x: 260, y: 30 },
      c: { x: 420, y: 280 },
    };
    placeGraph(cy, works, false, null, saved);
    cy.getElementById("b").position({ x: 350, y: 60 });
    const dragged = capturePositions(cy);
    placeGraph(cy, works, true, false, dragged);
    expect(cy.getElementById("a").position().x).toBe(
      cy.getElementById("c").position().x,
    );
    expect(capturePositions(cy)).not.toEqual(dragged);
    placeGraph(cy, works, false, true, dragged);
    expect(capturePositions(cy)).toEqual(dragged);
    // Entering timeline first must compute a network instead of reusing its rows.
    placeGraph(cy, works, true, null, {});
    const timeline = capturePositions(cy);
    placeGraph(cy, works, false, true, {});
    expect(capturePositions(cy)).not.toEqual(timeline);
  } finally {
    cy.destroy();
  }
});

test("legacy timeline positions are discarded without losing selection or filters", () => {
  const legacy = {
    scope: "archive",
    view: "graph",
    selected: ["a", "b"],
    positions: { a: { x: 50, y: 80 }, b: { x: 190, y: 80 } },
    localQuery: "lithium",
  };
  const history = restoreNavigation({
    navigation: { keys: ["archive:"], index: 0, views: { "archive:": legacy } },
  });
  const view = history.views["archive:"];
  expect(view.networkPositions).toEqual({});
  expect(view.selected).toEqual(["a", "b"]);
  expect(view.localQuery).toBe("lithium");
  expect(restoreNavigation(legacy).views["archive:"].networkPositions).toEqual(
    {},
  );
  const saved = { ...view, networkPositions: { a: { x: 85, y: 220 } } };
  expect(restoreNavigation(saved).views["archive:"].networkPositions).toEqual(
    saved.networkPositions,
  );
});

test("dragging one of several selected papers moves only that node and releases all temporary locks", () => {
  const cy = cytoscape({ headless: true });
  const cleanup = individualNodeDragging(cy);
  try {
    reconcileGraph(cy, definitions);
    cy.nodes().select();
    const before = capturePositions(cy);
    const node = cy.getElementById("a");
    node.emit("grabon");
    cy.nodes(":selected").shift({ x: 80, y: 60 });
    node.emit("freeon");
    expect(node.position()).toEqual({ x: before.a.x + 80, y: before.a.y + 60 });
    expect(cy.getElementById("b").position()).toEqual(before.b);
    expect(cy.getElementById("c").position()).toEqual(before.c);
    expect(cy.nodes(":selected").length).toBe(3);
    expect(cy.nodes(":locked").length).toBe(0);
    // A previously stationary node can be dragged next.
    cy.getElementById("b").emit("grabon");
    cy.nodes(":selected").shift({ x: 30, y: 20 });
    cy.getElementById("b").emit("freeon");
    expect(cy.getElementById("b").position()).toEqual({
      x: before.b.x + 30,
      y: before.b.y + 20,
    });
    expect(cy.nodes(":locked").length).toBe(0);
  } finally {
    cleanup();
    cy.destroy();
  }
});

test("citation warnings isolate future citations without changing the source records", () => {
  const papers = [
    { id: "old", year: 2018 },
    { id: "new", year: 2020 },
    { id: "same", year: 2020 },
    { id: "unknown", year: null },
  ];
  const edges = [
    { source: "old", target: "new" },
    { source: "new", target: "old" },
    { source: "new", target: "same" },
    { source: "same", target: "new" },
    { source: "unknown", target: "old" },
  ];
  const original = JSON.stringify(edges);
  const flagged = citationWarnings(papers, edges);
  expect(flagged.has("old:new")).toBe(true);
  expect(flagged.has("new:old")).toBe(false);
  expect(flagged.has("new:same")).toBe(true);
  expect(flagged.has("same:new")).toBe(true);
  expect(flagged.has("unknown:old")).toBe(false);
  expect(JSON.stringify(edges)).toBe(original);
});

test("graph query ignores list pagination while list window is preserved", () => {
  expect(resultWindow(true, 50, 100)).toEqual({ graph: true, limit: 50, offset: 0 });
  expect(resultWindow(false, 50, 100)).toEqual({ graph: false, limit: 50, offset: 100 });
});

test("graph nodes skip singletons and keep papers linked only to a starting paper", () => {
  const edges = [
    { source: "a", target: "b" },
    { source: "b", target: "a" },
    { source: "c", target: "seed" },
    { source: "d", target: "d" },
    { source: "e", target: "outside" },
  ];
  expect(graphNodeIds(["e", "d", "c", "b", "a"], ["seed"], edges)).toEqual({ ids: ["c", "b", "a"], connected: 3 });
  expect(graphNodeIds(["a", "b"], [], [])).toEqual({ ids: [], connected: 0 });
  expect(GRAPH_LIMIT).toBe(1000);
});

test("past the node limit the best-connected papers win without leaving new singletons", () => {
  // hub links h1..h4; x-y is a separate pair; z only links to y.
  const edges = [
    ...["h1", "h2", "h3", "h4"].map((id) => ({ source: id, target: "hub" })),
    { source: "x", target: "y" },
    { source: "z", target: "y" },
  ];
  const ids = ["x", "h1", "h2", "z", "hub", "h3", "y", "h4"];
  // hub (4) and y (2) rank first; degree-1 ties then follow the scope order, which the result keeps.
  expect(graphNodeIds(ids, [], edges, 6)).toEqual({ ids: ["x", "h1", "h2", "z", "hub", "y"], connected: 8 });
  // With room for three, every neighbour of hub falls past the cut, so hub would be drawn alone.
  expect(graphNodeIds(ids, [], edges, 3).ids).toEqual(["x", "y"]);
});

test("subfolder colours go to the largest drawn folders and the rest stay neutral", () => {
  const folders = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`w${i}`, `Root/F${String(i).padStart(2, "0")}`]));
  Object.assign(folders, { extra: "Root/F11" });
  const palette = subfolderColors([...Object.keys(folders), "loose"], folders);
  expect(palette.groups.length).toBe(TOPIC_COLORS.length);
  expect(palette.groups[0]).toEqual({ path: "Root/F11", name: "F11", color: TOPIC_COLORS[0] });
  expect(palette.groups[1].path).toBe("Root/F00");
  expect(palette.others).toBe(2);
  expect(palette.loose).toBe(true);
  expect(palette.color("extra")).toBe(TOPIC_COLORS[0]);
  expect(palette.color("w10")).toBe(UNCLASSIFIED_COLOR);
  expect(palette.color("loose")).toBe(UNCLASSIFIED_COLOR);
  expect(subfolderColors(["a"], {}).groups).toEqual([]);
});

test("force layout spreads a thousand linked papers quickly and reproducibly", () => {
  const elements = [
    ...Array.from({ length: 1000 }, (_, i) => ({ data: { id: `n${i}`, diameter: 24 + (i % 5) * 8 } })),
    ...Array.from({ length: 1500 }, (_, i) => ({ data: { id: `e${i}`, source: `n${(i * 7) % 1000}`, target: `n${(i * 13 + 1) % 1000}` } })),
  ].filter((element) => !("source" in element.data) || element.data.source !== element.data.target);
  const run = () => {
    const cy = cytoscape({ headless: true, styleEnabled: true, elements, style: [
      { selector: "node", style: { width: "data(diameter)", height: "data(diameter)" } },
    ] });
    try {
      const started = performance.now();
      forceLayout(cy);
      return { positions: capturePositions(cy), elapsed: performance.now() - started };
    } finally { cy.destroy(); }
  };
  const first = run(), second = run();
  expect(second.positions).toEqual(first.positions);
  expect(first.elapsed).toBeLessThan(5000);
  const points = Object.values(first.positions);
  expect(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  let overlapping = 0;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      if (Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) < 24) overlapping++;
  expect(overlapping).toBe(0);
});
