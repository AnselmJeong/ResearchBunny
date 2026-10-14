import type { Dispatch, SetStateAction } from "react";

// Pinned groups (출발 문헌, 서고 문헌) sit outside the paged list, so the page and 모두 선택 checkboxes never reach them.
export function GroupSelection({ ids, selected, setSelected }: {
  ids: string[];
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<string[]>>;
}) {
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  const some = ids.some((id) => selected.has(id));
  return <label className="group-selection">
    <input
      type="checkbox"
      checked={all}
      ref={(input) => { if (input) input.indeterminate = some && !all; }}
      onChange={(e) => {
        const checked = e.target.checked, group = new Set(ids);
        setSelected((current) => checked ? [...new Set([...current, ...ids])] : current.filter((id) => !group.has(id)));
      }}
    />
    {all ? "모두 선택 해제" : `모두 선택 · ${ids.length}편`}
  </label>;
}
