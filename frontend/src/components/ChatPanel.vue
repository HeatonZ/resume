<script setup>
import { nextTick, ref, watch } from "vue";
import { NButton, NInput, NSpin } from "naive-ui";
import MessageItem from "./MessageItem.vue";
import PromptChips from "./PromptChips.vue";

const props = defineProps({
  messages: {
    type: Array,
    required: true
  },
  suggestions: {
    type: Array,
    default: () => []
  },
  pending: {
    type: Boolean,
    default: false
  },
  placeholder: {
    type: String,
    default: "请输入你的问题"
  }
});

const emit = defineEmits(["submit"]);
const input = ref("");
const listRef = ref(null);

function submit(value = input.value) {
  const text = String(value || "").trim();
  if (!text || props.pending) return;
  emit("submit", text);
  input.value = "";
}

watch(
  () => props.messages.map((msg) => `${msg.role}:${msg.content?.length || 0}`).join("|"),
  async () => {
    await nextTick();
    if (listRef.value) {
      listRef.value.scrollTop = listRef.value.scrollHeight;
    }
  }
);
</script>

<template>
  <section class="chat-panel">
    <div class="message-list" ref="listRef">
      <MessageItem v-for="(msg, idx) in props.messages" :key="idx" :role="msg.role" :content="msg.content" />
      <div v-if="props.pending" class="typing">
        <NSpin size="small" /> AI 正在组织答案...
      </div>
    </div>

    <PromptChips :items="props.suggestions" :disabled="props.pending" @pick="submit" />

    <form class="composer" @submit.prevent="submit()">
      <NInput
        v-model:value="input"
        type="text"
        size="large"
        clearable
        :disabled="props.pending"
        :placeholder="props.placeholder"
      />
      <NButton type="primary" size="large" :disabled="props.pending || !input.trim()" attr-type="submit">
        发送
      </NButton>
    </form>
  </section>
</template>
