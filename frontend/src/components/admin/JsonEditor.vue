<script setup lang="ts">
    import { Codemirror } from "vue-codemirror";
    import { json, jsonParseLinter } from "@codemirror/lang-json";
    import { oneDark } from "@codemirror/theme-one-dark";
    import { linter } from "@codemirror/lint";
    import { lineNumbers } from "@codemirror/view";

    withDefaults(
        defineProps<{
            modelValue: string;
            placeholder?: string;
            height?: string;
        }>(),
        {
            placeholder: "{}",
            height: "200px",
        },
    );

    const emit = defineEmits<{
        "update:modelValue": [value: string];
        valid: [isValid: boolean];
    }>();

    const extensions = [json(), oneDark, linter(jsonParseLinter()), lineNumbers()];

    function handleChange(value: string) {
        emit("update:modelValue", value);
        try {
            JSON.parse(value);
            emit("valid", true);
        } catch {
            emit("valid", false);
        }
    }
</script>

<template>
    <div class="json-editor-wrap" :style="{ '--editor-height': height }">
        <Codemirror :model-value="modelValue" :extensions="extensions" :placeholder="placeholder" :style="{ height }"
            @update:model-value="handleChange" />
    </div>
</template>

<style scoped>
    .json-editor-wrap {
        border-radius: 4px;
        overflow: hidden;
        border: 1px solid var(--color-border);
    }

    .json-editor-wrap:focus-within {
        border-color: var(--color-primary);
    }

    /* Ensure CodeMirror fills the height */
    .json-editor-wrap :deep(.cm-editor) {
        height: var(--editor-height, 200px);
        font-family: "JetBrains Mono", monospace;
        font-size: 0.82rem;
    }

    .json-editor-wrap :deep(.cm-scroller) {
        overflow: auto;
    }
</style>
