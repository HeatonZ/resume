import { defineStore } from "pinia";
import { sendChatStream } from "../api/chat";
import { fetchProfile } from "../api/profile";

function emptyProfile() {
  return {
    name: "Candidate",
    headline: "",
    location: "",
    email: "",
    phone: "",
    github: "https://github.com/HeatonZ/resume",
    resumePdfUrl: "",
    summary: "",
    skills: [],
    highlights: []
  };
}

function buildSuggestions(name) {
  const who = name || "这位候选人";
  return [
    `请介绍一下${who}的职业背景`,
    `${who}最擅长哪些技术方向？`,
    `${who}做过哪些代表项目？`,
    `如果用 1 分钟介绍${who}，你会怎么说？`
  ];
}

function buildWelcome(profile) {
  const who = profile?.name || "这位候选人";
  const headline = profile?.headline ? `，当前定位是${profile.headline}` : "";
  return `你好，我是${who}的 AI 助手${headline}。你可以问我他的经历、技能和项目。`;
}

export const useChatStore = defineStore("chat", {
  state: () => ({
    profile: emptyProfile(),
    initialized: false,
    profileLoading: false,
    messages: [],
    pending: false,
    error: "",
    suggestions: []
  }),
  actions: {
    async init(force = false) {
      if (this.profileLoading) return;
      if (this.initialized && !force) return;

      this.profileLoading = true;
      this.error = "";

      try {
        const data = await fetchProfile();
        const empty = emptyProfile()
        this.profile = {
          ...empty,
          ...data,
          skills: Array.isArray(data?.skills) ? data.skills.filter(Boolean) : [],
          highlights: Array.isArray(data?.highlights) ? data.highlights.filter(Boolean) : []
        };
        this.profile.github = this.profile.github || empty.github
        this.profile.resumePdfUrl = this.profile.resumePdfUrl || empty.resumePdfUrl
        console.log(this.profile, empty)
      } catch (err) {
        this.error = err.message || "加载资料失败";
        this.profile = emptyProfile();
      } finally {
        this.profileLoading = false;
      }

      this.suggestions = buildSuggestions(this.profile.name);
      this.messages = [{ role: "assistant", content: buildWelcome(this.profile) }];
      this.initialized = true;
    },

    async submit(rawInput) {
      const message = String(rawInput || "").trim();
      if (!message || this.pending) return;

      this.error = "";
      this.messages.push({ role: "user", content: message });
      this.pending = true;

      const history = this.messages.slice(0, -1).map(({ role, content }) => ({ role, content }));
      this.messages.push({ role: "assistant", content: "", references: [] });
      const assistantIndex = this.messages.length - 1;

      try {
        await sendChatStream({
          message,
          history,
          onToken: (delta) => {
            const current = this.messages[assistantIndex];
            if (!current) return;
            current.content += delta;
          },
          onRefs: (references) => {
            const current = this.messages[assistantIndex];
            if (!current) return;
            current.references = Array.isArray(references) ? references : [];
          }
        });

        const current = this.messages[assistantIndex];
        if (current && !String(current.content || "").trim()) {
          current.content = "暂时没有可用回复。";
        }
      } catch (err) {
        this.error = err.message || "请求失败";
        const current = this.messages[assistantIndex];
        if (!current) return;

        if (String(current.content || "").trim()) {
          current.content += `\n\n请求异常：${this.error}`;
        } else {
          current.content = `请求失败：${this.error}`;
        }
      } finally {
        this.pending = false;
      }
    }
  }
});
