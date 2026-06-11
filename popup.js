const state = {
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
  moreToolsVisible: false,
  ruleEditor: {
    // 表单状态放在前端本地，原因是未保存草稿不应污染 chrome.storage。
    visible: false,
    editingRuleId: '',
    draft: null
  }
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
    state.groups = data.groups || [];
    state.sessions = data.sessions || [];
    state.settings = data.settings || state.settings;
    state.overview = data.overview || state.overview;
    render();

    if (options.keepMoreToolsFocus) {
      focusMoreTools();
    } else {
      focusPrimaryAction();
    }

    if (!options.keepStatus) {
      setStatus('已加载已打开标签页');
    }

    if (!options.skipDuplicateOverview) {
      loadDuplicateOverview();
    }
  } catch (error) {
    setStatus(error.message || '读取标签页失败');
  } finally {
    setBusy(false);
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

function toggleMoreTools() {
  state.moreToolsVisible = !state.moreToolsVisible;
  renderMoreTools();
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
  renderSettings();
  renderOverview();
  renderGroupRules();
  renderGroupRuleForm();
  renderGroups();
  renderDuplicateReview();
  renderSessions();
  renderMoreTools();
}

function focusPrimaryAction() {
  const organizeButton = document.getElementById('organizeButton');

  if (organizeButton && typeof organizeButton.focus === 'function') {
    // 弹窗打开的主任务就是整理当前窗口，焦点放在主按钮能减少一次点击。
    organizeButton.focus();
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
  const tabCount = state.overview.tabCount || 0;
  const domainCount = state.overview.domainCount || 0;
  const duplicateCount = state.overview.duplicateCount;

  document.getElementById('quickStatusText').textContent = `${tabCount} 个标签 · ${domainCount} 个主域名`;
  document.getElementById('duplicateHintText').textContent = Number.isFinite(duplicateCount) && duplicateCount > 0 ? `${duplicateCount} 个重复` : '';
  document.getElementById('summaryText').textContent = '把当前窗口整理成清晰分组';
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
    setStatus(`已保存分组规则：${rule.name || rule.targetTitle}`);
    await loadState({ keepStatus: true, keepMoreToolsFocus: true });
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

  const messageMap = {
    'toggle-rule': ['update-group-rule', { ruleId, rule: { enabled: !rule.enabled } }],
    'move-rule-up': ['move-group-rule', { ruleId, direction: 'up' }],
    'move-rule-down': ['move-group-rule', { ruleId, direction: 'down' }],
    'delete-rule': ['delete-group-rule', { ruleId }]
  };
  const [messageAction, payload] = messageMap[action] || [];

  if (!messageAction) {
    return;
  }

  await runAction(messageAction, payload);
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
