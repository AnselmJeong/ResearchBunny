import { useEffect, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { Focus, ZoomIn, ZoomOut, Waypoints } from "lucide-react";
import type { WorkView } from "../../shared/types";
import { similarityEdges } from "../../shared/domain";
export function Graph({
  works,
  edges,
  selected,
  seeds,
  inspectId,
  onInspect,
  onSelection,
  timeline,
  positions,
  onPositions,
}: {
  works: WorkView[];
  edges: { source: string; target: string }[];
  selected: string[];
  seeds: string[];
  inspectId: string | null;
  onInspect: (id: string) => void;
  onSelection: (ids: string[]) => void;
  timeline: boolean;
  positions: Record<string, { x: number; y: number }>;
  onPositions: (positions: Record<string, { x: number; y: number }>) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    cy = useRef<Core | null>(null),
    syncing = useRef(false);
  const callbacks = useRef({ onInspect, onSelection, onPositions, selected });
  callbacks.current = { onInspect, onSelection, onPositions, selected };
  const [neighbors, setNeighbors] = useState(false),
    [expanded, setExpanded] = useState(false),
    [label, setLabel] = useState(true),
    [similarity, setSimilarity] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    const instance = cytoscape({
      container: host.current,
      boxSelectionEnabled: true,
      selectionType: "additive",
      minZoom: 0.12,
      maxZoom: 3,
      wheelSensitivity: 0.15,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#bbc4be",
            width: 24,
            height: 24,
            label: "data(label)",
            "font-family": "-apple-system, sans-serif",
            "font-size": 10,
            color: "#55645d",
            "text-valign": "bottom",
            "text-margin-y": 8,
            "text-max-width": "115px",
            "text-wrap": "ellipsis",
            "border-color": "#ffffff",
            "border-width": 3,
          },
        },
        { selector: ".saved", style: { "background-color": "#5f9380" } },
        {
          selector: ".seed",
          style: {
            "background-color": "#28644e",
            shape: "diamond",
            width: 32,
            height: 32,
          },
        },
        {
          selector: "node:selected",
          style: {
            "background-color": "#1c7554",
            "border-color": "#1c7554",
            "border-width": 5,
            "border-opacity": 0.3,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1,
            "line-color": "#c4cdc7",
            "target-arrow-color": "#acb9b0",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            "arrow-scale": 0.7,
            opacity: 0.8,
          },
        },
        {
          selector: "edge.similarity",
          style: {
            "line-style": "dashed",
            "line-color": "#b49372",
            "target-arrow-shape": "none",
            opacity: 0.6,
          },
        },
        {
          selector: ".inspected",
          style: {
            "underlay-color": "#34775b",
            "underlay-opacity": 0.12,
            "underlay-padding": 9,
          },
        },
        { selector: ".faded", style: { opacity: 0.12 } },
      ],
    });
    cy.current = instance;
    const theme = () => {
      const css = getComputedStyle(document.documentElement);
      instance
        .style()
        .selector("node")
        .style({
          color: css.getPropertyValue("--text").trim(),
          "border-color": css.getPropertyValue("--panel").trim(),
        })
        .selector(".seed")
        .style({ "background-color": css.getPropertyValue("--accent").trim() })
        .selector("node:selected")
        .style({
          "background-color": css.getPropertyValue("--accent").trim(),
          "border-color": css.getPropertyValue("--accent").trim(),
        })
        .update();
    };
    theme();
    const themeObserver = new MutationObserver(theme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
    themeMedia.addEventListener("change", theme);
    instance.on("tap", "node", (e) =>
      callbacks.current.onInspect(e.target.id()),
    );
    const selection = () => {
      if (syncing.current) return;
      const visible = new Set(instance.nodes().map((n) => n.id()));
      const hidden = callbacks.current.selected.filter(
        (id) => !visible.has(id),
      );
      callbacks.current.onSelection([
        ...new Set([
          ...hidden,
          ...instance.$("node:selected").map((n) => n.id()),
        ]),
      ]);
    };
    instance.on("select unselect", "node", selection);
    instance.on("dragfree", "node", () => {
      const pos: Record<string, { x: number; y: number }> = {};
      instance.nodes().forEach((n) => {
        pos[n.id()] = { ...n.position() };
      });
      callbacks.current.onPositions(pos);
    });
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(host.current);
    return () => {
      themeObserver.disconnect();
      themeMedia.removeEventListener("change", theme);
      resize.disconnect();
      instance.destroy();
      cy.current = null;
    };
  }, []);
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    syncing.current = true;
    const limit = expanded ? 500 : 300;
    const display = works.slice(0, limit);
    const ids = new Set(display.map((w) => w.id));
    const degree = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
    }
    const labeled = new Set(
      [...display]
        .sort(
          (a, b) =>
            Number(seeds.includes(b.id)) - Number(seeds.includes(a.id)) ||
            (degree.get(b.id) || 0) - (degree.get(a.id) || 0) ||
            (b.citations || 0) - (a.citations || 0),
        )
        .slice(0, 8)
        .map((w) => w.id),
    );
    const paperLabel = (w: WorkView) =>
      `${w.authors[0]?.split(",")[0] || w.title.slice(0, 20)} · ${w.year || "연도 미상"}`;
    const definitions: ElementDefinition[] = display.map((w) => ({
      data: {
        id: w.id,
        label: labeled.has(w.id) ? paperLabel(w) : "",
        fullLabel: paperLabel(w),
      },
      position: positions[w.id],
      classes: [
        seeds.includes(w.id) ? "seed" : "",
        w.state.screening === "included" ? "saved" : "",
      ].join(" "),
    }));
    for (const edge of edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .slice(0, 3000))
      definitions.push({
        data: {
          id: edge.source + "-" + edge.target,
          source: edge.source,
          target: edge.target,
        },
      });
    if (similarity)
      for (const edge of similarityEdges(display).slice(0, 500)) {
        definitions.push({
          data: { id: `similarity-${edge.source}-${edge.target}`, ...edge },
          classes: "similarity",
        });
      }
    const oldIds = instance
      .nodes()
      .map((n) => n.id())
      .sort()
      .join(",");
    const newIds = display
      .map((w) => w.id)
      .sort()
      .join(",");
    const oldPositions: Record<string, { x: number; y: number }> = {};
    instance.nodes().forEach((n) => {
      oldPositions[n.id()] = { ...n.position() };
    });
    instance.batch(() => {
      instance.elements().remove();
      instance.add(definitions);
    });
    if (timeline) {
      const years = [
        ...new Set(
          display.map((w) => w.year).filter((y): y is number => y !== null),
        ),
      ].sort((a, b) => a - b);
      const lanes = new Map<string, number>();
      instance.nodes().forEach((n) => {
        const w = display.find((w) => w.id === n.id())!;
        const year = w.year === null ? "unknown" : String(w.year);
        const lane = lanes.get(year) || 0;
        lanes.set(year, lane + 1);
        n.position({
          x:
            (w.year === null ? years.length : years.indexOf(w.year)) * 140 + 50,
          y: 80 + lane * 75,
        });
      });
      instance.fit(undefined, 70);
    } else if (display.every((w) => positions[w.id] || oldPositions[w.id])) {
      instance.nodes().forEach((n) => {
        n.position(positions[n.id()] || oldPositions[n.id()]);
      });
      if (oldIds !== newIds) instance.fit(undefined, 65);
    } else {
      instance
        .layout({
          name: "cose",
          animate: false,
          randomize: false,
          nodeRepulsion: () => 24000,
          idealEdgeLength: () => 145,
          numIter: 300,
          fit: true,
          padding: 60,
        })
        .run();
      for (const n of instance.nodes())
        if (oldPositions[n.id()]) n.position(oldPositions[n.id()]);
      const pos: Record<string, { x: number; y: number }> = {};
      instance.nodes().forEach((n) => {
        pos[n.id()] = { ...n.position() };
      });
      callbacks.current.onPositions(pos);
    }
    for (const id of selected) instance.getElementById(id).select();
    syncing.current = false;
    // Selection and position updates must not recompute layout.
  }, [works, edges, seeds, timeline, expanded, similarity]);
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    syncing.current = true;
    instance.nodes().unselect();
    for (const id of selected) instance.getElementById(id).select();
    syncing.current = false;
  }, [selected]);
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    instance.elements().removeClass("faded inspected");
    if (inspectId) {
      const node = instance.getElementById(inspectId);
      node.addClass("inspected");
      if (neighbors)
        instance
          .elements()
          .difference(node.closedNeighborhood())
          .addClass("faded");
    }
  }, [inspectId, neighbors, works]);
  useEffect(() => {
    cy.current
      ?.style()
      .selector("node")
      .style("label", label ? "data(label)" : "")
      .selector("node.inspected, node:selected")
      .style("label", label ? "data(fullLabel)" : "")
      .update();
  }, [label]);
  const years = [
    ...new Set(works.slice(0, expanded ? 500 : 300).map((w) => w.year)),
  ].sort((a, b) => (a ?? 9999) - (b ?? 9999));
  return (
    <div className="graph-wrap">
      <div ref={host} className="graph-canvas" aria-label="논문 인용 그래프" />
      {timeline && (
        <div className="year-legend">
          {years.map((y) => (
            <span key={y || "unknown"}>{y || "연도 미상"}</span>
          ))}
        </div>
      )}
      <div className="graph-controls">
        <button
          title="확대"
          onClick={() => cy.current?.zoom((cy.current?.zoom() || 1) * 1.2)}
        >
          <ZoomIn size={16} />
        </button>
        <button
          title="축소"
          onClick={() => cy.current?.zoom((cy.current?.zoom() || 1) / 1.2)}
        >
          <ZoomOut size={16} />
        </button>
        <button
          title="전체 맞춤"
          onClick={() => cy.current?.fit(undefined, 60)}
        >
          <Focus size={16} />
        </button>
        <button
          className={neighbors ? "active" : ""}
          onClick={() => setNeighbors(!neighbors)}
        >
          <Waypoints size={15} />
          선택 주변
        </button>
        <label>
          <input
            type="checkbox"
            checked={label}
            onChange={(e) => setLabel(e.target.checked)}
          />
          라벨
        </label>
        <label>
          <input
            type="checkbox"
            checked={similarity}
            onChange={(e) => setSimilarity(e.target.checked)}
          />
          유사 관계
        </label>
        <label>
          <input
            type="checkbox"
            checked={expanded}
            onChange={(e) => setExpanded(e.target.checked)}
          />
          500편까지
        </label>
      </div>
      <div className="graph-legend">
        <span>◆ 초기 seed</span>
        <span className="green">● 저장</span>
        <span>● 후보</span>
        <span>인용하는 논문 → 인용된 논문</span>
        {similarity && <span>점선: OpenAlex 유사 관계 · 최대 500선</span>}
        <span>
          {Math.min(works.length, expanded ? 500 : 300)}/{works.length}편 표시 ·
          Shift+드래그로 선택
        </span>
      </div>
    </div>
  );
}
