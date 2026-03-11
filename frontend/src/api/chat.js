import { buildApiUrl } from "./base";

function parseEventBlock(block) {
  const lines = block.split(/\r?\n/);
  let event = "message";
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  const dataText = dataLines.join("\n");
  let data = null;
  try {
    data = dataText ? JSON.parse(dataText) : null;
  } catch {
    data = { raw: dataText };
  }

  return { event, data };
}

async function readStreamEvents(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      onEvent(parseEventBlock(trimmed));
    }
  }

  if (buffer.trim()) {
    onEvent(parseEventBlock(buffer.trim()));
  }
}

export async function sendChat({ message, history }) {
  const resp = await fetch(buildApiUrl("/api/chat"), {
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

export async function sendChatStream({ message, history, onToken, onRefs }) {
  const resp = await fetch(buildApiUrl("/api/chat/stream"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream"
    },
    body: JSON.stringify({ message, history })
  });

  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || "聊天请求失败");
  }

  if (!resp.body) {
    throw new Error("服务端未返回流式内容");
  }

  let donePayload = null;
  await readStreamEvents(resp.body, ({ event, data }) => {
    if (event === "token" && data?.delta && onToken) {
      onToken(data.delta);
      return;
    }
    if (event === "refs" && onRefs) {
      onRefs(data?.references || []);
      return;
    }
    if (event === "error") {
      throw new Error(data?.message || "流式响应失败");
    }
    if (event === "done") {
      donePayload = data || {};
    }
  });

  return donePayload || {};
}
