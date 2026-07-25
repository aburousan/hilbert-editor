import { API } from './api';
import type { ProjectFs } from './projectCollab';

type FileNode = {
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
};

function flattenFiles(nodes: FileNode[], out: Array<{ path: string }> = []): Array<{ path: string }> {
  for (const node of nodes) {
    if (node.type === 'directory') {
      flattenFiles(node.children ?? [], out);
    } else {
      out.push({ path: node.path });
    }
  }
  return out;
}

async function checked(response: Response, action: string): Promise<Response> {
  if (response.ok) return response;
  const detail = (await response.text().catch(() => '')).trim();
  throw new Error(detail || `${action} failed (${response.status})`);
}

export function createProjectFs(): ProjectFs {
  return {
    async list() {
      const response = await checked(await fetch(`${API}/workspace`), 'Listing the workspace');
      return flattenFiles(await response.json());
    },

    async readText(path) {
      const response = await checked(
        await fetch(`${API}/workspace/file?path=${encodeURIComponent(path)}`),
        `Reading ${path}`,
      );
      return response.text();
    },

    async readBinary(path) {
      const response = await checked(
        await fetch(`${API}/workspace/raw?path=${encodeURIComponent(path)}`),
        `Reading ${path}`,
      );
      return new Uint8Array(await response.arrayBuffer());
    },

    async writeText(path, content) {
      await checked(await fetch(`${API}/workspace/upload?path=${encodeURIComponent(path)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: content,
      }), `Writing ${path}`);
    },

    async writeBinary(path, bytes) {
      await checked(await fetch(`${API}/workspace/upload?path=${encodeURIComponent(path)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes as BodyInit,
      }), `Writing ${path}`);
    },

    async remove(path) {
      const response = await fetch(`${API}/workspace/file?path=${encodeURIComponent(path)}`, {
        method: 'DELETE',
      });
      if (response.ok || response.status === 404) return;
      await checked(response, `Removing ${path}`);
    },
  };
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', view));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}
