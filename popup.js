const state = {
  tabs: [],
  groups: [],
  sessions: [],
  settings: {
    priorityGroups: []
  },
  overview: {
    tabCount: 0,
    domainCount: 0,
    duplicateCount: 0,
    groupCount: 0
  },
  duplicateReview: {
    // 扫描结果作为确认快照保存，避免用户勾选期间因刷新状态改变待关闭范围。
    visible: false,
    groups: [],
    selectedGroupKeys: []
  },
  // 保存后只记录本次标签编号，用户明确点击后才关闭，避免保存动作变成隐式清场。
  lastSavedTabIds: [],
  query: ''
};

function sendMessage(action, payload = {}) {
  return chrome.runtime.sendMessage(Object.assign({ action }, payload)).then((response) => {
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : '操作失败');
    }

    return response.payload;
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  loadState();
});

async function loadState(options = {}) {
  setBusy(true);

  try {
    const data = await sendMessage('get-state');
    state.tabs = data.tabs || [];
    state.groups = data.groups || [];
    state.sessions = data.sessions || [];
    state.settings = data.settings || state.settings;
    state.overview = data.overview || state.overview;
    render();

    if (!options.keepStatus) {
      setStatus('已加载当前窗口标签页');
    }
  } catch (error) {
    setStatus(error.message || '读取标签页失败');
  } finally {
    setBusy(false);
  }
}

function bindEvents() {
  document.getElementById('organizeButton').addEventListener('click', () => runAction('organize-tabs'));
  document.getElementById('scanDuplicatesButton').addEventListener('click', scanDuplicates);
  document.getElementById('saveWorkspaceButton').addEventListener('click', saveWorkspace);
  document.getElementById('closeSelectedDuplicatesButton').addEventListener('click', closeSelectedDuplicates);
  document.getElementById('cancelDuplicateReviewButton').addEventListener('click', () => {
    state.duplicateReview.visible = false;
    state.duplicateReview.groups = [];
    state.duplicateReview.selectedGroupKeys = [];
    renderDuplicateReview();
  });
  document.getElementById('searchInput').addEventListener('input', (event) => {
    state.query = event.target.value.trim().toLowerCase();
    renderTabs();
  });
}

async function runAction(action, payload = {}) {
  setBusy(true);

  try {
    const result = await sendMessage(action, payload);
    setStatus(formatActionResult(action, result));

    // 操作后的刷新不能覆盖结果提示，否则用户看不到批量操作到底处理了多少标签。
    await loadState({ keepStatus: true });
  } catch (error) {
    setStatus(error.message || '操作失败');
  } finally {
    setBusy(false);
  }
}

async function scanDuplicates() {
  setBusy(true);

  try {
    const result = await sendMessage('scan-duplicates');
    state.duplicateReview.visible = true;
    state.duplicateReview.groups = result.groups || [];
    state.duplicateReview.selectedGroupKeys = state.duplicateReview.groups.map((group) => group.duplicateKey);
    renderDuplicateReview();

    if (state.duplicateReview.groups.length === 0) {
      setStatus('没有发现可关闭的重复标签');
    } else {
      const closeCount = state.duplicateReview.groups.reduce((total, group) => total + group.closeCount, 0);
      setStatus(`发现 ${closeCount} 个可关闭重复标签，请确认后关闭`);
    }
  } catch (error) {
    setStatus(error.message || '扫描重复标签失败');
  } finally {
    setBusy(false);
  }
}

async function closeSelectedDuplicates() {
  const selectedGroups = state.duplicateReview.groups.filter((group) => {
    return state.duplicateReview.selectedGroupKeys.includes(group.duplicateKey);
  });
  // 只关闭后台判定为可关闭的副本，保留标签由后台规则统一决定，前台不重复推断。
  const tabIds = selectedGroups.flatMap((group) => group.closeTabIds);

  if (tabIds.length === 0) {
    setStatus('没有勾选要关闭的重复标签');
    return;
  }

  setBusy(true);

  try {
    const result = await sendMessage('close-selected-duplicates', { tabIds });
    state.duplicateReview.visible = false;
    state.duplicateReview.groups = [];
    state.duplicateReview.selectedGroupKeys = [];
    setStatus(`已关闭 ${result.closedCount} 个重复标签，失败 ${result.failedCount || 0} 个`);
    await loadState({ keepStatus: true });
  } catch (error) {
    setStatus(error.message || '关闭重复标签失败');
  } finally {
    setBusy(false);
  }
}

async function saveWorkspace() {
  const defaultName = getDefaultWorkspaceName();
  const name = window.prompt('请输入工作集名称', defaultName);

  if (name === null) {
    setStatus('已取消保存工作集');
    return;
  }

  const trimmedName = name.trim();

  if (!trimmedName) {
    setStatus('工作集名称不能为空');
    return;
  }

  setBusy(true);

  try {
    const result = await sendMessage('save-workspace', { name: trimmedName });
    state.lastSavedTabIds = result.savedTabIds || [];
    setStatus(`已保存 ${result.savedCount} 个标签，可选择关闭已保存标签`);
    await loadState({ keepStatus: true });
  } catch (error) {
    setStatus(error.message || '保存工作集失败');
  } finally {
    setBusy(false);
  }
}

async function closeLastSavedTabs() {
  if (state.lastSavedTabIds.length === 0) {
    setStatus('没有可关闭的已保存标签');
    return;
  }

  setBusy(true);

  try {
    const result = await sendMessage('close-saved-tabs', { tabIds: state.lastSavedTabIds });
    state.lastSavedTabIds = [];
    setStatus(`已关闭 ${result.closedCount} 个已保存标签，失败 ${result.failedCount || 0} 个`);
    await loadState({ keepStatus: true });
  } catch (error) {
    setStatus(error.message || '关闭已保存标签失败');
  } finally {
    setBusy(false);
  }
}

function getDefaultWorkspaceName() {
  const now = new Date();
  const date = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(now);

  return `${date} 的工作集`;
}

function render() {
  renderOverview();
  renderGroups();
  renderDuplicateReview();
  renderTabs();
  renderSessions();
}

function renderOverview() {
  document.getElementById('tabCount').textContent = state.overview.tabCount;
  document.getElementById('domainCount').textContent = state.overview.domainCount;
  document.getElementById('duplicateCount').textContent = state.overview.duplicateCount;
  document.getElementById('groupCount').textContent = state.overview.groupCount;
  document.getElementById('summaryText').textContent = `当前窗口共有 ${state.overview.tabCount} 个标签页`;
}

function renderGroups() {
  const groupList = document.getElementById('groupList');
  groupList.innerHTML = '';

  if (state.groups.length === 0) {
    groupList.appendChild(createEmptyState('当前窗口还没有可整理的分组'));
    return;
  }

  state.groups.forEach((group) => {
    const item = document.createElement('article');
    item.className = 'group-item';
    item.innerHTML = `
      <div class="group-main">
        <span class="group-title" title="${escapeHtml(group.title)}">${escapeHtml(group.title)}</span>
        <span class="group-meta">${group.tabCount} 个标签${group.starred ? ' · 优先' : ''}</span>
      </div>
      <button
        class="star-button${group.starred ? ' is-active' : ''}"
        type="button"
        data-group-key="${escapeHtml(group.groupKey)}"
        title="${group.starred ? '取消优先' : '设为优先'}"
        aria-label="${group.starred ? '取消优先分组' : '设为优先分组'}"
      >${group.starred ? '★' : '☆'}</button>
    `;
    groupList.appendChild(item);
  });

  groupList.querySelectorAll('button[data-group-key]').forEach((button) => {
    button.addEventListener('click', () => {
      runAction('toggle-priority-group', { groupKey: button.dataset.groupKey });
    });
  });
}

function renderDuplicateReview() {
  const section = document.getElementById('duplicateReviewSection');
  const list = document.getElementById('duplicateReviewList');
  const totalCloseCount = state.duplicateReview.groups.reduce((total, group) => total + group.closeCount, 0);

  section.classList.toggle('is-hidden', !state.duplicateReview.visible);
  // 当前任务不修改样式文件，因此同步设置 hidden，确保确认区在样式补充前也不会误显示。
  section.hidden = !state.duplicateReview.visible;
  document.getElementById('duplicateReviewCount').textContent = `${totalCloseCount} 个可关闭`;
  list.innerHTML = '';

  if (!state.duplicateReview.visible) {
    return;
  }

  if (state.duplicateReview.groups.length === 0) {
    list.appendChild(createEmptyState('没有发现可关闭的重复标签'));
    return;
  }

  state.duplicateReview.groups.forEach((group) => {
    const checked = state.duplicateReview.selectedGroupKeys.includes(group.duplicateKey);
    const item = document.createElement('label');
    item.className = 'duplicate-review-item';
    item.innerHTML = `
      <input type="checkbox" data-duplicate-key="${escapeHtml(group.duplicateKey)}" ${checked ? 'checked' : ''}>
      <span class="duplicate-review-main">
        <strong title="${escapeHtml(group.title)}">${escapeHtml(group.title)}</strong>
        <span>${escapeHtml(group.groupKey)} · ${escapeHtml(group.reason)} · 关闭 ${group.closeCount} 个</span>
        <span title="${escapeHtml(group.keepUrl)}">保留：${escapeHtml(group.keepTitle)}</span>
      </span>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('input[data-duplicate-key]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const duplicateKey = checkbox.dataset.duplicateKey;

      if (checkbox.checked) {
        state.duplicateReview.selectedGroupKeys = Array.from(new Set([
          ...state.duplicateReview.selectedGroupKeys,
          duplicateKey
        ]));
      } else {
        state.duplicateReview.selectedGroupKeys = state.duplicateReview.selectedGroupKeys.filter((key) => key !== duplicateKey);
      }
    });
  });
}

function renderTabs() {
  const tabList = document.getElementById('tabList');
  const visibleTabs = getVisibleTabs();
  document.getElementById('visibleCount').textContent = `${visibleTabs.length} 个结果`;
  tabList.innerHTML = '';

  if (visibleTabs.length === 0) {
    tabList.appendChild(createEmptyState('没有匹配的标签页'));
    return;
  }

  visibleTabs.forEach((tab) => {
    const item = document.createElement('article');
    item.className = 'tab-item';
    item.innerHTML = `
      <div class="tab-row">
        <div class="tab-title" title="${escapeHtml(tab.title)}">${escapeHtml(tab.title)}</div>
        <div class="inline-actions">
          <button type="button" data-action="activate" data-tab-id="${tab.id}">切换</button>
          <button class="danger-button" type="button" data-action="close" data-tab-id="${tab.id}">关闭</button>
        </div>
      </div>
      <div class="tab-url" title="${escapeHtml(tab.url)}">${escapeHtml(tab.groupKey)} · ${escapeHtml(tab.url)}</div>
    `;
    tabList.appendChild(item);
  });

  tabList.querySelectorAll('button[data-action="activate"]').forEach((button) => {
    button.addEventListener('click', () => runAction('activate-tab', { tabId: Number(button.dataset.tabId) }));
  });

  tabList.querySelectorAll('button[data-action="close"]').forEach((button) => {
    button.addEventListener('click', () => runAction('close-tab', { tabId: Number(button.dataset.tabId) }));
  });
}

function renderSessions() {
  const sessionList = document.getElementById('sessionList');
  sessionList.innerHTML = '';

  if (state.lastSavedTabIds.length > 0) {
    const closeSavedButton = document.createElement('button');
    closeSavedButton.className = 'close-saved-button danger-button';
    closeSavedButton.type = 'button';
    closeSavedButton.textContent = '关闭已保存标签';
    closeSavedButton.addEventListener('click', closeLastSavedTabs);
    sessionList.appendChild(closeSavedButton);
  }

  if (state.sessions.length === 0) {
    sessionList.appendChild(createEmptyState('还没有保存过工作集'));
    return;
  }

  state.sessions.forEach((session) => {
    const item = document.createElement('article');
    item.className = 'session-item';
    item.innerHTML = `
      <div class="session-row">
        <div class="session-name" title="${escapeHtml(session.name)}">${session.favorite ? '★ ' : ''}${escapeHtml(session.name)}</div>
      </div>
      <div class="session-meta">${session.tabs.length} 个标签 · ${session.groups.length} 个分组 · ${formatTimestamp(session.createdAt)}</div>
      <div class="inline-actions session-actions">
        <button type="button" data-action="restore" data-session-id="${escapeHtml(session.id)}">恢复</button>
        <button type="button" data-action="restore-new-window" data-session-id="${escapeHtml(session.id)}">新窗口</button>
        <button type="button" data-action="rename" data-session-id="${escapeHtml(session.id)}">重命名</button>
        <button type="button" data-action="favorite" data-session-id="${escapeHtml(session.id)}">${session.favorite ? '取消收藏' : '收藏'}</button>
        <button class="danger-button" type="button" data-action="delete" data-session-id="${escapeHtml(session.id)}">删除</button>
      </div>
    `;
    sessionList.appendChild(item);
  });

  sessionList.querySelectorAll('button[data-session-id]').forEach((button) => {
    button.addEventListener('click', () => handleWorkspaceAction(button.dataset.action, button.dataset.sessionId));
  });
}

async function handleWorkspaceAction(action, sessionId) {
  if (action === 'restore') {
    await runAction('restore-workspace', { workspaceId: sessionId });
    return;
  }

  if (action === 'restore-new-window') {
    await runAction('restore-workspace-new-window', { workspaceId: sessionId });
    return;
  }

  if (action === 'rename') {
    const session = state.sessions.find((item) => item.id === sessionId);
    const name = window.prompt('请输入新的工作集名称', session ? session.name : '');

    if (name === null) {
      setStatus('已取消重命名');
      return;
    }

    await runAction('rename-workspace', { workspaceId: sessionId, name });
    return;
  }

  if (action === 'favorite') {
    await runAction('toggle-workspace-favorite', { workspaceId: sessionId });
    return;
  }

  if (action === 'delete') {
    const shouldDelete = window.confirm('删除后无法恢复，确定删除这个工作集吗？');

    if (!shouldDelete) {
      setStatus('已取消删除工作集');
      return;
    }

    await runAction('delete-workspace', { workspaceId: sessionId });
  }
}

function formatTimestamp(timestamp) {
  if (!timestamp) {
    return '时间未知';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function getVisibleTabs() {
  if (!state.query) {
    return state.tabs;
  }

  return state.tabs.filter((tab) => {
    const searchable = `${tab.title} ${tab.url} ${tab.groupKey}`.toLowerCase();
    return searchable.includes(state.query);
  });
}

function createEmptyState(text) {
  const element = document.createElement('div');
  element.className = 'empty-state';
  element.textContent = text;
  return element;
}

function setBusy(isBusy) {
  document.querySelectorAll('button').forEach((button) => {
    button.disabled = isBusy;
  });
}

function setStatus(text) {
  document.getElementById('statusText').textContent = text;
}

function formatActionResult(action, result) {
  if (action === 'organize-tabs') {
    return `已整理 ${result.organizedCount} 个标签，创建 ${result.groupCount} 个分组`;
  }

  if (action === 'close-duplicates') {
    return `已关闭 ${result.closedCount} 个重复标签`;
  }

  if (action === 'save-session' || action === 'save-workspace') {
    return `已保存 ${result.savedCount} 个标签`;
  }

  if (action === 'restore-session' || action === 'restore-workspace' || action === 'restore-workspace-new-window') {
    return `已恢复 ${result.restoredCount} 个标签，跳过 ${result.failedCount} 个无法恢复的页面`;
  }

  if (action === 'rename-workspace') {
    return '已重命名工作集';
  }

  if (action === 'delete-workspace') {
    return '已删除工作集';
  }

  if (action === 'toggle-workspace-favorite') {
    return result.favorite ? '已收藏工作集' : '已取消收藏工作集';
  }

  if (action === 'toggle-priority-group') {
    return result.starred ? `已将 ${result.groupKey} 设为优先分组` : `已取消 ${result.groupKey} 的优先分组`;
  }

  if (action === 'activate-tab') {
    return '已切换到目标标签';
  }

  if (action === 'close-tab') {
    return '已关闭标签';
  }

  return '操作已完成';
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
