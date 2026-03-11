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
const tagSkills = computed(() => {
  const skills = Array.isArray(props.profile?.skills) ? props.profile.skills : [];
  return skills.slice(0, 3);
});
</script>

<template>
  <section class="hero" v-motion :initial="{ opacity: 0, y: 20 }" :enter="{ opacity: 1, y: 0 }">
    <div class="hero-left">
      <p class="eyebrow">{{ displayName.toUpperCase() }} / AI PROFILE</p>
      <h1>{{ displayName }}</h1>
      <p class="hero-copy">{{ headline }}</p>
      <p class="hero-copy">{{ summary }}</p>
    </div>
  </section>
</template>
