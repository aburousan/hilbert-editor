// The order the file tree is drawn in. The backend lists each folder by name; with `foldersFirst` the
// subfolders of every folder come before its files, as in most file managers (issue #52). The name order
// inside each group is kept as it came.
export type TreeNode = { type: 'file' | 'directory'; children?: TreeNode[] };

export function orderTree<T extends TreeNode>(nodes: T[], foldersFirst: boolean): T[] {
  if (!foldersFirst) return nodes;
  const dirs: T[] = [];
  const files: T[] = [];
  for (const node of nodes) {
    if (node.type === 'directory') {
      dirs.push(node.children ? { ...node, children: orderTree(node.children as T[], true) } : node);
    } else {
      files.push(node);
    }
  }
  return dirs.concat(files);
}

const KEY = 'hilbert.treeFoldersFirst';

export function loadFoldersFirst(): boolean {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}

export function saveFoldersFirst(on: boolean): void {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* only a convenience */ }
}
