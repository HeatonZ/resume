<script setup>
import { computed } from "vue";

const props = defineProps({
  profile: {
    type: Object,
    required: true
  }
});

const displayName = computed(() => props.profile?.name || "Candidate");
const headline = computed(() => props.profile?.headline || "AI Resume Profile");
const summary = computed(() => props.profile?.summary || "通过对话快速了解候选人的经历、技能与项目成果。");
const githubUrl = computed(() => {
  const value = String(props.profile?.github || "").trim();
  return /^https?:\/\//i.test(value) ? value : "";
});
</script>

<template>
  <section class="hero" v-motion :initial="{ opacity: 0, y: 20 }" :enter="{ opacity: 1, y: 0 }">
    <div class="hero-left">
      <!-- <div class="hero-top">
      </div> -->
      <h1>
        {{ displayName }}
        <a v-if="githubUrl" class="github-badge" :href="githubUrl" target="_blank" rel="noreferrer noopener">
          <svg aria-hidden="true" viewBox="0 0 16 16" class="github-mark">
            <path
              d="M6.766 11.695C4.703 11.437 3.25 9.904 3.25 7.92c0-.806.281-1.677.75-2.258-.203-.532-.172-1.662.062-2.129.626-.081 1.469.258 1.969.726.594-.194 1.219-.291 1.985-.291.765 0 1.39.097 1.953.274.484-.451 1.343-.79 1.969-.709.218.435.25 1.564.046 2.113.5.613.766 1.436.766 2.274 0 1.984-1.453 3.485-3.547 3.759.531.355.891 1.129.891 2.016v1.678c0 .484.39.758.859.564C13.781 14.824 16 11.905 16 8.291 16 3.726 12.406 0 7.984 0 3.562 0 0 3.726 0 8.291c0 3.581 2.203 6.55 5.172 7.663A.595.595 0 0 0 6 15.389v-1.291c-.219.097-.5.162-.75.162-1.031 0-1.641-.581-2.078-1.662-.172-.435-.36-.693-.719-.742-.187-.016-.25-.097-.25-.193 0-.194.313-.339.625-.339.453 0 .844.29 1.25.887.313.468.641.678 1.031.678.391 0 .641-.146 1-.516.266-.275.469-.517.657-.678Z"
            />
          </svg>
          <span>View on GitHub</span>
        </a>
      </h1>
      <p class="hero-copy">{{ headline }}</p>
      <p class="hero-copy">{{ summary }}</p>
    </div>
  </section>
</template>
