<script setup lang="ts">
import { computed } from 'vue';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import 'highlight.js/styles/github-dark.css';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);

const props = defineProps<{
  code: string;
  language: 'typescript' | 'python';
}>();

const highlighted = computed(
  () => hljs.highlight(props.code, { language: props.language }).value,
);
</script>

<template>
  <!-- prettier-ignore -->
  <pre class="overflow-auto bg-surface-950/80 rounded-xl p-4 text-xs font-mono text-surface-300 border border-surface-800/50 leading-relaxed whitespace-pre"><code class="hljs" v-html="highlighted" /></pre>
</template>

<style scoped>
.hljs {
  background: transparent;
}
</style>
