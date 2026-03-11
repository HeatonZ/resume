import { buildApiUrl } from "./base";

export async function fetchProfile() {
  const resp = await fetch(buildApiUrl("/api/profile"), {
    method: "GET",
    headers: { Accept: "application/json" }
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || "获取简历资料失败");
  }

  return data;
}
