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
  document.getElementById('closeDuplicatesButton').addEventListener('click', () => runAction('close-duplicates'));
  document.getElementById('saveSessionButton').addEventListener('click', () => runAction('save-session'));
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

function render() {
  renderOverview();
  renderGroups();
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

  if (state.sessions.length === 0) {
    sessionList.appendChild(createEmptyState('还没有保存过会话'));
    return;
  }

  state.sessions.forEach((session) => {
    const item = document.createElement('article');
    item.className = 'session-item';
    item.innerHTML = `
      <div class="session-row">
        <div class="session-name" title="${escapeHtml(session.name)}">${escapeHtml(session.name)}</div>
        <div class="inline-actions">
          <button type="button" data-session-id="${escapeHtml(session.id)}">恢复</button>
        </div>
      </div>
      <div class="session-meta">${session.tabs.length} 个标签 · ${session.groups.length} 个分组</div>
    `;
    sessionList.appendChild(item);
  });

  sessionList.querySelectorAll('button[data-session-id]').forEach((button) => {
    button.addEventListener('click', () => {
      runAction('restore-session', { sessionId: button.dataset.sessionId });
    });
  });
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

  if (action === 'save-session') {
    return `已保存 ${result.savedCount} 个标签`;
  }

  if (action === 'restore-session') {
    return `已恢复 ${result.restoredCount} 个标签，跳过 ${result.failedCount} 个无法恢复的页面`;
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
