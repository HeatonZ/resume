<script setup>
const props = defineProps({
  items: {
    type: Array,
    default: () => []
  },
  disabled: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(["pick"]);
</script>

<template>
  <div class="prompt-chips">
    <button
      v-for="item in props.items"
      :key="item"
      type="button"
      class="chip"
      :disabled="props.disabled"
      @click="emit('pick', item)"
    >
      {{ item }}
    </button>
  </div>
</template>
