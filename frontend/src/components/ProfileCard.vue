<script setup>
import { computed } from "vue";

const props = defineProps({
  profile: {
    type: Object,
    required: true
  }
});

const displayName = computed(() => props.profile?.name || "Candidate");
const headline = computed(() => props.profile?.headline || "");
const avatarText = computed(() => displayName.value.slice(0, 2).toUpperCase());
const skills = computed(() => {
  const list = Array.isArray(props.profile?.skills) ? props.profile.skills : [];
  return list.slice(0, 8);
});
const highlights = computed(() => {
  const list = Array.isArray(props.profile?.highlights) ? props.profile.highlights : [];
  return list.slice(0, 4);
});
</script>

<template>
  <aside class="profile-card" v-motion :initial="{ opacity: 0, x: -12 }" :enter="{ opacity: 1, x: 0 }">
   
    <div class="skill-block">
      <h3>基本信息</h3>
      <ul class="meta-list">
        <li><strong>地点：</strong>{{ props.profile?.location || "未提供" }}</li>
        <li><strong>邮箱：</strong>{{ props.profile?.email || "未提供" }}</li>
        <li><strong>电话：</strong>{{ props.profile?.phone || "未提供" }}</li>
      </ul>
    </div>

    <div class="skill-block" v-if="highlights.length > 0">
      <h3>经历摘要</h3>
      <ul class="meta-list">
        <li v-for="item in highlights" :key="item">{{ item }}</li>
      </ul>
    </div>

    <div class="skill-block">
      <h3>技能标签</h3>
      <div class="chips">
        <span v-for="skill in skills" :key="skill">{{ skill }}</span>
        <span v-if="skills.length === 0">暂无技能标签</span>
      </div>
    </div>
  </aside>
</template>
