<script setup>
/**
 * Vue 3 最小接入示例：挂载阅读器，打开内置样例或本地 OFD 文件。
 */
import { onMounted, ref, shallowRef } from 'vue';
import { OFDViewer } from '@ofdrw/ofdrw-viewer-ui/vue';

/** 文档来源；二进制内容用 shallowRef，避免被 Vue 深度代理。 */
const source = shallowRef(null);
/** 加载失败时的提示。 */
const error = ref('');

/** 打开内置样例。 */
onMounted(async () => {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}samples/doc1File.ofd`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    source.value = await response.arrayBuffer();
  } catch (reason) {
    error.value = `样例加载失败：${reason instanceof Error ? reason.message : String(reason)}`;
  }
});

/**
 * 读取本地选择的 OFD 文件并替换当前文档。
 *
 * @param {Event} event 文件输入框的 change 事件。
 */
async function openFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  error.value = '';
  try {
    // 新的 ArrayBuffer 会触发阅读器打开新文档。
    source.value = await file.arrayBuffer();
  } catch (reason) {
    error.value = `文件读取失败：${reason instanceof Error ? reason.message : String(reason)}`;
  }
}
</script>

<template>
  <div class="app">
    <header>
      <strong>OFD 阅读器</strong>
      <label class="open">
        打开 OFD
        <input type="file" accept=".ofd,application/ofd" @change="openFile" />
      </label>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <main>
      <OFDViewer v-if="source" class="viewer" :source="source" />
      <p v-else class="loading">正在加载样例…</p>
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  border-bottom: 1px solid #dbe3ee;
  background: #fff;
}
.open {
  padding: 6px 12px;
  border: 1px solid #c7d2e0;
  border-radius: 6px;
  cursor: pointer;
}
.open input {
  display: none;
}
main {
  flex: 1;
  min-height: 0;
}
.viewer {
  height: 100%;
}
.loading,
.error {
  padding: 12px 16px;
}
.error {
  color: #b91c1c;
}
</style>