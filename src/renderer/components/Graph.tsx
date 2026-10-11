import { useEffect, useRef, useState, useMemo } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { Focus, ZoomIn, ZoomOut, Waypoints, RotateCcw } from "lucide-react";
import type { WorkView, ArchiveTopic } from "../../shared/types";
import { archiveNodeColor, subfolderColors, UNCLASSIFIED_COLOR } from "../../shared/classification";
import { citationWarnings, citationNodeDiameter, incomingCitationCounts, GRAPH_LIMIT } from "../../shared/graph";
import { similarityEdges } from "../../shared/domain";
import {
  capturePositions,
  reconcileGraph,
  placeGraph,
  individualNodeDragging,
} from "./graphLayout";
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
            "font-size": 11,
            "min-zoomed-font-size": 9,
            "text-background-opacity": 0.92,
            "text-background-padding": "3px",
            "text-background-shape": "roundrectangle",
            color: "#55645d",
            "text-valign": "bottom",
            "text-margin-y": 8,
            "text-max-width": "150px",
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
          selector: ".inspected",
          style: {
            "underlay-color": "#34775b",
            "underlay-opacity": 0.12,
            "underlay-padding": 9,
          },
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
    instance.on("mouseover", "node", (event) =>
      event.target.addClass("hovered"),
    );
    instance.on("mouseout", "node", (event) =>
      event.target.removeClass("hovered"),
    );
    instance.on("dragfreeon", "node", () => {
      if (!callbacks.current.timeline)
        callbacks.current.onPositions({ ...callbacks.current.positions, ...capturePositions(instance) });
    });
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(host.current);
    return () => {
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
        .slice(0, 5)
        .map((w) => w.id),
    );
    const paperLabel = (w: WorkView) =>
      `${w.authors[0]?.split(",")[0] || w.title.slice(0, 20)} · ${w.year || "연도 미상"}`;
    const definitions: ElementDefinition[] = display.map((w) => ({
      data: {
        id: w.id,
        label: labeled.has(w.id) ? paperLabel(w) : "",
        fullLabel: paperLabel(w),
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
    cy.current
      ?.style()
      .selector("node")
      .style("label", label ? "data(label)" : "")
      .selector("node.inspected, node.hovered")
      .style({
        label: "data(fullLabel)",
        "min-zoomed-font-size": 0,
        "z-index": 10,
      })
      .update();
  }, [label]);
  const years = [...new Set(display.map((w) => w.year))].sort(
    (a, b) => (a ?? 9999) - (b ?? 9999),
  );
  return (
    <div className={`graph-wrap${colorByTopic ? " topic-mode" : ""}`}>
      <div ref={host} className="graph-canvas" aria-label="논문 인용 그래프" />
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
        <label>
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
        <span>드래그한 노드만 이동 · Shift+드래그로 선택</span>
        {visibleEdges.length > 3000 && <span>인용선 최대 3,000개 표시</span>}
      </div>
    </div>
  );
}
