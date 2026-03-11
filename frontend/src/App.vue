<script setup>
import { computed, onMounted, watch } from "vue";
import { NConfigProvider, NMessageProvider, NSpin, zhCN, dateZhCN } from "naive-ui";
import TopHero from "./components/TopHero.vue";
import ProfileCard from "./components/ProfileCard.vue";
import ChatPanel from "./components/ChatPanel.vue";
import { useChatStore } from "./stores/chat";

const chatStore = useChatStore();

const themeOverrides = {
  common: {
    primaryColor: "#0077b6",
    primaryColorHover: "#0a84c9",
    primaryColorPressed: "#04679d",
    borderRadius: "14px"
  },
  Input: {
    border: "1px solid #d7dfeb",
    boxShadowFocus: "0 0 0 2px rgba(0, 119, 182, 0.18)"
  }
};

const profile = computed(() => chatStore.profile);
const messages = computed(() => chatStore.messages);
const suggestions = computed(() => chatStore.suggestions);
const pending = computed(() => chatStore.pending);
const profileLoading = computed(() => chatStore.profileLoading);
const inputPlaceholder = computed(() => {
  const name = profile.value?.name || "候选人";
  return `例如：${name}做过哪些项目？`;
});

watch(
  () => profile.value?.name,
  (name) => {
    if (!name) return;
    document.title = `${name} 简历`;
  },
  { immediate: true }
);

function onSubmit(text) {
  chatStore.submit(text);
}

onMounted(() => {
  chatStore.init();
});
</script>

<template>
  <NConfigProvider :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <NMessageProvider>
      <div class="app-shell">
        <div class="page" :class="{ 'page-loading': profileLoading }">
          <TopHero :profile="profile" />
          <section class="content-grid">
            <aside class="profile-column">
              <ProfileCard :profile="profile" />
            </aside>
            <section class="chat-column">
              <ChatPanel
                :messages="messages"
                :suggestions="suggestions"
                :pending="pending"
                :placeholder="inputPlaceholder"
                @submit="onSubmit"
              />
            </section>
          </section>
        </div>

        <div
          v-if="profileLoading"
          class="global-loading-mask"
          v-motion
          :initial="{ opacity: 0 }"
          :enter="{ opacity: 1, transition: { duration: 220 } }"
        >
          <div
            class="global-loading-panel"
            v-motion
            :initial="{ opacity: 0, y: 14, scale: 0.98 }"
            :enter="{ opacity: 1, y: 0, scale: 1, transition: { duration: 260 } }"
          >
            <NSpin size="large" />
            <p>正在加载档案数据...</p>
          </div>
        </div>
      </div>
    </NMessageProvider>
  </NConfigProvider>
</template>
