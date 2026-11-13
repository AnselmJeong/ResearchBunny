import { useEffect, useRef, useState, useMemo } from "react";
import cytoscape, { type Core, type ElementDefinition, type NodeSingular } from "cytoscape";
import { Focus, ZoomIn, ZoomOut, Waypoints, RotateCcw, Search, ChevronUp, ChevronDown } from "lucide-react";
import type { WorkView, ArchiveTopic } from "../../shared/types";
import { archiveNodeColor, subfolderColors, UNCLASSIFIED_COLOR } from "../../shared/classification";
import { citationWarnings, citationNodeDiameter, incomingCitationCounts, graphSearch, GRAPH_LIMIT } from "../../shared/graph";
import { similarityEdges } from "../../shared/domain";
import {
  capturePositions,
  reconcileGraph,
  placeGraph,
  individualNodeDragging,
} from "./graphLayout";
import { labelGeometry, refreshLabels } from "./graphLabels";

/** Long enough that sweeping the pointer across a dense graph does not flash every neighbourhood. */
const HOVER_DELAY_MS = 180;
/** Moving from node to node keeps the preview; leaving the nodes ends it after this grace. */
const HOVER_LEAVE_MS = 120;
const TOOLTIP_WIDTH = 300;
const TOOLTIP_GAP = 12;

const SCREENING_LABEL: Record<WorkView["state"]["screening"], string> = {
  included: "아카이브에 저장됨",
  pending: "미저장 후보",
  excluded: "제외 문헌",
  trash: "휴지통 문헌",
};

function authorLine(authors: string[]): string {
  if (!authors.length) return "저자 미상";
  // Names are stored "Surname, Given", so a comma cannot also separate them; the inspector uses " · " too.
  const shown = authors.slice(0, 3).join(" · ");
  return authors.length > 3 ? `${shown} 외 ${authors.length - 3}명` : shown;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Hover = { id: string; x: number; y: number; radius: number };

/** The hovered paper's title and facts, beside the node and inside the canvas. */
function GraphTooltip({ work, hover, area, status, place, inGraph }: {
  work: WorkView;
  hover: Hover;
  area: { width: number; height: number };
  status: string;
  place: string | null;
  inGraph: number;
}) {
  const right = hover.x + hover.radius + TOOLTIP_GAP;
  // Flip to the left of the node only when the right side is short and the left side has room.
  const flip = right + TOOLTIP_WIDTH > area.width && hover.x - hover.radius - TOOLTIP_GAP - TOOLTIP_WIDTH >= 0;
  const left = flip ? hover.x - hover.radius - TOOLTIP_GAP : right;
  const top = Math.max(8, Math.min(hover.y - 18, area.height - 150));
  return (
    <div className={`graph-tooltip${flip ? " flip" : ""}`} style={{ left, top }} role="tooltip">
      <strong>{work.title}</strong>
      <span>{authorLine(work.authors)}</span>
      <span>{work.year ?? "연도 미상"}{work.venue ? ` · ${work.venue}` : ""}</span>
      <span>
        {work.citations === null ? "피인용 정보 없음" : `피인용 ${work.citations.toLocaleString()}회`}
        {` · 이 그래프 안 ${inGraph.toLocaleString()}회`}
      </span>
      {place && <span>{place}</span>}
      <span className="graph-tooltip-status">{status}</span>
    </div>
  );
}

export function Graph({
  works,
  topics,
  subfolders,
  resultTotal,
  connected,
  contextIds,
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
  topics: ArchiveTopic[];
  subfolders?: Record<string, string>;
  resultTotal: number;
  /** Papers in scope linked to another paper, before the node limit. */
  connected?: number;
  contextIds: string[];
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
  const callbacks = useRef({
    onInspect,
    onSelection,
    onPositions,
    selected,
    timeline,
    positions,
  });
  callbacks.current = {
    onInspect,
    onSelection,
    onPositions,
    selected,
    timeline,
    positions,
  };
  const previousTimeline = useRef<boolean | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const appliedRevision = useRef(0);
  const [neighbors, setNeighbors] = useState(false),
    [showQuestionable, setShowQuestionable] = useState(false),
    [label, setLabel] = useState(true),
    [similarity, setSimilarity] = useState(true);
  const [topicColors, setTopicColors] = useState(true);
  const [hover, setHover] = useState<Hover | null>(null);
  const hoverId = useRef<string | null>(null);
  const [query, setQuery] = useState(""),
    [cursor, setCursor] = useState(-1);
  /** Cytoscape-side handlers the React effects call; set while the instance lives. */
  const graphApi = useRef<{ drawLabels: () => void; scheduleLabels: () => void; endHover: () => void } | null>(null);
  const visibleEdges = useMemo(() => {
    const ids = new Set(works.map((work) => work.id));
    return edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  }, [works, edges]);
  const warnings = useMemo(
    () => citationWarnings(works, visibleEdges),
    [works, visibleEdges],
  );
  const citationLinks = useMemo(
    () => visibleEdges
      .filter((edge) => showQuestionable || !warnings.has(`${edge.source}:${edge.target}`))
      .slice(0, 3000),
    [visibleEdges, warnings, showQuestionable],
  );
  const relatedLinks = useMemo(
    () => similarity ? similarityEdges(works).slice(0, 1000) : [],
    [works, similarity],
  );
  // Singletons say nothing in a citation graph; this also drops papers whose links are switched off or capped.
  const display = useMemo(() => {
    const linked = new Set([...citationLinks, ...relatedLinks].flatMap((edge) => [edge.source, edge.target]));
    return works.filter((work) => linked.has(work.id) || contextIds.includes(work.id));
  }, [works, citationLinks, relatedLinks, contextIds]);
  const folderPalette = useMemo(
    () => subfolders ? subfolderColors(display.map((work) => work.id), subfolders) : null,
    [display, subfolders],
  );
  const byFolder = !!folderPalette?.groups.length;
  const colorByTopic = topicColors && (byFolder || topics.length > 0);
  const incomingCitations = useMemo(
    () => incomingCitationCounts(
      display.map((work) => work.id),
      visibleEdges.filter((edge) => !warnings.has(`${edge.source}:${edge.target}`)),
    ),
    [display, visibleEdges, warnings],
  );
  const maximumCitations = Math.max(0, ...incomingCitations.values());
  // Label priority: seeds, then the papers with the most drawn links, then the most cited.
  const labelOrder = useMemo(() => {
    const degree = new Map<string, number>();
    for (const edge of [...citationLinks, ...relatedLinks]) {
      degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
    }
    const seedIds = new Set(seeds);
    return [...display]
      .sort(
        (a, b) =>
          Number(seedIds.has(b.id)) - Number(seedIds.has(a.id)) ||
          (degree.get(b.id) || 0) - (degree.get(a.id) || 0) ||
          (b.citations || 0) - (a.citations || 0),
      )
      .map((work) => work.id);
  }, [display, citationLinks, relatedLinks, seeds]);
  // Matches keep the label order, so Enter visits the best-connected match first.
  const matches = useMemo(() => {
    const hits = new Set(graphSearch(display, query));
    return labelOrder.filter((id) => hits.has(id));
  }, [display, query, labelOrder]);
  const labelInputs = useRef({ order: labelOrder, enabled: label, matches, current: null as string | null, selected, inspectId });
  labelInputs.current = {
    order: labelOrder,
    enabled: label,
    matches,
    current: cursor >= 0 ? matches[cursor] ?? null : null,
    selected,
    inspectId,
  };
  const workById = new Map(display.map((work) => [work.id, work]));
  const extraCount = display.filter((work) =>
    contextIds.includes(work.id),
  ).length;
  const resultCount = display.length - extraCount;
  const isolatedCount = connected === undefined ? 0 : resultTotal - connected;
  const visibleTopics = topics.filter(topic => display.some(work => work.state.screening === "included" && work.archiveTopicId === topic.id));
  const hasUnclassified = display.some(work => archiveNodeColor(work, topics) === UNCLASSIFIED_COLOR);
  useEffect(() => {
    if (!host.current) return;
    const instance = cytoscape({
      container: host.current,
      boxSelectionEnabled: true,
      selectionType: "additive",
      autoungrabify: false,
      autolock: false,
      minZoom: 0.12,
      maxZoom: 3,
      wheelSensitivity: 0.15,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#bbc4be",
            shape: "ellipse",
            width: "data(diameter)",
            height: "data(diameter)",
            label: "data(label)",
            "font-family": "-apple-system, sans-serif",
            // Geometry comes from data so labels keep one on-screen size at every zoom.
            "font-size": "data(labelSize)",
            "text-background-opacity": 0.92,
            "text-background-padding": "data(labelPad)",
            "text-background-shape": "roundrectangle",
            color: "#55645d",
            "text-valign": "bottom",
            // The typings allow only numbers here, but Cytoscape maps data like any other property.
            "text-margin-y": "data(labelMargin)" as unknown as number,
            "text-max-width": "data(labelWidth)",
            "text-wrap": "ellipsis",
            "border-color": "#ffffff",
            "border-width": 3,
          },
        },
        {
          selector: ".saved",
          style: { "background-color": "#5f9380" },
        },
        {
          selector: ".seed",
          style: {
            "background-color": "#28644e",
          },
        },
        {
          selector: "node:selected",
          style: {
            "border-color": "#1c7554",
            "border-width": 5,
            "border-opacity": 1,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.6,
            "line-color": "#c4cdc7",
            "target-arrow-color": "#acb9b0",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            "arrow-scale": 1,
            opacity: 0.8,
          },
        },
        {
          selector: "edge.similarity",
          style: {
            "line-style": "dashed",
            "line-dash-pattern": [8, 6],
            width: 2.2,
            "curve-style": "unbundled-bezier",
            "control-point-distances": [35],
            "control-point-weights": [0.5],
            "line-color": "#b49372",
            "target-arrow-shape": "none",
            opacity: 0.85,
          },
        },
        {
          selector: "node.found",
          style: {
            "underlay-color": "#d6a121",
            "underlay-opacity": 0.28,
            "underlay-padding": 7,
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
        {
          selector: "node.inspected.found",
          style: {
            "underlay-color": "#d6a121",
            "underlay-opacity": 0.45,
            "underlay-padding": 10,
          },
        },
        {
          selector: "node.inspected, node.hovered, node.found",
          style: { "z-index": 10 },
        },
        {
          selector: "edge.questionable",
          style: {
            "line-style": "dotted",
            "line-color": "#cb7666",
            "target-arrow-color": "#cb7666",
            "target-arrow-fill": "hollow",
            width: 2.5,
            opacity: 0.95,
          },
        },
        { selector: ".faded", style: { opacity: 0.12 } },
        // A hover preview dims everything outside the hovered paper's neighbourhood, and relights faded neighbours.
        { selector: ".hover-dim", style: { opacity: 0.12 } },
        { selector: ".hover-lit.faded", style: { opacity: 1 } },
      ],
    });
    cy.current = instance;
    const stopIndividualDragging = individualNodeDragging(instance);
    const theme = () => {
      const css = getComputedStyle(document.documentElement);
      const token = (name: string) => css.getPropertyValue(name).trim();
      instance
        .style()
        .selector("node")
        .style({
          color: token("--text"),
          "background-color": token("--graph-candidate"),
          "text-background-color": token("--panel"),
          "border-color": css.getPropertyValue("--panel").trim(),
        })
        .selector("node.saved")
        .style({ "background-color": token("--graph-saved") })
        .selector("node.seed")
        .style({ "background-color": token("--graph-seed") })
        .selector("node.topic-colored")
        .style({ "background-color": "data(topicColor)" })
        .selector("node:selected")
        .style({
          "border-color": token("--text"),
        })
        .selector("node.found, node.inspected.found")
        .style({ "underlay-color": token("--graph-found") })
        .selector("edge")
        .style({
          "line-color": token("--graph-citation"),
          "target-arrow-color": token("--graph-citation"),
        })
        .selector("edge.similarity")
        .style({ "line-color": token("--graph-related") })
        .selector("edge.questionable")
        .style({
          "line-color": token("--danger"),
          "target-arrow-color": token("--danger"),
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
    let frame = 0,
      hoverTimer = 0,
      leaveTimer = 0,
      dragging = false;
    const drawLabels = () => {
      const inputs = labelInputs.current;
      const hovered = hoverId.current;
      const hoveredNode = hovered ? instance.getElementById(hovered) : null;
      if (hoveredNode?.empty()) {
        endHover();
        return;
      }
      const rank = new Map(inputs.order.map((id, index) => [id, index]));
      const byRank = (a: string, b: string) => (rank.get(a) ?? rank.size) - (rank.get(b) ?? rank.size);
      const chosen = new Set(inputs.selected);
      refreshLabels(instance, {
        order: inputs.order,
        forced: [inputs.inspectId, hovered].filter((id): id is string => !!id),
        boosted: [
          ...(hoveredNode ? hoveredNode.neighborhood("node").map((node) => node.id()).sort(byRank) : []),
          ...(inputs.current ? [inputs.current] : []),
          ...inputs.matches,
          ...inputs.order.filter((id) => chosen.has(id)),
        ],
        enabled: inputs.enabled,
      });
      if (hoveredNode && hovered) {
        const { x, y } = hoveredNode.renderedPosition();
        const radius = hoveredNode.renderedWidth() / 2;
        setHover((current) =>
          current?.id === hovered && current.x === x && current.y === y && current.radius === radius
            ? current
            : { id: hovered, x, y, radius },
        );
      }
    };
    const scheduleLabels = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        drawLabels();
      });
    };
    const startHover = (node: NodeSingular) => {
      if (node.removed()) return;
      hoverId.current = node.id();
      const lit = node.closedNeighborhood();
      instance.batch(() => {
        instance.elements(".hover-dim, .hover-lit").removeClass("hover-dim hover-lit");
        instance.elements().difference(lit).addClass("hover-dim");
        lit.addClass("hover-lit");
      });
      drawLabels();
    };
    const endHover = () => {
      window.clearTimeout(hoverTimer);
      window.clearTimeout(leaveTimer);
      if (!hoverId.current) return;
      hoverId.current = null;
      instance.batch(() => instance.elements(".hover-dim, .hover-lit").removeClass("hover-dim hover-lit"));
      setHover(null);
      scheduleLabels();
    };
    graphApi.current = { drawLabels, scheduleLabels, endHover };
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
    instance.on("mouseover", "node", (event) => {
      const node = event.target as NodeSingular;
      node.addClass("hovered");
      if (dragging) return;
      window.clearTimeout(hoverTimer);
      window.clearTimeout(leaveTimer);
      // An active preview follows the pointer from node to node without waiting again.
      if (hoverId.current) startHover(node);
      else hoverTimer = window.setTimeout(() => startHover(node), HOVER_DELAY_MS);
    });
    instance.on("mouseout", "node", (event) => {
      event.target.removeClass("hovered");
      window.clearTimeout(hoverTimer);
      window.clearTimeout(leaveTimer);
      leaveTimer = window.setTimeout(endHover, HOVER_LEAVE_MS);
    });
    // Dragging a node or a selection box is no time for a preview.
    const pause = () => {
      dragging = true;
      endHover();
    };
    const resume = () => {
      dragging = false;
    };
    instance.on("grabon", "node", pause);
    instance.on("freeon", "node", resume);
    instance.on("boxstart", pause);
    instance.on("boxend", resume);
    instance.on("viewport", scheduleLabels);
    instance.on("dragfreeon", "node", () => {
      if (!callbacks.current.timeline)
        callbacks.current.onPositions({ ...callbacks.current.positions, ...capturePositions(instance) });
      scheduleLabels();
    });
    const resize = new ResizeObserver(() => {
      instance.resize();
      scheduleLabels();
    });
    resize.observe(host.current);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(hoverTimer);
      window.clearTimeout(leaveTimer);
      graphApi.current = null;
      themeObserver.disconnect();
      themeMedia.removeEventListener("change", theme);
      resize.disconnect();
      stopIndividualDragging();
      instance.destroy();
      cy.current = null;
    };
  }, []);
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    syncing.current = true;
    // A rebuilt graph ends any hover preview; the next pointer move starts a fresh one.
    graphApi.current?.endHover();

    const paperLabel = (w: WorkView) =>
      `${w.authors[0]?.split(",")[0] || w.title.slice(0, 20)} · ${w.year || "연도 미상"}`;
    const geometry = labelGeometry(instance.zoom());
    const definitions: ElementDefinition[] = display.map((w) => ({
      data: {
        id: w.id,
        // Which nodes get a visible label is decided per viewport by refreshLabels.
        label: "",
        fullLabel: paperLabel(w),
        ...geometry,
        diameter: citationNodeDiameter(incomingCitations.get(w.id) ?? 0, maximumCitations),
        topicColor: byFolder ? folderPalette!.color(w.id) : archiveNodeColor(w, topics) || UNCLASSIFIED_COLOR,
      },
      position: positions[w.id],
      classes: [
        seeds.includes(w.id) ? "seed" : "",
        w.state.screening === "included" ? "saved" : "",
        colorByTopic && (byFolder || w.state.screening === "included") ? "topic-colored" : "",
      ].join(" "),
    }));
    for (const edge of citationLinks)
      definitions.push({
        data: {
          id: edge.source + "-" + edge.target,
          source: edge.source,
          target: edge.target,
        },
        classes: warnings.has(`${edge.source}:${edge.target}`)
          ? "questionable"
          : "",
      });
    for (const edge of relatedLinks)
      definitions.push({
        data: { id: `similarity-${edge.source}-${edge.target}`, ...edge },
        classes: "similarity",
      });
    const oldIds = instance
      .nodes()
      .map((node) => node.id())
      .sort()
      .join(",");
    const newIds = display
      .map((work) => work.id)
      .sort()
      .join(",");
    const modeChanged = previousTimeline.current !== timeline;
    const reset = appliedRevision.current !== layoutRevision;
    reconcileGraph(instance, definitions);
    if (modeChanged || oldIds !== newIds || reset) {
      placeGraph(
        instance,
        display,
        timeline,
        previousTimeline.current,
        callbacks.current.positions,
        reset,
      );
      // Keep coordinates of papers a toggle hid, so showing them again needs no new layout.
      if (!timeline)
        callbacks.current.onPositions({ ...callbacks.current.positions, ...capturePositions(instance) });
      previousTimeline.current = timeline;
      appliedRevision.current = layoutRevision;
    }
    for (const id of selected) instance.getElementById(id).select();
    syncing.current = false;
    // Labels in the same task as the rebuild, so no frame shows the graph unlabelled.
    graphApi.current?.drawLabels();
    // Selection and position updates must not recompute layout.
  }, [
    display,
    citationLinks,
    relatedLinks,
    warnings,
    incomingCitations,
    maximumCitations,
    seeds,
    timeline,
    layoutRevision,
    topics,
    colorByTopic,
    byFolder,
    folderPalette,
  ]);
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
  }, [inspectId, neighbors, works, similarity, showQuestionable]);
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    instance.batch(() => {
      instance.nodes(".found").removeClass("found");
      for (const id of matches) instance.getElementById(id).addClass("found");
    });
  }, [matches]);
  useEffect(() => {
    graphApi.current?.scheduleLabels();
  }, [labelOrder, label, matches, cursor, selected, inspectId, neighbors, works, similarity, showQuestionable]);
  const goTo = (step: 1 | -1) => {
    const instance = cy.current;
    if (!instance || !matches.length) return;
    const next = cursor < 0
      ? (step > 0 ? 0 : matches.length - 1)
      : (cursor + step + matches.length) % matches.length;
    setCursor(next);
    const { x, y } = instance.getElementById(matches[next]).position();
    const zoom = Math.max(instance.zoom(), 1);
    instance.stop();
    // Pan to the node's own centre: centring its bounding box would count the label below it.
    instance.animate(
      { zoom, pan: { x: instance.width() / 2 - zoom * x, y: instance.height() / 2 - zoom * y } },
      { duration: reducedMotion() ? 0 : 300 },
    );
    onInspect(matches[next]);
  };
  const clearQuery = () => {
    setQuery("");
    setCursor(-1);
  };
  const hovered = hover ? workById.get(hover.id) : undefined;
  const hoveredTopic = hovered?.state.screening === "included"
    ? topics.find((topic) => topic.id === hovered.archiveTopicId)?.name
    : undefined;
  const years = [...new Set(display.map((w) => w.year))].sort(
    (a, b) => (a ?? 9999) - (b ?? 9999),
  );
  return (
    <div className={`graph-wrap${colorByTopic ? " topic-mode" : ""}`}>
      <div ref={host} className="graph-canvas" aria-label="논문 인용 그래프" />
      {hover && hovered && (
        <GraphTooltip
          work={hovered}
          hover={hover}
          area={{ width: host.current?.clientWidth ?? 0, height: host.current?.clientHeight ?? 0 }}
          inGraph={incomingCitations.get(hovered.id) ?? 0}
          place={hovered.shelf ? `서고 · ${hovered.shelf.folder}` : hoveredTopic ? `소주제 · ${hoveredTopic}` : null}
          status={[
            contextIds.includes(hovered.id) ? "출발 문헌" : "",
            seeds.includes(hovered.id) ? "초기 seed" : "",
            SCREENING_LABEL[hovered.state.screening],
          ].filter(Boolean).join(" · ")}
        />
      )}
      {!display.length && (
        <div className="graph-empty" role="status">
          <strong>서로 연결된 논문이 없습니다.</strong>
          <span>현재 범위 {resultTotal.toLocaleString()}편 사이에 표시할 인용·관련 연결이 없습니다. 목록 보기에서 확인하세요.</span>
        </div>
      )}
      {timeline && (
        <div className="year-legend">
          {years.map((y) => (
            <span key={y || "unknown"}>{y || "연도 미상"}</span>
          ))}
        </div>
      )}
      <div className="graph-controls">
        <div className="graph-find" title="제목·저자·연도·학술지로 찾습니다. Enter 다음 결과, Shift+Enter 이전 결과, Esc 지우기">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="그래프에서 찾기"
            aria-label="그래프에서 논문 찾기"
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(-1);
            }}
            onKeyDown={(event) => {
              // Enter that commits a Hangul composition must not jump yet.
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                goTo(event.shiftKey ? -1 : 1);
              }
              if (event.key === "Escape") clearQuery();
            }}
          />
          {query.trim() && (
            <span className="graph-find-count" aria-live="polite">
              {!matches.length ? "없음" : cursor >= 0 ? `${cursor + 1}/${matches.length}` : `${matches.length}편`}
            </span>
          )}
          {matches.length > 0 && (
            <>
              <button title="이전 결과" aria-label="이전 결과" onClick={() => goTo(-1)}>
                <ChevronUp size={14} />
              </button>
              <button title="다음 결과" aria-label="다음 결과" onClick={() => goTo(1)}>
                <ChevronDown size={14} />
              </button>
            </>
          )}
        </div>
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
          title="배치 초기화"
          aria-label="배치 초기화"
          onClick={() => setLayoutRevision((value) => value + 1)}
        >
          <RotateCcw size={16} />
        </button>
        <button
          className={neighbors ? "active" : ""}
          onClick={() => setNeighbors(!neighbors)}
        >
          <Waypoints size={15} />
          선택 주변
        </button>
        <label title="화면에 겹치지 않게 들어가는 만큼, 연결이 많은 논문부터 이름을 붙입니다. 확대하면 더 많이 보입니다.">
          <input
            type="checkbox"
            checked={label}
            onChange={(e) => setLabel(e.target.checked)}
          />
          주요 라벨
        </label>
        <label>
          <input
            type="checkbox"
            checked={similarity}
            onChange={(e) => setSimilarity(e.target.checked)}
          />
          관련 문헌 연결
        </label>
        {(byFolder || topics.length > 0) && <label>
          <input type="checkbox" checked={topicColors} onChange={event => setTopicColors(event.target.checked)} />
          {byFolder ? "하위 폴더 색상" : "소주제 색상"}
        </label>}
        {warnings.size > 0 && (
          <label>
            <input
              type="checkbox"
              checked={showQuestionable}
              onChange={(event) => setShowQuestionable(event.target.checked)}
            />
            확인 필요 인용 {warnings.size}개 표시
          </label>
        )}
      </div>
      {warnings.size > 0 && (
        <details className="graph-warnings">
          <summary>
            확인 필요 인용 {warnings.size}개 ·{" "}
            {showQuestionable ? "붉은 점선으로 표시 중" : "기본 숨김"} · 이유
            보기
          </summary>
          <p>
            제공처의 기록을 삭제하지 않았습니다. 연도 차이는 온라인 선공개·정정
            등으로도 생길 수 있으며, 표시된 이유만으로 오류를 확정하지 않습니다.
            일반 인용선도 원문 검증을 보증하지 않습니다.
          </p>
          <ul>
            {visibleEdges
              .filter((edge) => warnings.has(`${edge.source}:${edge.target}`))
              .map((edge) => (
                <li key={`${edge.source}:${edge.target}`}>
                  <button
                    className="text-button"
                    onClick={() => onInspect(edge.source)}
                  >
                    {workById.get(edge.source)?.title} (
                    {workById.get(edge.source)?.year ?? "연도 미상"})
                  </button>
                  <span> → </span>
                  <button
                    className="text-button"
                    onClick={() => onInspect(edge.target)}
                  >
                    {workById.get(edge.target)?.title} (
                    {workById.get(edge.target)?.year ?? "연도 미상"})
                  </button>
                  <p>{warnings.get(`${edge.source}:${edge.target}`)}</p>
                </li>
              ))}
          </ul>
        </details>
      )}
      <div className="graph-legend">
        {colorByTopic && byFolder && <div className="graph-topic-legend" aria-label="하위 폴더 색상 범례">
          {folderPalette!.groups.map(group => <span key={group.path} title={group.path}>
            <i className="topic-swatch" style={{ backgroundColor: group.color }} />{group.name}
          </span>)}
          {(folderPalette!.loose || folderPalette!.others > 0) && <span title="색은 표시된 논문이 많은 하위 폴더부터 붙습니다.">
            <i className="topic-swatch" style={{ backgroundColor: UNCLASSIFIED_COLOR }} />
            {[folderPalette!.loose ? "폴더에 직접 보관" : "", folderPalette!.others ? `기타 폴더 ${folderPalette!.others}개` : ""].filter(Boolean).join(" · ")}
          </span>}
        </div>}
        {colorByTopic && !byFolder && <div className="graph-topic-legend" aria-label="소주제 색상 범례">
          {visibleTopics.map(topic => <span key={topic.id} title={topic.description}>
            <i className="topic-swatch" style={{ backgroundColor: topic.color }} />{topic.name}
          </span>)}
          {hasUnclassified && <span><i className="topic-swatch" style={{ backgroundColor: UNCLASSIFIED_COLOR }} />미분류</span>}
        </div>}
        {display.some((work) => seeds.includes(work.id)) && (
          <span>
            <i className="graph-key seed" />
            초기 seed
          </span>
        )}
        {display.some((work) => work.state.screening === "included") && (
          <span>
            <i className="graph-key saved" />
            아카이브에 저장됨
          </span>
        )}
        {display.some((work) => work.state.screening === "pending") && (
          <span>
            <i className="graph-key candidate" />
            미저장 후보
          </span>
        )}
        {display.some((work) => work.state.screening === "excluded") && (
          <span>
            <i className="graph-key candidate" />
            제외 문헌
          </span>
        )}
        {display.some((work) => work.state.screening === "trash") && (
          <span>
            <i className="graph-key candidate" />
            휴지통 문헌
          </span>
        )}
        <span>
          <i className="graph-edge-key citation" />
          인용 기록 → 인용된 문헌
        </span>
        <span title="현재 표시된 논문 사이에서 받은 인용 수를 로그 척도로 반영합니다. 관련 문헌 연결과 확인 필요 인용은 제외합니다.">
          노드 크기 · 그래프 내 피인용 수 (로그 척도)
        </span>
        {similarity && (
          <span>
            <i className="graph-edge-key related" />
            관련 문헌 · 방향 없음
          </span>
        )}
        {showQuestionable && warnings.size > 0 && (
          <span>
            <i className="graph-edge-key questionable" />
            확인 필요 인용
          </span>
        )}
        <span title="다른 논문과 인용(확인 필요 인용 제외)이나 관련 문헌으로 이어진 논문만 그립니다.">
          현재 범위 {resultTotal.toLocaleString()}편 중 {resultCount.toLocaleString()}편 표시
          {extraCount > 0 ? ` · 출발 문헌 ${extraCount}편 추가` : ""}
          {isolatedCount > 0 ? ` · 연결 없는 ${isolatedCount.toLocaleString()}편 숨김` : ""}
          {connected !== undefined && connected > GRAPH_LIMIT
            ? ` · 연결된 ${connected.toLocaleString()}편 중 연결이 많은 ${GRAPH_LIMIT.toLocaleString()}편까지, 필터로 범위를 좁히세요`
            : ""}
        </span>
        <span>노드에 올리면 제목과 이웃 표시 · 드래그한 노드만 이동 · Shift+드래그로 선택</span>
        {visibleEdges.length > 3000 && <span>인용선 최대 3,000개 표시</span>}
      </div>
    </div>
  );
}
