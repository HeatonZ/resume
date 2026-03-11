const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const distDir = path.join(__dirname, "dist");
const resumeJsonPath = path.join(__dirname, "data", "resume.json");

function stripHtml(input) {
  return String(input || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeText(value) {
  return String(value || "").trim();
}

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function readResumeJson() {
  let raw;
  try {
    raw = fs.readFileSync(resumeJsonPath, "utf8");
  } catch {
    const error = new Error("Resume source not found: data/resume.json");
    error.code = "RESUME_SOURCE_MISSING";
    throw error;
  }

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Resume source is not valid JSON: data/resume.json");
    error.code = "RESUME_SOURCE_INVALID";
    throw error;
  }
}

function normalizeProfile(resume) {
  const basics = resume?.basics || {};
  const summaryRaw = safeText(stripHtml(resume?.summary?.content));
  const sections = resume?.sections || {};
  const skills = Array.isArray(sections?.skills?.items)
    ? sections.skills.items
        .map((item) => safeText(item?.name))
        .filter(Boolean)
        .slice(0, 12)
    : [];

  const experiences = Array.isArray(sections?.experience?.items) ? sections.experience.items : [];
  const projects = Array.isArray(sections?.projects?.items) ? sections.projects.items : [];

  const highlights = [];
  for (const item of experiences.slice(0, 2)) {
    const value = [safeText(item?.position), safeText(item?.company), safeText(item?.period)]
      .filter(Boolean)
      .join(" | ");
    if (value) highlights.push(value);
  }
  for (const item of projects.slice(0, 2)) {
    const value = [safeText(item?.name), safeText(item?.period)].filter(Boolean).join(" | ");
    if (value) highlights.push(value);
  }

  return {
    name: safeText(basics?.name) || "Candidate",
    headline: safeText(basics?.headline),
    location: safeText(basics?.location),
    email: safeText(basics?.email),
    phone: safeText(basics?.phone),
    summary: summaryRaw,
    skills,
    highlights: highlights.slice(0, 4)
  };
}

function buildResumeChunks(resume) {
  const chunks = [];
  let nextId = 1;

  function pushChunk(title, text) {
    const cleanTitle = safeText(title);
    const cleanText = safeText(text);
    if (!cleanText) return;
    chunks.push({ id: nextId++, title: cleanTitle || `Section ${nextId - 1}`, text: cleanText });
  }

  const basics = resume?.basics || {};
  const identityText = [safeText(basics?.name), safeText(basics?.headline), safeText(basics?.location)]
    .filter(Boolean)
    .join(" | ");
  pushChunk("Basics", identityText);

  pushChunk("Summary", stripHtml(resume?.summary?.content || ""));

  const sections = resume?.sections || {};

  const experienceItems = Array.isArray(sections?.experience?.items) ? sections.experience.items : [];
  for (const item of experienceItems) {
    pushChunk(
      `Experience: ${safeText(item?.company) || safeText(item?.position) || "Item"}`,
      [
        safeText(item?.company),
        safeText(item?.position),
        safeText(item?.location),
        safeText(item?.period),
        stripHtml(item?.description || "")
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  const projectItems = Array.isArray(sections?.projects?.items) ? sections.projects.items : [];
  for (const item of projectItems) {
    pushChunk(
      `Project: ${safeText(item?.name) || "Item"}`,
      [safeText(item?.name), safeText(item?.period), stripHtml(item?.description || "")]
        .filter(Boolean)
        .join("\n")
    );
  }

  const educationItems = Array.isArray(sections?.education?.items) ? sections.education.items : [];
  for (const item of educationItems) {
    pushChunk(
      `Education: ${safeText(item?.school) || "Item"}`,
      [
        safeText(item?.school),
        safeText(item?.degree),
        safeText(item?.area),
        safeText(item?.period),
        stripHtml(item?.description || "")
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  const skillItems = Array.isArray(sections?.skills?.items) ? sections.skills.items : [];
  if (skillItems.length > 0) {
    pushChunk(
      "Skills",
      skillItems
        .map((item) => safeText(item?.name))
        .filter(Boolean)
        .join(", ")
    );
  }

  if (chunks.length === 0) {
    pushChunk("Resume", "No structured resume content available.");
  }

  return chunks;
}

function pickTopChunks(query, chunks, topK = 4) {
  const queryTokens = tokenize(query);
  const querySet = new Set(queryTokens);

  return chunks
    .map((chunk) => {
      const chunkTokens = tokenize(chunk.text);
      let score = 0;
      for (const token of chunkTokens) {
        if (querySet.has(token)) score += 1;
      }
      return { ...chunk, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function getMimeType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "text/plain; charset=utf-8";
}

async function callOpenAI(messages) {
  if (!OPENAI_API_KEY) {
    return "当前未配置 OPENAI_API_KEY。请先设置环境变量后重试。";
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.3,
      messages
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "没有拿到模型回复。";
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function serveFile(filePath, res) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    res.writeHead(200, { "Content-Type": getMimeType(filePath) });
    res.end(content);
  });
}

function serveSpa(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = reqUrl.pathname;
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const targetPath = path.join(distDir, safePath);

  if (!targetPath.startsWith(distDir)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(distDir)) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("dist 不存在。请先执行 npm run build。\n");
    return;
  }

  if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
    serveFile(targetPath, res);
    return;
  }

  serveFile(path.join(distDir, "index.html"), res);
}

function getRuntimeContext() {
  const resume = readResumeJson();
  const profile = normalizeProfile(resume);
  const chunks = buildResumeChunks(resume);
  return { profile, chunks };
}

function handleProfile(res, reqId) {
  try {
    const { profile } = getRuntimeContext();
    sendJson(res, 200, profile);
  } catch (error) {
    sendJson(res, 500, {
      error: error.message || "服务异常",
      code: error.code || "RUNTIME_PROFILE_ERROR",
      requestId: reqId
    });
  }
}

async function handleChat(req, res, reqId) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", async () => {
    try {
      const payload = JSON.parse(body || "{}");
      const userMessage = String(payload.message || "").trim();
      const history = Array.isArray(payload.history) ? payload.history : [];

      if (!userMessage) {
        sendJson(res, 400, { error: "message 不能为空", requestId: reqId });
        return;
      }

      const { profile, chunks } = getRuntimeContext();
      const refs = pickTopChunks(userMessage, chunks, 4);
      const context = refs.map((chunk) => chunk.text).join("\n\n---\n\n");

      const systemPrompt =
        `你是“${profile.name}”的 AI 名片助手，目标是向用户准确介绍该候选人的简历信息。` +
        "你必须严格依据提供的简历资料回答，禁止编造不存在的事实。" +
        "如果信息缺失，请明确说‘资料中未提供该信息’。" +
        "回答语言使用中文，风格专业、简洁、客观。";

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "system", content: `简历资料如下：\n${context}` }
      ];

      for (const item of history.slice(-8)) {
        if (item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string") {
          messages.push(item);
        }
      }

      messages.push({ role: "user", content: userMessage });
      const reply = await callOpenAI(messages);

      sendJson(res, 200, {
        reply,
        references: refs.map((item) => ({ title: item.title, score: item.score })),
        requestId: reqId
      });
    } catch (error) {
      sendJson(res, 500, {
        error: error.message || "服务异常",
        code: error.code || "CHAT_RUNTIME_ERROR",
        requestId: reqId
      });
    }
  });
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = reqUrl.pathname;
  const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (req.method === "POST" && pathname === "/api/chat") {
    handleChat(req, res, reqId);
    return;
  }

  if (req.method === "GET" && pathname === "/api/profile") {
    handleProfile(res, reqId);
    return;
  }

  if (req.method === "GET") {
    serveSpa(req, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method Not Allowed");
});

server.listen(PORT, () => {
  console.log(`Resume AI profile is running at http://localhost:${PORT}`);
});
