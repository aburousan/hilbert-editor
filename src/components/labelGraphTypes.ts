// The shape the backend sends for a document's labels.
export type Node = {
  id: string;
  /// Section nodes carry a heading to show; labels are known by their id.
  title?: string;
  kind: string;
  file: string;
  line: number;
  section: string;
  referenced: number;
  defined: number;
};
export type Edge = { from: string; to: string; file: string; line: number; uses: number };
export type Missing = { id: string; uses: number; file: string; line: number };
export type Graph = { nodes: Node[]; edges: Edge[]; missing: Missing[]; files: string[] };
