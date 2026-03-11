<script setup>
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
</script>

<template>
  <div
    class="message"
    :class="props.role"
    v-motion
    :initial="{ opacity: 0, y: 12 }"
    :enter="{ opacity: 1, y: 0, transition: { duration: 220 } }"
  >
    {{ props.content }}
  </div>
</template>
