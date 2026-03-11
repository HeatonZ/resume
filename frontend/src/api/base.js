const envBase = typeof import.meta !== "undefined" ? import.meta.env?.VITE_API_BASE_URL : "";
const isDev = typeof import.meta !== "undefined" ? Boolean(import.meta.env?.DEV) : false;
const fallbackDevBase = isDev ? "http://localhost:8000" : "";
const normalizedBase = String(envBase || fallbackDevBase || "").trim().replace(/\/+$/, "");

export function buildApiUrl(path) {
  const normalizedPath = `/${String(path || "").replace(/^\/+/, "")}`;
  if (!normalizedBase) return normalizedPath;
  return `${normalizedBase}${normalizedPath}`;
}
