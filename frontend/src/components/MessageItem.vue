<script setup>
import { computed } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";

const props = defineProps({
  role: {
    type: String,
    required: true
  },
  content: {
    type: String,
    required: true
  }
});

marked.setOptions({
  gfm: true,
  breaks: true
});

const renderedContent = computed(() => {
  const raw = String(props.content || "");
  const html = marked.parse(raw);
  return DOMPurify.sanitize(html);
});
</script>

<template>
  <div
    class="message"
    :class="props.role"
    v-motion
    :initial="{ opacity: 0, y: 12 }"
    :enter="{ opacity: 1, y: 0, transition: { duration: 220 } }"
  >
    <div class="message-markdown" v-html="renderedContent"></div>
  </div>
</template>
