<script setup>
/**
 * Vue 3 最小接入示例。
 *
 * 关键约束：
 * - `source` 使用 `shallowRef`，避免 ArrayBuffer 被深度响应式代理；
 * - 切换文档只替换 `source`，由 Vue 适配器内部调用阅读器的 `open()`；
 * - 只监听适配器声明的 kebab-case 事件（`ready`、`page-change`、
 *   `document-open`、`error`）。
 */
import { onMounted, ref, shallowRef } from 'vue';
import { OFDViewer } from '@ofdrw/ofdrw-viewer-ui/vue';

/** 默认内置样例（11 页，内嵌字体）。 */
const DEFAULT_SAMPLE = 'doc1File.ofd';
/** 备用内置样例（2 页密集文本，内嵌字体）。 */
const DENSE_SAMPLE = 'dense-text-perf.ofd';

/** 文档来源；必须用 shallowRef，避免二进制内容被 Vue 深度代理。 */
const source = shallowRef(null);
/** 当前文档显示名。 */
const fileName = ref('');
/** 当前页码，1-based。 */
const currentPage = ref(1);
/** 文档总页数；打开完成前为 0。 */
const pageCount = ref(0);
/** 是否已收到阅读器 ready 事件。 */
const isReady = ref(false);
/** 样例下载或文件读取中；初始即为 true，等待默认样例加载。 */
const loading = ref(true);
/** 界面错误提示。 */
const errorMessage = ref('');
/** 原生文件输入框引用。 */
const fileInput = ref(null);

/**
 * 打开内置样例。每次重新 fetch 成 ArrayBuffer，既保证“重新打开”可用，也避免
 * 复用已被阅读器消费过的 ArrayBuffer。
 *
 * @param {string} sampleFileName 样例文件名，默认 `doc1File.ofd`。
 * @returns {Promise<void>} 无返回值；失败时写入 `errorMessage`。
 */
async function openSample(sampleFileName = DEFAULT_SAMPLE) {
  loading.value = true;
  errorMessage.value = '';

  try {
    const url = `${import.meta.env.BASE_URL}samples/${sampleFileName}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    // 直接替换 source，适配器会调用阅读器的 open() 完成切换。
    source.value = await response.arrayBuffer();
    fileName.value = sampleFileName;
    currentPage.value = 1;
    pageCount.value = 0;
  } catch (error) {
    errorMessage.value = `加载内置样例失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    loading.value = false;
  }
}

/** 触发隐藏的文件选择框。 */
function pickFile() {
  fileInput.value?.click();
}

/**
 * 读取用户选择的 OFD 文件并替换当前文档。
 *
 * @param {Event} event 原生 change 事件。
 * @returns {Promise<void>} 无返回值；读取失败时写入 `errorMessage`。
 */
async function onFileChange(event) {
  const input = event.target;
  const file = input.files?.[0];
  // 重置 value，保证再次选择同一个文件也能触发 change。
  input.value = '';
  if (!file) return;

  loading.value = true;
  errorMessage.value = '';

  try {
    source.value = await file.arrayBuffer();
    fileName.value = file.name;
    currentPage.value = 1;
    pageCount.value = 0;
  } catch (error) {
    errorMessage.value = `读取文件失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    loading.value = false;
  }
}

/** 阅读器完成首次打开。 */
function onReady() {
  isReady.value = true;
  errorMessage.value = '';
}

/**
 * 每次文档打开完成后更新总页数。
 *
 * @param {{ pageCount?: number }} payload 事件载荷；`pageCount` 为总页数。
 */
function onDocumentOpen(payload) {
  isReady.value = true;
  pageCount.value = payload?.pageCount ?? 0;
  errorMessage.value = '';
}

/**
 * 同步当前页码。
 *
 * @param {{ pageNumber?: number }} payload 事件载荷；`pageNumber` 为 1-based 页码。
 */
function onPageChange(payload) {
  if (payload?.pageNumber) currentPage.value = payload.pageNumber;
}

/**
 * 同步阅读器状态快照中的页码与总页数。
 *
 * 工具栏触发的程序化跳页只更新内部视图状态，不一定再次发出 `page-change`，
 * 因此外层状态栏同时监听 `state-change`。
 *
 * @param {{ view?: { pageNumber?: number }, document?: { pageCount?: number } }} state
 *   阅读器状态快照。
 */
function onStateChange(state) {
  if (state?.view?.pageNumber) currentPage.value = state.view.pageNumber;
  if (typeof state?.document?.pageCount === 'number') {
    pageCount.value = state.document.pageCount;
  }
}

/**
 * 展示阅读器上报的错误；阅读器仍会保留自身工具栏，错误在此处汇总提示。
 *
 * @param {{ code?: string, message?: string }} payload 错误载荷。
 */
function onError(payload) {
  const detail = payload?.message ?? '未知错误';
  errorMessage.value = payload?.code ? `${payload.code}：${detail}` : detail;
}

// 页面加载后自动打开默认样例。
onMounted(() => {
  void openSample();
});
</script>

<template>
  <div class="app">
    <header class="toolbar">
      <div class="brand">
        <span class="brand-title">OFD 阅读器</span>
        <span class="brand-sub">Vue 3 最小接入</span>
      </div>

      <div class="actions">
        <input
          ref="fileInput"
          class="file-input"
          type="file"
          accept=".ofd,application/ofd"
          @change="onFileChange"
        />
        <button type="button" class="button button-primary" :disabled="loading" @click="pickFile">
          选择 OFD 文件
        </button>
        <button
          type="button"
          class="button"
          :disabled="loading"
          @click="openSample(DEFAULT_SAMPLE)"
        >
          重新打开样例
        </button>
        <button
          type="button"
          class="button"
          :disabled="loading"
          @click="openSample(DENSE_SAMPLE)"
        >
          密集文本样例
        </button>
      </div>

      <div class="status">
        <span class="viewer-state" :class="{ ready: isReady && !loading }">
          {{ loading ? '加载中' : isReady ? '阅读器已就绪' : '初始化中' }}
        </span>
        <span class="file-name" :title="fileName">{{ fileName || '未加载文档' }}</span>
        <span class="page-info">
          第 {{ currentPage }} 页<template v-if="pageCount"> / 共 {{ pageCount }} 页</template>
        </span>
      </div>
    </header>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

    <main class="viewer-wrap">
      <OFDViewer
        v-if="source"
        :source="source"
        @ready="onReady"
        @document-open="onDocumentOpen"
        @page-change="onPageChange"
        @state-change="onStateChange"
        @error="onError"
      />
      <p v-else class="placeholder">
        {{ loading ? '正在加载内置样例…' : '暂无可显示的文档' }}
      </p>
    </main>
  </div>
</template>