export async function sendChat({ message, history }) {
  const resp = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history })
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || "聊天请求失败");
  }

  return data;
}
