import { useEffect, useRef, useState, useMemo } from "react";
import cytoscape, { type Core, type ElementDefinition, type NodeSingular } from "cytoscape";
import { Focus, ZoomIn, ZoomOut, Waypoints, RotateCcw, Search, ChevronUp, ChevronDown } from "lucide-react";
import type { WorkView, ArchiveTopic, InferredLink } from "../../shared/types";
import { archiveNodeColor, subfolderColors, yearColor, TOPIC_COLORS, UNCLASSIFIED_COLOR, YEAR_RAMP } from "../../shared/classification";
import { louvain, summarizeClusters, type ClusterSummary } from "../../shared/communities";
import { citationWarnings, citationNodeDiameter, incomingCitationCounts, graphSearch, pageRank, rankNodeDiameter, GRAPH_LIMIT } from "../../shared/graph";
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
const darkTheme = () => {
  const theme = document.documentElement.dataset.theme;
  return theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
};

/** What node colour shows: shelf subfolder or archive topic, detected cluster, publication year, or library state. */
type ColorMode = "group" | "cluster" | "year" | "state";

/** How strongly each drawn link ties two papers together when finding clusters: recorded citations count most. */
const CLUSTER_WEIGHT = { citation: 1, coupling: 0.8, related: 0.6, semantic: 0.5 } as const;

function clusterHelp(cluster: ClusterSummary, titleOf: (id: string) => string | undefined): string {
  return [
    cluster.years ? `${cluster.years[0]}–${cluster.years[1]}` : "",
    cluster.topic ? `OpenAlex 주제: ${cluster.topic}` : "",
    cluster.group ? `${cluster.group.name}에 ${Math.round(cluster.group.share * 100)}%` : "",
    `대표 논문: ${cluster.top.map(titleOf).filter(Boolean).join(" / ")}`,
    "이름을 누르면 이 군집만 강조합니다. 선택은 이 군집의 논문만 선택합니다.",
  ].filter(Boolean).join("\n");
}
/** What node size shows: citations from papers on this graph, all citations (OpenAlex), or PageRank on this graph. */
type SizeMode = "inGraph" | "total" | "pagerank";

const SIZE_LEGEND: Record<SizeMode, { text: string; help: string }> = {
  inGraph: {
    text: "노드 크기 · 그래프 안 피인용 수 (로그 척도)",
    help: "현재 표시된 논문 사이에서 받은 인용 수를 로그 척도로 반영합니다. 관련 문헌 연결과 확인 필요 인용은 제외합니다.",
  },
  total: {
    text: "노드 크기 · 전체 피인용 수 (OpenAlex, 로그 척도)",
    help: "OpenAlex에 기록된 전체 피인용 수를 로그 척도로 반영합니다. 피인용 정보가 없는 논문은 가장 작게 그립니다.",
  },
  pagerank: {
    text: "노드 크기 · 그래프 안 PageRank (로그 척도)",
    help: "표시된 인용선(확인 필요 인용 제외)만으로 계산한 PageRank입니다. 많이 인용될수록, 그리고 많이 인용되는 논문에게 인용될수록 커집니다. 연구의 질을 뜻하지는 않습니다.",
  },
};

type Hover = { id: string; x: number; y: number; radius: number };

/** The hovered paper's title and facts, beside the node and inside the canvas. */
function GraphTooltip({ work, hover, area, status, place, inGraph, rank, cluster }: {
  work: WorkView;
  hover: Hover;
  area: { width: number; height: number };
  status: string;
  place: string | null;
  inGraph: number;
  /** PageRank as a multiple of the average paper's share, when size shows PageRank. */
  rank?: number;
  /** The paper's cluster name, when colour shows clusters. */
  cluster?: string;
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
      {rank !== undefined && <span>PageRank · 평균 논문의 {rank.toFixed(1)}배</span>}
      {cluster && <span>군집 · {cluster}</span>}
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
  skippedLinks,
  contextIds,
  edges,
  links,
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
  /** Kinds of inferred link the service left out because the scope is too large. */
  skippedLinks?: InferredLink["kind"][];
  contextIds: string[];
  edges: { source: string; target: string }[];
  /** Shared-reference and embedding links between drawn papers. */
  links?: InferredLink[];
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
    [similarity, setSimilarity] = useState(true),
    [coupling, setCoupling] = useState(true),
    [semantic, setSemantic] = useState(true);
  // A legend row previews its cluster on hover and keeps it on click.
  const [clusterHover, setClusterHover] = useState<number | null>(null),
    [clusterPin, setClusterPin] = useState<number | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>("group"),
    [sizeMode, setSizeMode] = useState<SizeMode>("inGraph");
  const [dark, setDark] = useState(darkTheme);
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
  const inferred = useMemo(() => {
    const ids = new Set(works.map((work) => work.id));
    const visible = (links ?? []).filter((link) => ids.has(link.source) && ids.has(link.target));
    return {
      coupling: visible.filter((link) => link.kind === "coupling"),
      semantic: visible.filter((link) => link.kind === "semantic"),
    };
  }, [works, links]);
  const couplingLinks = useMemo(
    () => coupling ? inferred.coupling.slice(0, 2000) : [],
    [inferred, coupling],
  );
  const semanticLinks = useMemo(
    () => semantic ? inferred.semantic.slice(0, 2000) : [],
    [inferred, semantic],
  );
  // Singletons say nothing in a citation graph; this also drops papers whose links are switched off or capped.
  const display = useMemo(() => {
    const linked = new Set(
      [...citationLinks, ...relatedLinks, ...couplingLinks, ...semanticLinks].flatMap((edge) => [edge.source, edge.target]),
    );
    return works.filter((work) => linked.has(work.id) || contextIds.includes(work.id));
  }, [works, citationLinks, relatedLinks, couplingLinks, semanticLinks, contextIds]);
  const folderPalette = useMemo(
    () => subfolders ? subfolderColors(display.map((work) => work.id), subfolders) : null,
    [display, subfolders],
  );
  const byFolder = !!folderPalette?.groups.length;
  const groupColors = byFolder || topics.length > 0;
  // Without folders or topics to colour by, the group choice falls back to library state.
  const colorBy: ColorMode = colorMode === "group" && !groupColors ? "state" : colorMode;
  const colorByTopic = colorBy === "group";
  const yearRange = useMemo(() => {
    const years = display.map((work) => work.year).filter((year): year is number => year !== null);
    return years.length ? [Math.min(...years), Math.max(...years)] as [number, number] : null;
  }, [display]);
  // Questionable citations are hidden by default, so they never size a node.
  const trustedEdges = useMemo(
    () => visibleEdges.filter((edge) => !warnings.has(`${edge.source}:${edge.target}`)),
    [visibleEdges, warnings],
  );
  const incomingCitations = useMemo(
    () => incomingCitationCounts(display.map((work) => work.id), trustedEdges),
    [display, trustedEdges],
  );
  /** PageRank per paper as a multiple of the average share (1 = average). */
  const ranks = useMemo(() => {
    if (sizeMode !== "pagerank") return null;
    const scores = pageRank(display.map((work) => work.id), trustedEdges);
    return new Map([...scores].map(([id, score]) => [id, score * scores.size]));
  }, [sizeMode, display, trustedEdges]);
  const diameters = useMemo(() => {
    if (ranks) {
      const values = [...ranks.values()];
      const lowest = Math.min(...values), highest = Math.max(...values);
      return new Map([...ranks].map(([id, rank]) => [id, rankNodeDiameter(rank, lowest, highest)]));
    }
    if (sizeMode === "total") {
      const highest = Math.max(0, ...display.map((work) => work.citations ?? 0));
      return new Map(display.map((work) => [work.id, citationNodeDiameter(work.citations ?? 0, highest)]));
    }
    const highest = Math.max(0, ...incomingCitations.values());
    return new Map(display.map((work) => [work.id, citationNodeDiameter(incomingCitations.get(work.id) ?? 0, highest)]));
  }, [ranks, sizeMode, display, incomingCitations]);
  // Label priority: seeds, then the papers with the most drawn links, then the most cited.
  const labelOrder = useMemo(() => {
    const degree = new Map<string, number>();
    for (const edge of [...citationLinks, ...relatedLinks, ...couplingLinks, ...semanticLinks]) {
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
  }, [display, citationLinks, relatedLinks, couplingLinks, semanticLinks, seeds]);
  // Clusters come from the links on screen, so switching a kind of link off can split or merge them.
  const membership = useMemo(() => {
    if (colorBy !== "cluster") return null;
    return louvain(display.map((work) => work.id), [
      ...citationLinks
        .filter((edge) => !warnings.has(`${edge.source}:${edge.target}`))
        .map((edge) => ({ ...edge, weight: CLUSTER_WEIGHT.citation })),
      ...relatedLinks.map((edge) => ({ ...edge, weight: CLUSTER_WEIGHT.related })),
      ...couplingLinks.map(({ source, target }) => ({ source, target, weight: CLUSTER_WEIGHT.coupling })),
      ...semanticLinks.map(({ source, target }) => ({ source, target, weight: CLUSTER_WEIGHT.semantic })),
    ]);
  }, [colorBy, display, citationLinks, warnings, relatedLinks, couplingLinks, semanticLinks]);
  const clusters = useMemo(() => {
    if (!membership) return null;
    const rank = new Map(labelOrder.map((id, index) => [id, index]));
    const byId = new Map(display.map((work) => [work.id, work]));
    const topicName = new Map(topics.map((topic) => [topic.id, topic.name]));
    // Name each cluster's usual folder or topic, so a folder that splits or mixes shows up.
    const group = (id: string): string | null => {
      if (subfolders && byFolder) return subfolders[id]?.slice(subfolders[id].lastIndexOf("/") + 1) ?? null;
      const work = byId.get(id);
      if (!topics.length || work?.state.screening !== "included") return null;
      // 미분류 is no hint about where a cluster belongs; the share still counts every member.
      return topicName.get(work.archiveTopicId ?? "") ?? null;
    };
    return summarizeClusters(display, membership, { rank: (id) => rank.get(id) ?? rank.size, group });
  }, [membership, display, labelOrder, topics, subfolders, byFolder]);
  const clusterColors = useMemo(() => {
    if (!membership || !clusters) return null;
    const colorOf = new Map(clusters.slice(0, TOPIC_COLORS.length).map((cluster, index) => [cluster.id, TOPIC_COLORS[index] as string]));
    return new Map(display.map((work) => [work.id, colorOf.get(membership.get(work.id)!) ?? UNCLASSIFIED_COLOR]));
  }, [membership, clusters, display]);
  const activeCluster = membership ? clusterHover ?? clusterPin : null;
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
  // Papers the service found linked whose only links are switched off or past the line caps here.
  const switchedOff = works.length - display.length;
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
          // Undirected and inferred: thicker when more of the two reference lists overlaps.
          selector: "edge.coupling",
          style: {
            "line-color": "#6250d6",
            width: "mapData(weight, 0, 0.5, 1.2, 3.4)",
            "target-arrow-shape": "none",
            opacity: 0.75,
          },
        },
        {
          selector: "edge.semantic",
          style: {
            "line-style": "dashed",
            "line-dash-pattern": [3, 4],
            width: 1.6,
            "line-color": "#c2477f",
            "target-arrow-shape": "none",
            opacity: 0.75,
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
        // Coloured by cluster, links between clusters recede so each cluster's shape reads.
        { selector: "edge.cross", style: { opacity: 0.22 } },
        { selector: ".faded", style: { opacity: 0.12 } },
        { selector: ".cluster-dim", style: { opacity: 0.1 } },
        // A hover preview dims everything outside the hovered paper's neighbourhood, and relights dimmed neighbours.
        { selector: ".hover-dim", style: { opacity: 0.12 } },
        { selector: ".hover-lit.faded, .hover-lit.cluster-dim, .hover-lit.cross", style: { opacity: 1 } },
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
        .selector("node.color-mapped")
        .style({ "background-color": "data(mappedColor)" })
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
        .selector("edge.coupling")
        .style({ "line-color": token("--graph-coupling") })
        .selector("edge.semantic")
        .style({ "line-color": token("--graph-semantic") })
        .selector("edge.questionable")
        .style({
          "line-color": token("--danger"),
          "target-arrow-color": token("--danger"),
        })
        .update();
      // Year colours run the other way on a dark surface.
      setDark(darkTheme());
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
        diameter: diameters.get(w.id) ?? 24,
        mappedColor: colorBy === "cluster"
          ? clusterColors?.get(w.id) ?? UNCLASSIFIED_COLOR
          : colorBy === "year"
            ? yearColor(w.year, yearRange, dark)
            : byFolder ? folderPalette!.color(w.id) : archiveNodeColor(w, topics) || UNCLASSIFIED_COLOR,
      },
      position: positions[w.id],
      classes: [
        seeds.includes(w.id) ? "seed" : "",
        w.state.screening === "included" ? "saved" : "",
        colorBy === "year" || colorBy === "cluster" || (colorBy === "group" && (byFolder || w.state.screening === "included")) ? "color-mapped" : "",
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
    for (const { kind, source, target, weight } of [...couplingLinks, ...semanticLinks])
      definitions.push({
        data: { id: `${kind}-${source}-${target}`, source, target, weight },
        classes: kind,
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
    couplingLinks,
    semanticLinks,
    warnings,
    diameters,
    seeds,
    timeline,
    layoutRevision,
    topics,
    colorBy,
    clusterColors,
    yearRange,
    dark,
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
  }, [inspectId, neighbors, works, similarity, coupling, semantic, showQuestionable]);
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    instance.batch(() => {
      instance.nodes(".found").removeClass("found");
      for (const id of matches) instance.getElementById(id).addClass("found");
    });
  }, [matches]);
  // A new set of clusters renumbers them, so a hovered or kept cluster no longer means the same papers.
  useEffect(() => {
    setClusterHover(null);
    setClusterPin(null);
  }, [membership]);
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    instance.batch(() => {
      instance.elements(".cross, .cluster-dim").removeClass("cross cluster-dim");
      if (!membership) return;
      instance.edges().forEach((edge) => {
        const from = membership.get(edge.source().id()), to = membership.get(edge.target().id());
        if (from !== to) edge.addClass("cross");
        if (activeCluster !== null && !(from === activeCluster && to === activeCluster)) edge.addClass("cluster-dim");
      });
      if (activeCluster !== null)
        instance.nodes().forEach((node) => {
          if (membership.get(node.id()) !== activeCluster) node.addClass("cluster-dim");
        });
    });
  }, [membership, activeCluster, display, citationLinks, relatedLinks, couplingLinks, semanticLinks]);
  useEffect(() => {
    graphApi.current?.scheduleLabels();
  }, [labelOrder, label, matches, cursor, selected, inspectId, neighbors, works, similarity, coupling, semantic, showQuestionable, membership, activeCluster]);
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
          rank={ranks?.get(hovered.id)}
          cluster={membership && clusters ? clusters.find((cluster) => cluster.id === membership.get(hovered.id))?.label : undefined}
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
        {inferred.coupling.length > 0 && (
          <label title="참고문헌을 3편 이상 함께 인용한 논문 쌍입니다. 범위 밖 문헌까지 전체 참고문헌으로 계산하며, 논문마다 가장 강한 3쌍까지 그립니다.">
            <input type="checkbox" checked={coupling} onChange={(event) => setCoupling(event.target.checked)} />
            서지결합
          </label>
        )}
        {inferred.semantic.length > 0 && (
          <label title="서고 임베딩이 가까운 논문 쌍입니다. 이 범위의 모든 쌍 가운데 유사도 상위 10%만, 논문마다 가장 가까운 2쌍까지 그립니다.">
            <input type="checkbox" checked={semantic} onChange={(event) => setSemantic(event.target.checked)} />
            의미 유사
          </label>
        )}
        <label title="노드 색이 나타낼 것을 고릅니다.">
          색
          <select aria-label="노드 색 기준" value={colorBy} onChange={(event) => setColorMode(event.target.value as ColorMode)}>
            {groupColors && <option value="group">{byFolder ? "하위 폴더" : "소주제"}</option>}
            <option value="cluster">군집 (자동)</option>
            <option value="year">출판 연도</option>
            <option value="state">저장 상태</option>
          </select>
        </label>
        <label title="노드 크기가 나타낼 것을 고릅니다. 배치는 그대로이니, 노드가 겹치면 배치 초기화를 누르세요.">
          크기
          <select aria-label="노드 크기 기준" value={sizeMode} onChange={(event) => setSizeMode(event.target.value as SizeMode)}>
            <option value="inGraph">그래프 안 피인용</option>
            <option value="total">전체 피인용</option>
            <option value="pagerank">PageRank</option>
          </select>
        </label>
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
        {colorBy === "cluster" && clusters && (
          <div className="graph-topic-legend graph-cluster-legend" aria-label="군집 범례">
            {!clusters.length && <span>군집을 이룰 만큼 서로 이어진 논문이 없습니다.</span>}
            {clusters.slice(0, TOPIC_COLORS.length).map((cluster, index) => (
              <span
                key={cluster.id}
                className={`cluster-row${activeCluster === cluster.id ? " active" : ""}`}
                onMouseEnter={() => setClusterHover(cluster.id)}
                onMouseLeave={() => setClusterHover(null)}
                title={clusterHelp(cluster, (id) => workById.get(id)?.title)}
              >
                <button
                  className="cluster-name"
                  aria-pressed={clusterPin === cluster.id}
                  onClick={() => setClusterPin((current) => current === cluster.id ? null : cluster.id)}
                >
                  <i className="topic-swatch" style={{ backgroundColor: TOPIC_COLORS[index] }} />
                  {cluster.label}
                  <small>
                    {cluster.ids.length}편
                    {cluster.group ? ` · ${cluster.group.name} ${Math.round(cluster.group.share * 100)}%` : ""}
                  </small>
                </button>
                <button className="text-button cluster-select" onClick={() => onSelection(cluster.ids)}>
                  선택
                </button>
              </span>
            ))}
            {(() => {
              const named = clusters.slice(0, TOPIC_COLORS.length).reduce((sum, cluster) => sum + cluster.ids.length, 0);
              const others = clusters.length - Math.min(clusters.length, TOPIC_COLORS.length);
              const alone = display.length - clusters.reduce((sum, cluster) => sum + cluster.ids.length, 0);
              return named < display.length && (
                <span title="큰 군집 10개에만 색을 줍니다.">
                  <i className="topic-swatch" style={{ backgroundColor: UNCLASSIFIED_COLOR }} />
                  {[others ? `작은 군집 ${others}개` : "", alone ? `군집에 들지 않은 ${alone}편` : ""].filter(Boolean).join(" · ")}
                </span>
              );
            })()}
            {clusters.length === 1 && <span>연결이 고르게 이어져 한 군집으로 묶였습니다.</span>}
          </div>
        )}
        {colorBy === "year" && yearRange && (
          <span title="출판 연도를 한 가지 색의 진하기로 나타냅니다. 최근 논문일수록 배경과 대비가 큽니다.">
            <i
              className="graph-year-ramp"
              style={{ background: `linear-gradient(to right, ${YEAR_RAMP[dark ? "dark" : "light"].join(", ")})` }}
            />
            출판 연도 {yearRange[0]}–{yearRange[1]}
          </span>
        )}
        {colorBy === "year" && display.some((work) => work.year === null) && (
          <span>
            <i className="topic-swatch" style={{ backgroundColor: UNCLASSIFIED_COLOR }} />
            연도 미상
          </span>
        )}
        {colorBy !== "year" && colorBy !== "cluster" && display.some((work) => seeds.includes(work.id)) && (
          <span>
            <i className="graph-key seed" />
            초기 seed
          </span>
        )}
        {colorBy !== "year" && colorBy !== "cluster" && display.some((work) => work.state.screening === "included") && (
          <span>
            <i className="graph-key saved" />
            아카이브에 저장됨
          </span>
        )}
        {colorBy !== "year" && colorBy !== "cluster" && display.some((work) => work.state.screening === "pending") && (
          <span>
            <i className="graph-key candidate" />
            미저장 후보
          </span>
        )}
        {colorBy !== "year" && colorBy !== "cluster" && display.some((work) => work.state.screening === "excluded") && (
          <span>
            <i className="graph-key candidate" />
            제외 문헌
          </span>
        )}
        {colorBy !== "year" && colorBy !== "cluster" && display.some((work) => work.state.screening === "trash") && (
          <span>
            <i className="graph-key candidate" />
            휴지통 문헌
          </span>
        )}
        <span>
          <i className="graph-edge-key citation" />
          인용 기록 → 인용된 문헌
        </span>
        <span title={SIZE_LEGEND[sizeMode].help}>{SIZE_LEGEND[sizeMode].text}</span>
        {similarity && (
          <span>
            <i className="graph-edge-key related" />
            관련 문헌 · 방향 없음
          </span>
        )}
        {couplingLinks.length > 0 && (
          <span title="함께 인용한 참고문헌이 두 논문의 참고문헌 목록에서 차지하는 비중이 클수록 굵습니다. 인용 기록이 아니라 추정한 관계입니다.">
            <i className="graph-edge-key coupling" />
            서지결합 · 공유 참고문헌
          </span>
        )}
        {semanticLinks.length > 0 && (
          <span title="서고 임베딩(제목·초록 기준)이 가까운 논문 쌍입니다. 인용 기록이 아니라 추정한 관계입니다.">
            <i className="graph-edge-key semantic" />
            의미 유사 · 임베딩
          </span>
        )}
        {showQuestionable && warnings.size > 0 && (
          <span>
            <i className="graph-edge-key questionable" />
            확인 필요 인용
          </span>
        )}
        <span title="다른 논문과 인용(확인 필요 인용 제외), 관련 문헌, 서지결합, 의미 유사로 이어진 논문만 그립니다. 꺼 둔 연결로만 이어진 논문은 따로 셉니다.">
          현재 범위 {resultTotal.toLocaleString()}편 중 {resultCount.toLocaleString()}편 표시
          {extraCount > 0 ? ` · 출발 문헌 ${extraCount}편 추가` : ""}
          {isolatedCount > 0 ? ` · 연결 없는 ${isolatedCount.toLocaleString()}편 숨김` : ""}
          {switchedOff > 0 ? ` · 꺼 둔 연결로 ${switchedOff.toLocaleString()}편 숨김` : ""}
          {connected !== undefined && connected > GRAPH_LIMIT
            ? ` · 연결된 ${connected.toLocaleString()}편 중 연결이 많은 ${GRAPH_LIMIT.toLocaleString()}편까지, 필터로 범위를 좁히세요`
            : ""}
        </span>
        {!!skippedLinks?.length && (
          <span title="서지결합은 5,000편, 의미 유사는 임베딩이 있는 1,500편까지 계산합니다. 모든 쌍을 비교하므로 범위가 크면 그래프가 느려집니다.">
            범위가 커서 {skippedLinks.map((kind) => kind === "coupling" ? "서지결합" : "의미 유사").join("·")} 연결은 그리지 않았습니다 · 폴더나 필터로 범위를 좁히세요
          </span>
        )}
        <span>노드에 올리면 제목과 이웃 표시 · 드래그한 노드만 이동 · Shift+드래그로 선택</span>
        {visibleEdges.length > 3000 && <span>인용선 최대 3,000개 표시</span>}
      </div>
    </div>
  );
}
