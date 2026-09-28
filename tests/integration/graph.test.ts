import { citationWarnings, resultWindow } from "../../src/shared/graph";
import { restoreNavigation } from "../../src/shared/navigation";
import { test, expect } from "bun:test";
import cytoscape from "cytoscape";
import { archiveNodeColor, TOPIC_COLORS, UNCLASSIFIED_COLOR } from "../../src/shared/classification";
import { defaultState } from "../../src/shared/types";
import {
  individualNodeDragging,
  capturePositions,
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

test("topic colors distinguish classified, unclassified and unsaved works without changing node positions", () => {
  const topics = [{ id: "t", name: "Topic", description: "", color: TOPIC_COLORS[0], count: 1 }];
  const saved = { state: { ...defaultState(), screening: "included" as const }, archiveTopicId: "t" };
  expect(archiveNodeColor(saved, topics)).toBe(TOPIC_COLORS[0]);
  expect(archiveNodeColor({ ...saved, archiveTopicId: undefined }, topics)).toBe(UNCLASSIFIED_COLOR);
  expect(archiveNodeColor({ ...saved, state: defaultState() }, topics)).toBeNull();
  const cy = cytoscape({ headless: true, styleEnabled: true, style: [
    { selector: "node", style: { "background-color": "#111111" } },
    { selector: "node.seed", style: { shape: "diamond" } },
    { selector: "node.topic-colored", style: { "background-color": "data(topicColor)" } },
  ] });
  try {
    reconcileGraph(cy, [{ data: { id: "a", topicColor: TOPIC_COLORS[0] }, classes: "saved seed topic-colored" }]);
    const node = cy.getElementById("a").position({ x: 44, y: 55 }).select();
    expect(node.style("background-color")).toBe("rgb(78,145,208)");
    expect(node.style("shape")).toBe("diamond");
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
  expect(resultWindow(true, 50, 100)).toEqual({ limit: 500, offset: 0 });
  expect(resultWindow(false, 50, 100)).toEqual({ limit: 50, offset: 100 });
});
