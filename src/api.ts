export async function api<T = any>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, options);
  const body = await response.json(); if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`); return body;
}
export function post<T = any>(path: string, data: unknown = {}) { return api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
export function upload<T = any>(path: string, file: File) { const body = new FormData(); body.set('file', file); return api<T>(path, { method: 'POST', body }); }
