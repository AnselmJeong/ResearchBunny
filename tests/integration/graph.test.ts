import { citationWarnings, citationNodeDiameter, graphNodeIds, graphSearch, incomingCitationCounts, pageRank, rankNodeDiameter, resultWindow, GRAPH_LIMIT } from "../../src/shared/graph";
import { labelGeometry, labelWidth, pickLabels, refreshLabels, LABEL_FONT_PX } from "../../src/renderer/components/graphLabels";
import { restoreNavigation } from "../../src/shared/navigation";
import { test, expect } from "bun:test";
import cytoscape from "cytoscape";
import { archiveNodeColor, subfolderColors, yearColor, TOPIC_COLORS, UNCLASSIFIED_COLOR, YEAR_RAMP } from "../../src/shared/classification";
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
    { selector: "node.color-mapped", style: { "background-color": "data(mappedColor)" } },
  ] });
  try {
    reconcileGraph(cy, [{ data: { id: "a", mappedColor: TOPIC_COLORS[0] }, classes: "saved seed color-mapped" }]);
    const node = cy.getElementById("a").position({ x: 44, y: 55 }).select();
    expect(node.style("background-color")).toBe("rgb(78,145,208)");
    expect(node.style("shape")).toBe("ellipse");
    reconcileGraph(cy, [{ data: { id: "a", mappedColor: TOPIC_COLORS[1] }, classes: "saved seed color-mapped" }]);
    expect(node.style("background-color")).toBe("rgb(225,147,66)");
    expect(node.position()).toEqual({ x: 44, y: 55 });
    expect(node.selected()).toBe(true);
    reconcileGraph(cy, [{ data: { id: "a", mappedColor: TOPIC_COLORS[1] }, classes: "saved seed" }]);
    expect(node.hasClass("color-mapped")).toBe(false);
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

test("graph search matches every word in any order, ignoring case and accents", () => {
  const works = [
    { id: "a", title: "Dopamine neurons and prediction error", authors: ["Ménard, Caroline"], year: 2019, venue: "Neuron", citekey: "menard2019" },
    { id: "b", title: "Prediction in the hippocampus", authors: ["Lodge, Daniel J"], year: 2011, venue: "J Neurosci" },
    { id: "c", title: "도파민과 보상 예측", authors: ["김철수"], year: 2020 },
  ];
  expect(graphSearch(works, "menard")).toEqual(["a"]);
  expect(graphSearch(works, "ERROR dopamine")).toEqual(["a"]);
  expect(graphSearch(works, "prediction")).toEqual(["a", "b"]);
  expect(graphSearch(works, "lodge 2011")).toEqual(["b"]);
  expect(graphSearch(works, "j neurosci")).toEqual(["b"]);
  expect(graphSearch(works, "보상 도파민")).toEqual(["c"]);
  expect(graphSearch(works, "lodge 2019")).toEqual([]);
  expect(graphSearch(works, "   ")).toEqual([]);
});

test("labels never overlap except forced ones, stay on screen and respect the limit", () => {
  const viewport = { width: 800, height: 600 };
  const at = (id: string, x: number, y: number, forced = false) => ({ id, x, y, radius: 12, text: `${id} · 2020`, forced });
  // b sits right under a, c is far away, d is off screen, e collides with forced f.
  const chosen = pickLabels([at("f", 400, 400, true), at("a", 100, 100), at("b", 104, 106), at("c", 600, 100), at("d", 1200, 100), at("e", 402, 402)], viewport);
  expect([...chosen].sort()).toEqual(["a", "c", "f"]);
  // A forced label shows even when it overlaps an earlier forced one.
  expect([...pickLabels([at("x", 10, 10, true), at("y", 12, 12, true)], viewport)].sort()).toEqual(["x", "y"]);
  // The limit counts optional labels only.
  const grid = Array.from({ length: 40 }, (_, i) => at(`n${i}`, 60 + (i % 5) * 150, 40 + Math.floor(i / 5) * 70));
  expect(pickLabels([at("hover", 5, 590, true), ...grid], viewport, 10).size).toBe(11);
  // Hangul takes about a full em per glyph, Latin less.
  expect(labelWidth("가나다라")).toBeGreaterThan(labelWidth("abcd"));
});

test("labels keep one on-screen size at any zoom and follow priority, toggle and fading", () => {
  const cy = cytoscape({ headless: true, styleEnabled: true, style: [
    { selector: "node", style: { width: 20, height: 20, label: "data(label)", "font-size": "data(labelSize)" } },
  ] });
  try {
    const ids = ["hub", "mid", "leaf", "far"];
    cy.add(ids.map((id, i) => ({ data: { id, label: "", fullLabel: `${id} · 2020`, ...labelGeometry(1) }, position: { x: i * 200, y: 100 } })));
    cy.add({ data: { id: "near", label: "", fullLabel: "near · 2020", ...labelGeometry(1) }, position: { x: 4, y: 104 } });
    const viewport = { width: 1000, height: 400 };
    cy.zoom(0.5);
    cy.pan({ x: 0, y: 0 });
    let chosen = refreshLabels(cy, { order: ["hub", "near", "mid", "leaf", "far"], enabled: true, viewport });
    // "near" collides with "hub", which ranks first.
    expect([...chosen].sort()).toEqual(["far", "hub", "leaf", "mid"]);
    expect(cy.$id("hub").data("label")).toBe("hub · 2020");
    expect(cy.$id("near").data("label")).toBe("");
    expect(cy.$id("hub").data("labelSize") * cy.zoom()).toBeCloseTo(LABEL_FONT_PX);
    expect(cy.$id("hub").style("font-size")).toBe(`${LABEL_FONT_PX / 0.5}px`);

    // Turning ordinary labels off keeps the forced and boosted ones, and clears the rest.
    chosen = refreshLabels(cy, { order: ids, enabled: false, forced: ["leaf"], boosted: ["near"], viewport });
    expect([...chosen].sort()).toEqual(["leaf", "near"]);
    expect(cy.$id("hub").data("label")).toBe("");

    // Faded papers lose ordinary labels but keep a forced one.
    cy.$id("mid").addClass("faded");
    cy.$id("far").addClass("hover-dim");
    chosen = refreshLabels(cy, { order: ids, enabled: true, forced: ["far"], viewport });
    expect([...chosen].sort()).toEqual(["far", "hub", "leaf"]);
  } finally {
    cy.destroy();
  }
});

test("PageRank favours papers cited by well-cited papers and keeps a total of one", () => {
  // hub is cited by a, b, c; star is cited only by hub; lone is cited by a paper nobody cites.
  const ids = ["a", "b", "c", "hub", "star", "lone", "d"];
  const ranks = pageRank(ids, [
    { source: "a", target: "hub" },
    { source: "b", target: "hub" },
    { source: "c", target: "hub" },
    { source: "hub", target: "star" },
    { source: "d", target: "lone" },
    // Ignored: a repeat, a self-citation and a link leaving the graph.
    { source: "a", target: "hub" },
    { source: "star", target: "star" },
    { source: "star", target: "elsewhere" },
  ]);
  const total = [...ranks.values()].reduce((sum, value) => sum + value, 0);
  expect(total).toBeCloseTo(1, 9);
  expect(ranks.get("hub")!).toBeGreaterThan(ranks.get("lone")!);
  // One citation from the hub outweighs one citation from an uncited paper.
  expect(ranks.get("star")!).toBeGreaterThan(ranks.get("lone")!);
  expect(ranks.get("a")).toBeCloseTo(ranks.get("d")!, 12);
  expect(pageRank([], []).size).toBe(0);
  // Without links every paper keeps an equal share.
  expect([...pageRank(["x", "y"], []).values()]).toEqual([0.5, 0.5]);
});

test("PageRank sizes start at the lowest score and stay modest in a flat graph", () => {
  expect(rankNodeDiameter(0.4, 0.4, 12)).toBe(24);
  expect(rankNodeDiameter(12, 0.4, 12)).toBe(64);
  expect(rankNodeDiameter(3, 0.4, 12)).toBeGreaterThan(rankNodeDiameter(1, 0.4, 12));
  // A spread under one average share never reaches full size.
  expect(rankNodeDiameter(1.2, 0.9, 1.2)).toBeLessThan(50);
  expect(rankNodeDiameter(NaN, 0.4, 12)).toBe(24);
});

test("year colours run along the theme's one-hue ramp and leave unknown years grey", () => {
  expect(yearColor(1990, [1990, 2020], false)).toBe(YEAR_RAMP.light[0]);
  expect(yearColor(2020, [1990, 2020], false)).toBe(YEAR_RAMP.light[YEAR_RAMP.light.length - 1]);
  expect(yearColor(2020, [1990, 2020], true)).toBe(YEAR_RAMP.dark[YEAR_RAMP.dark.length - 1]);
  expect(yearColor(2005, [1990, 2020], false)).toBe(YEAR_RAMP.light[2]);
  expect(yearColor(null, [1990, 2020], false)).toBe(UNCLASSIFIED_COLOR);
  expect(yearColor(2000, null, false)).toBe(UNCLASSIFIED_COLOR);
  // A single year takes the newest colour; years outside the range clamp.
  expect(yearColor(2000, [2000, 2000], false)).toBe(YEAR_RAMP.light[YEAR_RAMP.light.length - 1]);
  expect(yearColor(1950, [1990, 2020], false)).toBe(YEAR_RAMP.light[0]);
  // Between stops the colour is a blend, still a valid hex.
  expect(yearColor(1994, [1990, 2020], false)).toMatch(/^#[0-9a-f]{6}$/);
  expect(yearColor(1994, [1990, 2020], false)).not.toBe(YEAR_RAMP.light[0]);
});

test("laying out the timeline never rewrites the saved network positions it was given", () => {
  const cy = cytoscape({ headless: true });
  try {
    const saved = { a: { x: 5, y: 7 }, b: { x: -40, y: 12 } };
    const snapshot = JSON.parse(JSON.stringify(saved));
    reconcileGraph(cy, [
      { data: { id: "a" }, position: saved.a },
      { data: { id: "b" }, position: saved.b },
    ]);
    // A fresh graph opened in the year view moves the nodes into year lanes.
    placeGraph(cy, [{ id: "a", year: 2020 }, { id: "b", year: 2021 }], true, null, saved);
    expect(cy.$id("b").position()).toEqual({ x: 170, y: 0 });
    expect(saved).toEqual(snapshot);
    // Returning to the network view restores the untouched coordinates.
    placeGraph(cy, [{ id: "a", year: 2020 }, { id: "b", year: 2021 }], false, true, saved);
    expect(capturePositions(cy)).toEqual(snapshot);
  } finally {
    cy.destroy();
  }
});
