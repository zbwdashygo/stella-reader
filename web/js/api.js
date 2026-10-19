/* 后端 API 封装：统一错误处理 + 中文 toast */

import { toast } from './util.js';

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.isApiError = true;
  }
}

export function encodePath(path) {
  return String(path || '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function request(path, options = {}) {
  const {
    method = 'GET', body, headers = {}, toastOnError = true, raw = false,
  } = options;

  let response;
  try {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(body);
    }
    response = await fetch(path, init);
  } catch (err) {
    const message = '无法连接本地服务，请确认听书服务已启动';
    if (toastOnError) toast(message, 'error');
    throw new ApiError(message, 'NETWORK_ERROR', 0);
  }

  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`;
    let code = 'HTTP_ERROR';
    try {
      const data = await response.json();
      if (data && data.error) {
        if (data.error.message) message = data.error.message;
        if (data.error.code) code = data.error.code;
      }
    } catch { /* 非 JSON 错误体 */ }
    if (toastOnError) toast(message, 'error');
    throw new ApiError(message, code, response.status);
  }

  if (raw) return response;
  if (response.status === 204) return null;
  try { return await response.json(); }
  catch { return null; }
}

export const api = {
  health() {
    return request('/api/health', { toastOnError: false });
  },

  listBooks() {
    return request('/api/books');
  },

  getBook(id) {
    return request(`/api/books/${encodeURIComponent(id)}`);
  },

  importByPath(path) {
    return request('/api/books/import', { method: 'POST', body: { path } });
  },

  importByBytes(name, dataBase64) {
    return request('/api/books/import-bytes', { method: 'POST', body: { name, dataBase64 } });
  },

  updateBook(id, patch, { toastOnError = false } = {}) {
    return request(`/api/books/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: patch, toastOnError,
    });
  },

  deleteBook(id) {
    return request(`/api/books/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  search(id, keyword) {
    return request(`/api/books/${encodeURIComponent(id)}/search?q=${encodeURIComponent(keyword)}`);
  },

  coverUrl(id) {
    return `/api/books/${encodeURIComponent(id)}/cover`;
  },

  resUrl(id, path) {
    return `/api/books/${encodeURIComponent(id)}/res/${encodePath(path)}`;
  },
};
