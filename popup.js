const state = {
  tabs: [],
  recentlyClosedTabs: [],
  groups: [],
  sessions: [],
  settings: {
    minTabsPerGroup: 2,
    priorityGroups: [],
    groupRules: []
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
  query: '',
  selectedIndex: 0,
  moreToolsVisible: false,
  recentlyClosedTabsLoaded: false,
  recentlyClosedTabsLoading: false,
  managementLoaded: false,
  managementLoading: false,
  duplicateOverviewScheduled: false,
  sortHelpVisible: false,
  ruleEditor: {
    // 表单状态放在前端本地，原因是未保存草稿不应污染 chrome.storage。
    visible: false,
    editingRuleId: '',
    draft: null
  }
};

// 默认态只渲染最近 30 条，原因是首开弹窗要快；更多页面可通过搜索直接定位。
const DEFAULT_RECENT_RESULT_LIMIT = 30;
// 搜索结果最多渲染 100 条，原因是弹窗空间有限，过多 DOM 会影响键盘选择响应。
const SEARCH_RESULT_LIMIT = 100;
const POPUP_STORAGE_KEYS = {
  settings: 'tabgod.settings',
  recentAccess: 'tabgod.recentAccess'
};

function sendMessage(action, payload = {}) {
  return chrome.runtime.sendMessage(Object.assign({ action }, payload)).then((response) => {
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : '操作失败');
    }

    return response.payload;
  });
}

function normalizePopupSettings(settings) {
  const normalizedSettings = Object.assign({}, state.settings, settings || {});

  if (!Number.isInteger(normalizedSettings.minTabsPerGroup) || normalizedSettings.minTabsPerGroup < 1) {
    // 弹窗首屏只需要展示阈值，非法配置回落到默认值可以避免设置输入框显示异常。
    normalizedSettings.minTabsPerGroup = state.settings.minTabsPerGroup;
  }

  if (!Array.isArray(normalizedSettings.priorityGroups)) {
    normalizedSettings.priorityGroups = [];
  }

  if (!Array.isArray(normalizedSettings.groupRules)) {
    normalizedSettings.groupRules = [];
  }

  return normalizedSettings;
}

function getPopupTabUrl(tab) {
  return String((tab && (tab.url || tab.pendingUrl)) || '');
}

function getPopupGroupKey(url) {
  try {
    const parsedUrl = new URL(url);
    const hostname = String(parsedUrl.hostname || '').toLowerCase().replace(/\.$/, '');

    return hostname || '其他';
  } catch (error) {
    // 首屏本地路径只做搜索展示，异常地址归为“其他”即可，完整分组规则仍由后台处理。
    return '其他';
  }
}

function getPopupLastAccessedAt(tab, recentAccessMap) {
  if (Number.isFinite(tab && tab.lastAccessed)) {
    return tab.lastAccessed;
  }

  const storedAccessedAt = recentAccessMap && Number(recentAccessMap[String(tab && tab.id)]);

  return Number.isFinite(storedAccessedAt) ? storedAccessedAt : 0;
}

function buildPopupTabSnapshots(tabs, context = {}) {
  const currentWindowId = Number.isInteger(context.currentWindowId) ? context.currentWindowId : null;
  const recentAccessMap = context.recentAccessMap || {};

  return (Array.isArray(tabs) ? tabs : []).map((tab) => {
    const url = getPopupTabUrl(tab);
    const groupKey = getPopupGroupKey(url);
    const isCurrentWindow = Number.isInteger(tab.windowId) && tab.windowId === currentWindowId;

    return {
      id: tab.id,
      title: tab.title || '未命名标签',
      url,
      favIconUrl: tab.favIconUrl || '',
      active: Boolean(tab.active),
      pinned: Boolean(tab.pinned),
      index: Number.isInteger(tab.index) ? tab.index : 0,
      groupKey,
      groupTitle: groupKey,
      windowId: Number.isInteger(tab.windowId) ? tab.windowId : null,
      isCurrentWindow,
      windowLabel: isCurrentWindow ? '当前窗口' : '其他窗口',
      lastAccessedAt: getPopupLastAccessedAt(tab, recentAccessMap)
    };
  });
}

function buildPopupOverview(currentTabs, allTabs) {
  const domainSet = new Set();
  const groupSet = new Set();

  (Array.isArray(currentTabs) ? currentTabs : []).forEach((tab) => {
    domainSet.add(getPopupGroupKey(getPopupTabUrl(tab)));

    if (typeof tab.groupId === 'number' && tab.groupId >= 0) {
      groupSet.add(tab.groupId);
    }
  });

  const windowCount = new Set((Array.isArray(allTabs) ? allTabs : [])
    .map((tab) => tab.windowId)
    .filter((windowId) => Number.isInteger(windowId))).size;

  return {
    tabCount: Array.isArray(currentTabs) ? currentTabs.length : 0,
    domainCount: domainSet.size,
    duplicateCount: null,
    groupCount: groupSet.size,
    allTabCount: Array.isArray(allTabs) ? allTabs.length : 0,
    windowCount
  };
}

async function loadPopupStateFromBrowser() {
  const [currentTabs, allTabs, stored] = await Promise.all([
    chrome.tabs.query({ currentWindow: true }),
    chrome.tabs.query({}),
    chrome.storage.local.get([
      POPUP_STORAGE_KEYS.settings,
      POPUP_STORAGE_KEYS.recentAccess
    ])
  ]);
  const activeTab = currentTabs.find((tab) => tab.active);
  const currentWindowId = activeTab && Number.isInteger(activeTab.windowId) ? activeTab.windowId : null;
  const settings = normalizePopupSettings(stored[POPUP_STORAGE_KEYS.settings]);
  const recentAccessMap = stored[POPUP_STORAGE_KEYS.recentAccess] || {};

  return {
    tabs: buildPopupTabSnapshots(allTabs, { currentWindowId, recentAccessMap }),
    recentlyClosedTabs: [],
    groups: [],
    overview: buildPopupOverview(currentTabs, allTabs),
    sessions: [],
    settings,
    currentWindowId
  };
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  loadState();
});

async function loadState(options = {}) {
  setBusy(true);

  try {
    const data = await loadPopupStateFromBrowser();
    state.tabs = data.tabs || [];

    if (!state.managementLoaded) {
      state.groups = data.groups || [];
      state.sessions = data.sessions || [];
    }

    state.settings = data.settings || state.settings;
    state.overview = data.overview || state.overview;
    state.selectedIndex = clampSelectedIndex(state.selectedIndex, getVisibleTabsFromState(state).length);
    render();

    if (options.keepMoreToolsFocus) {
      focusMoreTools();
    } else {
      focusSearchInput();
    }

    if (!options.keepStatus) {
      setStatus('已加载标签页');
    }

    if (state.moreToolsVisible) {
      await loadManagementState({ skipBusy: true, keepStatus: true });
    }

    if (!options.skipDuplicateOverview) {
      scheduleDuplicateOverviewLoad();
    }
  } catch (error) {
    setStatus(error.message || '读取标签页失败');
  } finally {
    setBusy(false);
  }
}

function scheduleDuplicateOverviewLoad() {
  if (state.duplicateOverviewScheduled) {
    return;
  }

  state.duplicateOverviewScheduled = true;
  const run = () => {
    state.duplicateOverviewScheduled = false;
    loadDuplicateOverview();
  };

  if (typeof window.requestIdleCallback === 'function') {
    // 最多等半秒是为了避免弹窗生命周期太短时一直等不到空闲回调。
    window.requestIdleCallback(run, { timeout: 500 });
    return;
  }

  window.setTimeout(run, 0);
}

async function loadRecentlyClosedTabs() {
  if (state.recentlyClosedTabsLoaded || state.recentlyClosedTabsLoading) {
    return;
  }

  state.recentlyClosedTabsLoading = true;

  try {
    const data = await sendMessage('get-recently-closed-tabs');
    state.recentlyClosedTabs = data.recentlyClosedTabs || [];
    state.recentlyClosedTabsLoaded = true;
    renderTabs();
  } catch (error) {
    // 最近关闭只是搜索增强，失败时保持已打开标签搜索可用，避免把慢路径变成主路径错误。
    state.recentlyClosedTabs = [];
    state.recentlyClosedTabsLoaded = true;
  } finally {
    state.recentlyClosedTabsLoading = false;
  }
}

async function loadManagementState(options = {}) {
  if (state.managementLoading) {
    return;
  }

  state.managementLoading = true;

  if (!options.skipBusy) {
    setBusy(true);
  }

  try {
    const data = await sendMessage('get-management-state');
    state.groups = data.groups || [];
    state.sessions = data.sessions || [];
    state.settings = data.settings || state.settings;
    state.managementLoaded = true;
    renderSettings();
    renderGroupRules();
    renderGroupRuleForm();
    renderGroups();
    renderSessions();
    renderMoreTools();
  } catch (error) {
    if (!options.keepStatus) {
      setStatus(error.message || '读取高级管理失败');
    }
  } finally {
    state.managementLoading = false;

    if (!options.skipBusy) {
      setBusy(false);
    }
  }
}

async function loadDuplicateOverview() {
  try {
    const data = await sendMessage('get-duplicate-overview');
    state.overview = Object.assign({}, state.overview, {
      duplicateCount: Number(data.duplicateCount) || 0
    });
    renderOverview();
  } catch (error) {
    // 重复数量只用于轻提示，失败不应该影响一键整理主路径。
    document.getElementById('duplicateHintText').textContent = '';
  }
}

function bindEvents() {
  document.getElementById('organizeButton').addEventListener('click', () => runAction('organize-tabs'));
  document.getElementById('scanDuplicatesButton').addEventListener('click', scanDuplicates);
  document.getElementById('saveWorkspaceButton').addEventListener('click', saveWorkspace);
  document.getElementById('saveGroupThresholdButton').addEventListener('click', saveGroupThreshold);
  document.getElementById('closeSelectedDuplicatesButton').addEventListener('click', closeSelectedDuplicates);
  document.getElementById('cancelDuplicateReviewButton').addEventListener('click', () => {
    state.duplicateReview.visible = false;
    state.duplicateReview.groups = [];
    state.duplicateReview.selectedGroupKeys = [];
    renderDuplicateReview();
  });
  document.getElementById('searchInput').addEventListener('input', (event) => {
    state.query = event.target.value.trim().toLowerCase();
    state.selectedIndex = 0;
    renderOverview();
    renderTabs();
    if (state.query) {
      loadRecentlyClosedTabs();
    }
  });
  document.getElementById('searchInput').addEventListener('keydown', handleSearchKeydown);
  document.getElementById('sortHelpButton').addEventListener('click', toggleSortHelp);
  document.getElementById('moreToolsButton').addEventListener('click', toggleMoreTools);
  document.getElementById('newGroupRuleButton').addEventListener('click', openNewGroupRuleForm);
  document.getElementById('groupRuleForm').addEventListener('submit', saveGroupRule);
  document.getElementById('cancelGroupRuleButton').addEventListener('click', closeGroupRuleForm);
  document.getElementById('addRuleConditionButton').addEventListener('click', addRuleCondition);
  document.getElementById('addRuleGroupButton').addEventListener('click', addRuleConditionGroup);
  document.getElementById('groupRuleNameInput').addEventListener('input', updateRuleDraftFromForm);
  document.getElementById('groupRuleTargetTitleInput').addEventListener('input', updateRuleDraftFromForm);
  document.getElementById('groupRuleThresholdInput').addEventListener('input', updateRuleDraftFromForm);
  document.getElementById('groupRuleEnabledInput').addEventListener('change', updateRuleDraftFromForm);
}

async function runAction(action, payload = {}, options = {}) {
  setBusy(true);

  try {
    const result = await sendMessage(action, payload);
    setStatus(formatActionResult(action, result));

    if (options.refresh !== false) {
      // 操作后的刷新不能覆盖结果提示，否则用户看不到批量操作到底处理了多少标签。
      await loadState(Object.assign({ keepStatus: true }, options.loadStateOptions || {}));
    }
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
    state.moreToolsVisible = true;
    state.duplicateReview.visible = true;
    state.duplicateReview.groups = result.groups || [];
    state.duplicateReview.selectedGroupKeys = state.duplicateReview.groups.map((group) => group.duplicateKey);
    renderMoreTools();
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
    state.moreToolsVisible = true;
    await loadState({ keepStatus: true, keepMoreToolsFocus: true });
  } catch (error) {
    setStatus(error.message || '关闭重复标签失败');
  } finally {
    setBusy(false);
  }
}

async function openSearchResult(result) {
  if (!result) {
    setStatus('没有可打开的标签页');
    return;
  }

  if (result.resultType === 'recentlyClosed') {
    if (!result.sessionId) {
      setStatus('历史标签无效');
      return;
    }

    await runAction('restore-closed-session', { sessionId: result.sessionId });
    return;
  }

  if (!Number.isInteger(result.id)) {
    setStatus('目标标签无效');
    return;
  }

  await runAction('activate-tab', { tabId: result.id });
}

function handleSearchKeydown(event) {
  const visibleTabs = getVisibleTabs();

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    state.selectedIndex = clampSelectedIndex(state.selectedIndex + 1, visibleTabs.length);
    renderTabs();
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    state.selectedIndex = clampSelectedIndex(state.selectedIndex - 1, visibleTabs.length);
    renderTabs();
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    const selectedTab = visibleTabs[clampSelectedIndex(state.selectedIndex, visibleTabs.length)];

    if (!selectedTab) {
      setStatus('没有可切换的标签页');
      return;
    }

    openSearchResult(selectedTab);
  }
}

async function toggleMoreTools() {
  state.moreToolsVisible = !state.moreToolsVisible;
  renderMoreTools();

  if (state.moreToolsVisible && !state.managementLoaded) {
    await loadManagementState();
    focusMoreTools();
  }
}

function toggleSortHelp() {
  state.sortHelpVisible = !state.sortHelpVisible;
  renderSortHelp();
}

function getSortHelpText(query = state.query) {
  if (!query) {
    return '最近使用按页面最近激活时间排序，当前窗口正在看的页面不会占用列表位置。';
  }

  return '搜索排序按综合分计算：标题完全匹配 +400，标题包含 +300，分组名或主域名包含 +220，网址包含 +100；最近 1 分钟 +260，10 分钟内 +180，1 小时内 +100。同分时已打开标签优先，再按最近使用或关闭时间排序。';
}

function renderSortHelp() {
  const button = document.getElementById('sortHelpButton');
  const helpText = document.getElementById('sortHelpText');

  button.setAttribute('aria-expanded', state.sortHelpVisible ? 'true' : 'false');
  helpText.textContent = getSortHelpText(state.query);
  helpText.classList.toggle('is-hidden', !state.sortHelpVisible);
  helpText.hidden = !state.sortHelpVisible;
}

function renderMoreTools() {
  const section = document.getElementById('moreToolsSection');
  const button = document.getElementById('moreToolsButton');

  section.classList.toggle('is-hidden', !state.moreToolsVisible);
  section.hidden = !state.moreToolsVisible;
  button.textContent = state.moreToolsVisible ? '收起高级管理' : '高级管理';
  button.setAttribute('aria-expanded', state.moreToolsVisible ? 'true' : 'false');

  if (state.moreToolsVisible && typeof section.scrollIntoView === 'function') {
    // 高级管理在结果列表下方，展开后滚入视野，避免用户误以为点击没有反应。
    section.scrollIntoView({ block: 'nearest' });
  }
}

function focusMoreTools() {
  const section = document.getElementById('moreToolsSection');
  const button = document.getElementById('moreToolsButton');

  if (typeof button.focus === 'function') {
    // 高级管理内操作刷新后保留焦点，避免用户刚完成动作就被带回顶部主入口。
    button.focus();
  }

  if (state.moreToolsVisible && section && typeof section.scrollIntoView === 'function') {
    section.scrollIntoView({ block: 'nearest' });
  }
}

async function saveGroupThreshold() {
  const input = document.getElementById('minTabsPerGroupInput');
  const minTabsPerGroup = Number(input.value);

  if (!Number.isInteger(minTabsPerGroup) || minTabsPerGroup < 1) {
    setStatus('分组阈值必须是不小于 1 的整数');
    return;
  }

  setBusy(true);

  try {
    const result = await sendMessage('update-settings', {
      settings: { minTabsPerGroup }
    });
    state.settings = result.settings || state.settings;
    setStatus(`已保存分组阈值：至少 ${state.settings.minTabsPerGroup} 个标签，已重新梳理当前窗口分组`);
    await loadState({ keepStatus: true, keepMoreToolsFocus: true });
  } catch (error) {
    setStatus(error.message || '保存分组阈值失败');
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
    state.moreToolsVisible = true;
    setStatus(`已保存 ${result.savedCount} 个标签，可选择关闭已保存标签`);
    await loadState({ keepStatus: true, keepMoreToolsFocus: true });
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
    await loadState({ keepStatus: true, keepMoreToolsFocus: true });
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
  renderSettings();
  renderOverview();
  if (state.moreToolsVisible || state.managementLoaded) {
    renderGroupRules();
    renderGroupRuleForm();
    renderGroups();
    renderSessions();
  }
  renderDuplicateReview();
  renderTabs();
  renderMoreTools();
}

function focusSearchInput() {
  const searchInput = document.getElementById('searchInput');

  if (searchInput && typeof searchInput.focus === 'function') {
    // 弹窗打开后通常先找已有页面，自动聚焦可以减少一次无意义点击。
    searchInput.focus();
  }
}

function renderSettings() {
  document.getElementById('minTabsPerGroupInput').value = state.settings.minTabsPerGroup || 2;
}

function createDefaultCondition() {
  return {
    type: 'condition',
    field: 'hostname',
    operator: 'contains',
    value: ''
  };
}

function createDefaultConditionGroup(logic = 'and') {
  return {
    type: 'group',
    logic,
    children: [createDefaultCondition()]
  };
}

function createDefaultGroupRuleDraft() {
  return {
    name: '',
    enabled: true,
    targetTitle: '',
    minTabsPerGroup: null,
    conditionTree: createDefaultConditionGroup('and')
  };
}

function formatGroupRuleThresholdText(minTabsPerGroup, globalMinTabsPerGroup) {
  const globalThreshold = Number(globalMinTabsPerGroup) || 2;

  if (!Number.isInteger(minTabsPerGroup) || minTabsPerGroup < 1) {
    return `使用全局阈值：至少 ${globalThreshold} 个标签`;
  }

  return `规则阈值：至少 ${minTabsPerGroup} 个标签`;
}

function formatGroupRuleCondition(condition) {
  const fieldLabelMap = {
    hostname: '域名',
    primaryDomain: '主域名',
    path: '路径',
    url: '网址',
    title: '标题'
  };
  const operatorLabelMap = {
    contains: '包含',
    equals: '等于',
    startsWith: '开头是'
  };

  return `${fieldLabelMap[condition.field] || condition.field}${operatorLabelMap[condition.operator] || condition.operator} ${condition.value || '未填写'}`;
}

function formatConditionTreeSummary(node) {
  if (!node) {
    return '未配置条件';
  }

  if (node.type === 'condition') {
    return formatGroupRuleCondition(node);
  }

  const separator = node.logic === 'or' ? ' 或 ' : ' 且 ';
  return (node.children || []).map(formatConditionTreeSummary).join(separator);
}

function countDraftConditions(node) {
  if (!node) {
    return 0;
  }

  if (node.type === 'condition') {
    return 1;
  }

  return (node.children || []).reduce((total, child) => total + countDraftConditions(child), 0);
}

function formatGroupRuleSummary(rule) {
  const conditionText = formatConditionTreeSummary(rule.conditionTree);
  const thresholdText = formatGroupRuleThresholdText(rule.minTabsPerGroup, state.settings.minTabsPerGroup);
  const enabledText = rule.enabled ? '已启用' : '已停用，不参与匹配';

  return `${conditionText} · ${thresholdText} · ${enabledText}`;
}

function renderOverview() {
  const allTabCount = state.overview.allTabCount || state.overview.tabCount || 0;
  const windowCount = state.overview.windowCount || 1;
  const duplicateCount = state.overview.duplicateCount;

  document.getElementById('quickStatusText').textContent = `${allTabCount} 个标签 · ${windowCount} 个窗口`;
  document.getElementById('duplicateHintText').textContent = Number.isFinite(duplicateCount) && duplicateCount > 0 ? `${duplicateCount} 个重复` : '';
  document.getElementById('summaryText').textContent = state.query ? '搜索所有已打开标签' : '搜索切换，或一键整理当前窗口';
}

function renderGroupRules() {
  const list = document.getElementById('groupRuleList');
  const rules = state.settings.groupRules || [];
  list.innerHTML = '';

  if (rules.length === 0) {
    list.appendChild(createEmptyState('还没有自定义分组规则'));
    return;
  }

  rules.forEach((rule, index) => {
    const item = document.createElement('article');
    const ruleSummary = formatGroupRuleSummary(rule);
    item.className = `group-rule-item${rule.enabled ? '' : ' is-disabled'}`;
    item.innerHTML = `
      <div class="group-rule-main">
        <strong title="${escapeHtml(rule.name)}">${escapeHtml(rule.name)}</strong>
        <span title="${escapeHtml(rule.targetTitle)}">归入：${escapeHtml(rule.targetTitle)}</span>
        <span title="${escapeHtml(ruleSummary)}">${escapeHtml(ruleSummary)}</span>
      </div>
      <div class="inline-actions group-rule-actions">
        <button type="button" data-action="toggle-rule" data-rule-id="${escapeHtml(rule.id)}">${rule.enabled ? '停用' : '启用'}</button>
        <button type="button" data-action="move-rule-up" data-rule-id="${escapeHtml(rule.id)}" data-static-disabled="${index === 0 ? 'true' : 'false'}" ${index === 0 ? 'disabled' : ''}>上移</button>
        <button type="button" data-action="move-rule-down" data-rule-id="${escapeHtml(rule.id)}" data-static-disabled="${index === rules.length - 1 ? 'true' : 'false'}" ${index === rules.length - 1 ? 'disabled' : ''}>下移</button>
        <button type="button" data-action="edit-rule" data-rule-id="${escapeHtml(rule.id)}">编辑</button>
        <button class="danger-button" type="button" data-action="delete-rule" data-rule-id="${escapeHtml(rule.id)}">删除</button>
      </div>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('button[data-rule-id]').forEach((button) => {
    button.addEventListener('click', () => handleGroupRuleAction(button.dataset.action, button.dataset.ruleId));
  });
}

function renderConditionGroup(group, path = []) {
  const isChildGroup = path.length > 0;
  const container = document.createElement('div');
  container.className = `condition-group${isChildGroup ? ' condition-group-child' : ''}`;
  container.innerHTML = `
    <div class="condition-group-header">
      <span>${isChildGroup ? '子条件组' : '顶层条件组'}</span>
      <select data-condition-path="${path.join('.')}" data-condition-action="logic">
        <option value="and" ${group.logic === 'and' ? 'selected' : ''}>满足全部</option>
        <option value="or" ${group.logic === 'or' ? 'selected' : ''}>满足任一</option>
      </select>
    </div>
  `;

  (group.children || []).forEach((child, index) => {
    const childPath = [...path, index];

    if (child.type === 'group') {
      container.appendChild(renderConditionGroup(child, childPath));
      return;
    }

    const row = document.createElement('div');
    row.className = 'condition-row';
    row.innerHTML = `
      <select data-condition-path="${childPath.join('.')}" data-condition-field="field">
        <option value="hostname" ${child.field === 'hostname' ? 'selected' : ''}>域名</option>
        <option value="primaryDomain" ${child.field === 'primaryDomain' ? 'selected' : ''}>主域名</option>
        <option value="path" ${child.field === 'path' ? 'selected' : ''}>路径</option>
        <option value="url" ${child.field === 'url' ? 'selected' : ''}>网址</option>
        <option value="title" ${child.field === 'title' ? 'selected' : ''}>标题</option>
      </select>
      <select data-condition-path="${childPath.join('.')}" data-condition-field="operator">
        <option value="contains" ${child.operator === 'contains' ? 'selected' : ''}>包含</option>
        <option value="equals" ${child.operator === 'equals' ? 'selected' : ''}>等于</option>
        <option value="startsWith" ${child.operator === 'startsWith' ? 'selected' : ''}>开头是</option>
      </select>
      <input type="text" data-condition-path="${childPath.join('.')}" data-condition-field="value" value="${escapeHtml(child.value || '')}" placeholder="必须填写匹配内容">
      <button type="button" data-remove-condition-path="${childPath.join('.')}">删除</button>
    `;
    container.appendChild(row);
  });

  if (isChildGroup) {
    const actions = document.createElement('div');
    actions.className = 'inline-actions condition-group-actions';
    actions.innerHTML = `
      <button type="button" data-add-condition-path="${path.join('.')}">添加条件</button>
      <button class="danger-button" type="button" data-remove-condition-path="${path.join('.')}">删除条件组</button>
    `;
    container.appendChild(actions);
  }

  return container;
}

function renderGroupRuleForm() {
  const form = document.getElementById('groupRuleForm');
  const draft = state.ruleEditor.draft || createDefaultGroupRuleDraft();
  const conditionList = document.getElementById('groupRuleConditionList');

  form.classList.toggle('is-hidden', !state.ruleEditor.visible);
  form.hidden = !state.ruleEditor.visible;

  if (!state.ruleEditor.visible) {
    return;
  }

  setRuleFormStatus('');
  document.getElementById('groupRuleNameInput').value = draft.name || '';
  document.getElementById('groupRuleTargetTitleInput').value = draft.targetTitle || '';
  document.getElementById('groupRuleThresholdInput').value = Number.isInteger(draft.minTabsPerGroup) ? String(draft.minTabsPerGroup) : '';
  document.getElementById('groupRuleEnabledInput').checked = draft.enabled !== false;
  document.getElementById('groupRuleThresholdHelp').textContent = `当前全局：至少 ${state.settings.minTabsPerGroup || 2} 个标签。`;

  const previewName = draft.name || draft.targetTitle || '';
  document.getElementById('groupRuleNamePreview').textContent = previewName ? `保存后规则名称：${previewName}` : '未填写时会使用目标分组名。';

  conditionList.innerHTML = '';
  conditionList.appendChild(renderConditionGroup(draft.conditionTree || createDefaultConditionGroup('and')));
  bindConditionTreeEvents(conditionList);
}

function updateGroupRuleFormPreview() {
  if (!state.ruleEditor.visible || !state.ruleEditor.draft) {
    return;
  }

  const draft = state.ruleEditor.draft;
  const previewName = draft.name || draft.targetTitle || '';
  document.getElementById('groupRuleNamePreview').textContent = previewName ? `保存后规则名称：${previewName}` : '未填写时会使用目标分组名。';
  document.getElementById('groupRuleThresholdHelp').textContent = `当前全局：至少 ${state.settings.minTabsPerGroup || 2} 个标签。`;
}

function openNewGroupRuleForm() {
  state.ruleEditor.visible = true;
  state.ruleEditor.editingRuleId = '';
  state.ruleEditor.draft = createDefaultGroupRuleDraft();
  renderGroupRuleForm();
}

function closeGroupRuleForm() {
  state.ruleEditor.visible = false;
  state.ruleEditor.editingRuleId = '';
  state.ruleEditor.draft = null;
  setRuleFormStatus('');
  renderGroupRuleForm();
}

function updateRuleDraftFromForm() {
  if (!state.ruleEditor.visible) {
    return;
  }

  const thresholdValue = document.getElementById('groupRuleThresholdInput').value;
  updateConditionTreeFromForm();

  state.ruleEditor.draft = {
    conditionTree: state.ruleEditor.draft.conditionTree || createDefaultConditionGroup('and'),
    name: document.getElementById('groupRuleNameInput').value.trim(),
    targetTitle: document.getElementById('groupRuleTargetTitleInput').value.trim(),
    enabled: document.getElementById('groupRuleEnabledInput').checked,
    minTabsPerGroup: thresholdValue ? Number(thresholdValue) : null
  };

  // 输入过程中不能重渲染整张表单，否则条件值输入框会被替换，光标位置会丢失。
  updateGroupRuleFormPreview();
}

function getConditionNodeByPath(root, path) {
  return path.reduce((node, index) => {
    return node && node.children ? node.children[index] : null;
  }, root);
}

function removeConditionNodeByPath(root, path) {
  if (path.length === 0) {
    return;
  }

  const parent = getConditionNodeByPath(root, path.slice(0, -1));
  const index = path[path.length - 1];

  if (parent && Array.isArray(parent.children)) {
    parent.children.splice(index, 1);
  }
}

function parseConditionPath(value) {
  if (!value) {
    return [];
  }

  return value.split('.').filter(Boolean).map((item) => Number(item));
}

function updateConditionTreeFromForm() {
  if (!state.ruleEditor.draft) {
    return;
  }

  state.ruleEditor.draft.conditionTree = state.ruleEditor.draft.conditionTree || createDefaultConditionGroup('and');

  document.querySelectorAll('[data-condition-action="logic"]').forEach((input) => {
    const node = getConditionNodeByPath(state.ruleEditor.draft.conditionTree, parseConditionPath(input.dataset.conditionPath));

    if (node && node.type === 'group') {
      node.logic = input.value === 'or' ? 'or' : 'and';
    }
  });

  document.querySelectorAll('[data-condition-field]').forEach((input) => {
    const node = getConditionNodeByPath(state.ruleEditor.draft.conditionTree, parseConditionPath(input.dataset.conditionPath));

    if (node && node.type === 'condition') {
      node[input.dataset.conditionField] = input.value;
    }
  });
}

function addRuleConditionToPath(path = []) {
  updateRuleDraftFromForm();

  if (countDraftConditions(state.ruleEditor.draft.conditionTree) >= 8) {
    setStatus('每条规则最多 8 个条件');
    setRuleFormStatus('每条规则最多 8 个条件', { error: true });
    return;
  }

  const group = getConditionNodeByPath(state.ruleEditor.draft.conditionTree, path);

  if (group && group.type === 'group') {
    group.children.push(createDefaultCondition());
  }

  renderGroupRuleForm();
}

function addRuleCondition() {
  addRuleConditionToPath([]);
}

function addRuleConditionGroup() {
  updateRuleDraftFromForm();

  if (countDraftConditions(state.ruleEditor.draft.conditionTree) >= 8) {
    setRuleFormStatus('每条规则最多 8 个条件', { error: true });
    return;
  }

  state.ruleEditor.draft.conditionTree.children.push(createDefaultConditionGroup('or'));
  renderGroupRuleForm();
}

function removeRuleConditionByPath(path) {
  updateRuleDraftFromForm();
  removeConditionNodeByPath(state.ruleEditor.draft.conditionTree, path);
  renderGroupRuleForm();
}

function bindConditionTreeEvents(container) {
  container.querySelectorAll('[data-condition-path], [data-condition-action]').forEach((input) => {
    input.addEventListener('input', updateRuleDraftFromForm);
    input.addEventListener('change', updateRuleDraftFromForm);
  });
  container.querySelectorAll('[data-remove-condition-path]').forEach((button) => {
    button.addEventListener('click', () => removeRuleConditionByPath(parseConditionPath(button.dataset.removeConditionPath)));
  });
  container.querySelectorAll('[data-add-condition-path]').forEach((button) => {
    button.addEventListener('click', () => addRuleConditionToPath(parseConditionPath(button.dataset.addConditionPath)));
  });
}

function hasEmptyConditionValue(node) {
  if (!node) {
    return true;
  }

  if (node.type === 'condition') {
    return !String(node.value || '').trim();
  }

  return !Array.isArray(node.children) || node.children.length === 0 || node.children.some(hasEmptyConditionValue);
}

function buildRulePayloadFromDraft() {
  updateRuleDraftFromForm();
  const draft = state.ruleEditor.draft;
  const targetTitle = draft.targetTitle.trim();
  const name = draft.name.trim() || targetTitle;

  if (!targetTitle) {
    throw new Error('目标分组名不能为空');
  }

  if (!name) {
    throw new Error('规则名称不能为空');
  }

  if (draft.minTabsPerGroup !== null && (!Number.isInteger(draft.minTabsPerGroup) || draft.minTabsPerGroup < 1)) {
    throw new Error('规则分组阈值必须是不小于 1 的整数，或留空使用全局阈值');
  }

  if (countDraftConditions(draft.conditionTree) === 0) {
    throw new Error('至少需要一个匹配条件');
  }

  if (countDraftConditions(draft.conditionTree) > 8) {
    throw new Error('每条规则最多 8 个条件');
  }

  if (hasEmptyConditionValue(draft.conditionTree)) {
    throw new Error('匹配内容不能为空');
  }

  return {
    name,
    enabled: draft.enabled,
    targetTitle,
    minTabsPerGroup: draft.minTabsPerGroup,
    conditionTree: draft.conditionTree
  };
}

async function saveGroupRule(event) {
  event.preventDefault();
  setRuleFormStatus('正在保存分组规则...');
  setBusy(true);

  try {
    const rule = buildRulePayloadFromDraft();
    const action = state.ruleEditor.editingRuleId ? 'update-group-rule' : 'create-group-rule';
    const payload = state.ruleEditor.editingRuleId ? {
      ruleId: state.ruleEditor.editingRuleId,
      rule
    } : {
      rule
    };
    const result = await sendMessage(action, payload);
    state.settings = result.settings || state.settings;
    setRuleFormStatus(`已保存分组规则：${rule.name || rule.targetTitle}`);
    closeGroupRuleForm();
    renderGroupRules();
    setStatus(`已保存分组规则：${rule.name || rule.targetTitle}`);
  } catch (error) {
    setRuleFormStatus(error.message || '保存分组规则失败', { error: true });
    setStatus(error.message || '保存分组规则失败');
  } finally {
    setBusy(false);
  }
}

async function handleGroupRuleAction(action, ruleId) {
  const rule = (state.settings.groupRules || []).find((item) => item.id === ruleId);

  if (!rule) {
    setStatus('没有找到分组规则');
    return;
  }

  if (action === 'edit-rule') {
    state.ruleEditor.visible = true;
    state.ruleEditor.editingRuleId = ruleId;
    state.ruleEditor.draft = {
      name: rule.name,
      enabled: rule.enabled,
      targetTitle: rule.targetTitle,
      minTabsPerGroup: rule.minTabsPerGroup,
      conditionTree: JSON.parse(JSON.stringify(rule.conditionTree || createDefaultConditionGroup('and')))
    };
    renderGroupRuleForm();
    return;
  }

  if (action === 'delete-rule' && !window.confirm('删除后无法恢复，确定删除这条分组规则吗？')) {
    setStatus('已取消删除分组规则');
    return;
  }

  if (action === 'move-rule-up' || action === 'move-rule-down') {
    await moveGroupRuleWithoutReload(ruleId, action === 'move-rule-down' ? 'down' : 'up');
    return;
  }

  const messageMap = {
    'toggle-rule': ['update-group-rule', { ruleId, rule: { enabled: !rule.enabled } }],
    'delete-rule': ['delete-group-rule', { ruleId }]
  };
  const [messageAction, payload] = messageMap[action] || [];

  if (!messageAction) {
    return;
  }

  await applyGroupRuleMutationWithoutReload(messageAction, payload);
}

async function moveGroupRuleWithoutReload(ruleId, direction) {
  await applyGroupRuleMutationWithoutReload('move-group-rule', { ruleId, direction });
}

async function applyGroupRuleMutationWithoutReload(action, payload) {
  setBusy(true);

  try {
    const result = await sendMessage(action, payload);
    state.settings = result.settings || state.settings;
    renderGroupRules();
    setStatus(formatActionResult(action, result));
  } catch (error) {
    setStatus(error.message || '更新分组规则失败');
  } finally {
    // 规则管理只影响规则列表显示，避免完整刷新把用户从高级管理区域带回搜索框。
    setBusy(false);
  }
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
    const groupTooltip = group.title === group.groupKey ? group.groupKey : `${group.title}（${group.groupKey}）`;
    item.innerHTML = `
      <div class="group-main">
        <span class="group-title" title="${escapeHtml(groupTooltip)}">${escapeHtml(group.title)}</span>
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
      runAction('toggle-priority-group', { groupKey: button.dataset.groupKey }, {
        loadStateOptions: { keepMoreToolsFocus: true }
      });
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
  const tabList = document.getElementById('searchResultList');
  const visibleTabs = getVisibleTabs();
  const selectedIndex = clampSelectedIndex(state.selectedIndex, visibleTabs.length);
  state.selectedIndex = selectedIndex;
  document.getElementById('visibleCount').textContent = `${visibleTabs.length} 个结果`;
  document.getElementById('resultTitle').textContent = state.query ? '搜索结果' : '最近使用';
  renderSortHelp();
  tabList.innerHTML = '';

  if (visibleTabs.length === 0) {
    tabList.appendChild(createEmptyState(state.query ? '没有匹配的标签页' : '当前没有可切换的标签页'));
    return;
  }

  visibleTabs.forEach((tab, index) => {
    const item = document.createElement('button');
    item.className = `tab-item quick-result-item${index === selectedIndex ? ' is-selected' : ''}`;
    item.type = 'button';
    item.dataset.action = tab.resultType === 'recentlyClosed' ? 'restore' : 'activate';
    item.dataset.tabId = String(tab.id);
    const groupTitle = tab.groupTitle || tab.groupKey;
    const isRecentlyClosed = tab.resultType === 'recentlyClosed';
    const windowLabel = isRecentlyClosed ? '最近关闭' : (tab.windowLabel || (tab.isCurrentWindow ? '当前窗口' : '其他窗口'));
    const accessLabel = formatRecentAccessTime(Number(tab.lastAccessedAt) || 0);
    const metaText = accessLabel ? `${windowLabel} · ${accessLabel}` : windowLabel;
    item.innerHTML = `
      <span class="quick-result-main">
        <span class="tab-title" title="${escapeHtml(tab.title)}">${escapeHtml(tab.title)}</span>
        <span class="tab-url" title="${escapeHtml(tab.groupKey)} · ${escapeHtml(tab.url)}">${escapeHtml(groupTitle)} · ${escapeHtml(tab.url)}</span>
      </span>
      <span class="quick-result-meta">${escapeHtml(metaText)}</span>
    `;
    item.addEventListener('click', () => openSearchResult(tab));
    tabList.appendChild(item);
  });

  keepSelectedResultVisible(tabList);
}

function keepSelectedResultVisible(tabList) {
  const selectedItem = tabList.querySelector('.quick-result-item.is-selected');

  if (selectedItem && typeof selectedItem.scrollIntoView === 'function') {
    // 键盘上下选择时列表本身不会自动滚动，这里只把高亮项滚进可视区域。
    selectedItem.scrollIntoView({ block: 'nearest' });
  }
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
    await runAction('restore-workspace', { workspaceId: sessionId }, {
      loadStateOptions: { keepMoreToolsFocus: true }
    });
    return;
  }

  if (action === 'restore-new-window') {
    await runAction('restore-workspace-new-window', { workspaceId: sessionId }, {
      loadStateOptions: { keepMoreToolsFocus: true }
    });
    return;
  }

  if (action === 'rename') {
    const session = state.sessions.find((item) => item.id === sessionId);
    const name = window.prompt('请输入新的工作集名称', session ? session.name : '');

    if (name === null) {
      setStatus('已取消重命名');
      return;
    }

    await runAction('rename-workspace', { workspaceId: sessionId, name }, {
      loadStateOptions: { keepMoreToolsFocus: true }
    });
    return;
  }

  if (action === 'favorite') {
    await runAction('toggle-workspace-favorite', { workspaceId: sessionId }, {
      loadStateOptions: { keepMoreToolsFocus: true }
    });
    return;
  }

  if (action === 'delete') {
    const shouldDelete = window.confirm('删除后无法恢复，确定删除这个工作集吗？');

    if (!shouldDelete) {
      setStatus('已取消删除工作集');
      return;
    }

    await runAction('delete-workspace', { workspaceId: sessionId }, {
      loadStateOptions: { keepMoreToolsFocus: true }
    });
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

function formatRecentAccessTime(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return '';
  }

  const elapsedMs = Math.max(0, now - timestamp);
  // 这里用固定分钟换算，原因是最近使用只需要粗粒度提示，不需要精确到秒。
  const minuteMs = 60 * 1000;

  if (elapsedMs < minuteMs) {
    return '刚刚';
  }

  const minutes = Math.floor(elapsedMs / minuteMs);

  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours} 小时前`;
  }

  return '更早';
}

function normalizeSearchText(value) {
  return String(value || '').trim().toLowerCase();
}

function getTabSearchText(tab) {
  return [
    tab.title,
    tab.url,
    tab.groupKey,
    tab.groupTitle,
    tab.shortGroupTitle
  ].map(normalizeSearchText).join(' ');
}

function getSearchMatchScore(tab, query) {
  const normalizedQuery = normalizeSearchText(query);

  if (!normalizedQuery) {
    return 0;
  }

  const title = normalizeSearchText(tab.title);
  const groupKey = normalizeSearchText(tab.groupKey);
  const groupTitle = normalizeSearchText(tab.groupTitle);
  const url = normalizeSearchText(tab.url);

  if (title === normalizedQuery) {
    return 400;
  }

  if (title.includes(normalizedQuery)) {
    return 300;
  }

  if (groupTitle.includes(normalizedQuery) || groupKey.includes(normalizedQuery)) {
    return 220;
  }

  if (url.includes(normalizedQuery)) {
    return 100;
  }

  return 0;
}

function getRecentMatchScore(tab, now = Date.now()) {
  const accessedAt = Number(tab && tab.lastAccessedAt) || 0;

  if (!Number.isFinite(accessedAt) || accessedAt <= 0) {
    return 0;
  }

  const elapsedMs = Math.max(0, now - accessedAt);
  const minuteMs = 60 * 1000;

  if (elapsedMs < minuteMs) {
    // 搜索短词时，刚访问过的页面通常就是用户想切回的页面，需要能压过旧页面的普通标题命中。
    return 260;
  }

  if (elapsedMs < 10 * minuteMs) {
    return 180;
  }

  if (elapsedMs < 60 * minuteMs) {
    return 100;
  }

  // 超过一小时的“最近”不再影响搜索排序，避免旧标签长期压过更精确的匹配。
  return 0;
}

function getSearchRankingScore(tab, query, now = Date.now()) {
  return getSearchMatchScore(tab, query) + getRecentMatchScore(tab, now);
}

function compareRecentTabs(left, right) {
  const leftAccessedAt = Number(left.lastAccessedAt) || 0;
  const rightAccessedAt = Number(right.lastAccessedAt) || 0;

  if (leftAccessedAt !== rightAccessedAt) {
    return rightAccessedAt - leftAccessedAt;
  }

  if (left.isCurrentWindow !== right.isCurrentWindow) {
    return left.isCurrentWindow ? -1 : 1;
  }

  return (left.index || 0) - (right.index || 0);
}

function compareSearchTabs(left, right, query) {
  const now = Date.now();
  const leftScore = getSearchRankingScore(left, query, now);
  const rightScore = getSearchRankingScore(right, query, now);
  const leftType = left.resultType || 'open';
  const rightType = right.resultType || 'open';

  if (leftScore !== rightScore) {
    return rightScore - leftScore;
  }

  if (leftType !== rightType) {
    return leftType === 'open' ? -1 : 1;
  }

  const recentCompare = compareRecentTabs(left, right);

  if (recentCompare !== 0) {
    return recentCompare;
  }

  return String(left.id || '').localeCompare(String(right.id || ''), 'zh-CN');
}

function getVisibleTabsFromState(sourceState) {
  const query = normalizeSearchText(sourceState.query);
  const tabs = Array.isArray(sourceState.tabs) ? sourceState.tabs : [];

  if (!query) {
    return tabs
      .filter((tab) => {
        // 最近使用列表用于“切回别的页面”，当前窗口的当前标签继续展示会浪费首屏位置。
        return !(tab.active && tab.isCurrentWindow);
      })
      .sort(compareRecentTabs)
      .slice(0, DEFAULT_RECENT_RESULT_LIMIT);
  }

  const recentlyClosedTabs = Array.isArray(sourceState.recentlyClosedTabs) ? sourceState.recentlyClosedTabs : [];
  const searchPool = [
    ...tabs.map((tab) => Object.assign({ resultType: 'open' }, tab)),
    ...recentlyClosedTabs
  ];

  return searchPool
    .filter((tab) => getSearchMatchScore(tab, query) > 0 || getTabSearchText(tab).includes(query))
    .sort((left, right) => compareSearchTabs(left, right, query))
    .slice(0, SEARCH_RESULT_LIMIT);
}

function clampSelectedIndex(index, total) {
  if (total <= 0) {
    return -1;
  }

  if (index < 0) {
    return total - 1;
  }

  if (index >= total) {
    return 0;
  }

  return index;
}

function getVisibleTabs() {
  return getVisibleTabsFromState(state);
}

function createEmptyState(text) {
  const element = document.createElement('div');
  element.className = 'empty-state';
  element.textContent = text;
  return element;
}

function setBusy(isBusy) {
  document.querySelectorAll('button').forEach((button) => {
    // 部分按钮因为排序边界或唯一条件而永久禁用，忙碌态结束后不能把这些按钮误恢复。
    button.disabled = isBusy || button.dataset.staticDisabled === 'true';
  });
}

function setStatus(text) {
  document.getElementById('statusText').textContent = text;
}

function setRuleFormStatus(text, options = {}) {
  const status = document.getElementById('groupRuleFormStatus');

  if (status) {
    status.textContent = text;
    status.classList.toggle('is-error', Boolean(options.error && text));
  }
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

  if (action === 'restore-closed-session') {
    return '已恢复最近关闭标签页';
  }

  if (action === 'create-group-rule' || action === 'update-group-rule') {
    return `已保存分组规则：${result.rule.name}`;
  }

  if (action === 'delete-group-rule') {
    return '已删除分组规则';
  }

  if (action === 'move-group-rule') {
    return result.moved ? '已调整分组规则顺序' : '分组规则顺序未变化';
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
