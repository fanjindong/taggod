if (typeof importScripts === 'function') {
  // 后台和弹窗必须加载同一份分组规则实现，避免两个入口再次产生语义分叉。
  importScripts('grouping.js');
}

const {
  DEFAULT_SETTINGS,
  MAX_GROUP_RULE_CONDITION_COUNT,
  buildGroupRuleIdentity,
  buildResolvedGroupTitleMapFromGroupInfos,
  buildTabSnapshotsFromNormalizedSettings,
  countConditionTreeConditions,
  doesRuleMatchTab,
  getDomainKey,
  getHostnameKey,
  getResolvedGroupInfoFromNormalizedSettings,
  getShortGroupTitle,
  getTabUrl,
  normalizeGroupRule,
  normalizeConditionTree,
  normalizeSettings
} = globalThis.TabGodGrouping;

const STORAGE_KEYS = {
  sessions: 'tabgod.sessions',
  settings: 'tabgod.settings',
  recentAccess: 'tabgod.recentAccess',
  pendingCleanup: 'tabgod.pendingCleanup'
};

const GROUP_COLORS = ['blue', 'green', 'yellow', 'red', 'purple', 'cyan', 'orange', 'pink', 'grey'];

// 只保留最近 300 个标签激活记录，原因是该记录只用于排序兜底，过多历史会浪费本地存储。
const RECENT_ACCESS_LIMIT = 300;
// Chrome 限制最近关闭会话查询最多 25 条，请求更大数值会直接抛错。
const RECENTLY_CLOSED_SESSION_LIMIT = 25;
// 会话里的关闭窗口可能包含多个标签，拆分后的搜索结果仍要限量，避免弹窗输入时处理过多数据。
const RECENTLY_CLOSED_SEARCH_LIMIT = 100;
// 快捷键反馈只短暂占用扩展徽标，避免长期遮挡用户对扩展状态的判断。
const COMMAND_BADGE_CLEAR_DELAY_MS = 3000;
const COMMAND_BADGE_SUCCESS_COLOR = '#15803d';
const COMMAND_BADGE_ERROR_COLOR = '#b91c1c';

let commandBadgeClearTimer = null;
let workspaceStorageQueue = Promise.resolve();
const activeCleanupTokens = new Set();

const TRACKING_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'gclid'
]);

function normalizeUrlForDuplicate(url) {
  try {
    const parsedUrl = new URL(url);

    TRACKING_QUERY_PARAMS.forEach((paramName) => {
      // 只移除明确的追踪参数，避免把业务查询参数误当成重复依据。
      parsedUrl.searchParams.delete(paramName);
    });

    return parsedUrl.toString();
  } catch (error) {
    // 异常网址不能安全规范化，保留原值可以避免把内部页面错误合并。
    return String(url || '');
  }
}

function getGroupColor(index) {
  // Chrome 原生分组颜色数量有限，循环使用可以保证任意数量主域名都有稳定颜色。
  return GROUP_COLORS[index % GROUP_COLORS.length];
}

function normalizeWorkspace(workspace) {
  const createdAt = Number(workspace && workspace.createdAt) || Date.now();

  return Object.assign({}, workspace, {
    id: workspace && workspace.id ? workspace.id : `session-${createdAt}`,
    name: workspace && workspace.name ? workspace.name : `${formatDateTime(createdAt)} 的工作集`,
    createdAt,
    updatedAt: Number(workspace && workspace.updatedAt) || createdAt,
    favorite: Boolean(workspace && workspace.favorite),
    favoritedAt: Number(workspace && workspace.favoritedAt) || 0,
    activeUrl: workspace && workspace.activeUrl ? workspace.activeUrl : '',
    sourceWindowId: Number.isInteger(workspace && workspace.sourceWindowId) ? workspace.sourceWindowId : null,
    tabs: Array.isArray(workspace && workspace.tabs) ? workspace.tabs : [],
    groups: Array.isArray(workspace && workspace.groups) ? workspace.groups : []
  });
}

/**
 * 串行执行工作集存储修改，避免快捷键保存和弹窗管理同时发生时互相覆盖。
 * @param {Function} operation 实际读写工作集的异步操作。
 * @returns {Promise<*>} 当前修改结果。
 */
function runWorkspaceStorageMutation(operation) {
  const currentOperation = workspaceStorageQueue.then(operation, operation);

  // 队列本身必须吞掉失败，原因是单次失败不能阻断后续工作集操作。
  workspaceStorageQueue = currentOperation.catch(() => undefined);
  return currentOperation;
}

function normalizeRecentAccessMap(value) {
  const entries = Object.entries(value || {})
    .filter(([tabId, accessedAt]) => Number.isInteger(Number(tabId)) && Number.isFinite(accessedAt))
    .sort((left, right) => right[1] - left[1])
    .slice(0, RECENT_ACCESS_LIMIT);

  return Object.fromEntries(entries);
}

async function recordRecentTabAccess(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  const stored = await chrome.storage.local.get([STORAGE_KEYS.recentAccess]);
  const recentAccess = normalizeRecentAccessMap(stored[STORAGE_KEYS.recentAccess]);
  recentAccess[String(tabId)] = Date.now();

  await chrome.storage.local.set({
    [STORAGE_KEYS.recentAccess]: normalizeRecentAccessMap(recentAccess)
  });
}

async function removeRecentTabAccess(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  const stored = await chrome.storage.local.get([STORAGE_KEYS.recentAccess]);
  const recentAccess = normalizeRecentAccessMap(stored[STORAGE_KEYS.recentAccess]);

  if (!Object.prototype.hasOwnProperty.call(recentAccess, String(tabId))) {
    return;
  }

  delete recentAccess[String(tabId)];

  await chrome.storage.local.set({
    [STORAGE_KEYS.recentAccess]: recentAccess
  });
}

function sortWorkspaces(workspaces) {
  return [...workspaces].map(normalizeWorkspace).sort((left, right) => {
    if (left.favorite !== right.favorite) {
      return left.favorite ? -1 : 1;
    }

    if (left.favorite && right.favorite && left.favoritedAt !== right.favoritedAt) {
      return right.favoritedAt - left.favoritedAt;
    }

    return right.createdAt - left.createdAt;
  });
}

function shouldCreateNativeGroup(tabIds, settings) {
  const normalizedSettings = normalizeSettings(settings);

  // 这是旧的 tabId 数量阈值入口；涉及规则级阈值时应使用 shouldCreateNativeGroupForTabs。
  return Array.isArray(tabIds) && tabIds.length >= normalizedSettings.minTabsPerGroup;
}

/**
 * 使用已归一化配置解析分组阈值，批量路径必须复用该入口以避免重复处理全部规则。
 * @param {Array<Object>} groupTabs 同一最终分组内的标签页。
 * @param {Object} normalizedSettings 已归一化的插件配置。
 * @param {string} resolvedGroupKey 调用方已知的最终分组键，传入后可避免重复解析首个标签。
 * @returns {number} 当前分组采用的建组阈值。
 */
function resolveGroupThresholdFromNormalizedSettings(groupTabs, normalizedSettings, resolvedGroupKey = '') {
  const safeGroupTabs = Array.isArray(groupTabs) ? groupTabs : [];
  const groupKey = resolvedGroupKey || (safeGroupTabs.length > 0
    ? getResolvedGroupInfoFromNormalizedSettings(safeGroupTabs[0], normalizedSettings).groupKey
    : '');

  if (!groupKey) {
    return normalizedSettings.minTabsPerGroup;
  }

  for (const rule of normalizedSettings.groupRules) {
    if (rule.targetGroupKey !== groupKey) {
      continue;
    }

    if (!Number.isInteger(rule.minTabsPerGroup) || rule.minTabsPerGroup < 1) {
      continue;
    }

    if (safeGroupTabs.some((tab) => doesRuleMatchTab(rule, tab))) {
      // 同一最终分组可能混合命中规则和未命中规则的标签，不能只看首个标签是否命中规则。
      return rule.minTabsPerGroup;
    }
  }

  return normalizedSettings.minTabsPerGroup;
}

function resolveGroupThreshold(groupTabs, settings) {
  return resolveGroupThresholdFromNormalizedSettings(groupTabs, normalizeSettings(settings));
}

/**
 * 使用已归一化配置判断同组标签是否达到建组阈值。
 * @param {Array<Object>} groupTabs 同一最终分组内的标签页。
 * @param {Object} normalizedSettings 已归一化的插件配置。
 * @param {string} resolvedGroupKey 调用方已知的最终分组键。
 * @returns {boolean} 是否应创建 Chrome 原生分组。
 */
function shouldCreateNativeGroupForTabsFromNormalizedSettings(groupTabs, normalizedSettings, resolvedGroupKey = '') {
  const safeGroupTabs = Array.isArray(groupTabs) ? groupTabs : [];
  const threshold = resolveGroupThresholdFromNormalizedSettings(
    safeGroupTabs,
    normalizedSettings,
    resolvedGroupKey
  );

  return safeGroupTabs.length >= threshold;
}

function shouldCreateNativeGroupForTabs(groupTabs, settings) {
  return shouldCreateNativeGroupForTabsFromNormalizedSettings(groupTabs, normalizeSettings(settings));
}

function isPriorityGroup(settings, groupKey) {
  return settings.priorityGroups.some((group) => group.groupKey === groupKey);
}

/**
 * 为一次批量整理预先解析全部标签分组，避免排序比较器重复遍历规则。
 * @param {Array<Object>} tabs Chrome 标签页列表。
 * @param {Object} normalizedSettings 已归一化的插件配置。
 * @returns {Map<Object, Object>} 标签对象到最终分组信息的映射。
 */
function buildResolvedGroupInfoMap(tabs, normalizedSettings) {
  const resolvedGroupInfoMap = new Map();

  (Array.isArray(tabs) ? tabs : []).forEach((tab) => {
    resolvedGroupInfoMap.set(tab, getResolvedGroupInfoFromNormalizedSettings(tab, normalizedSettings));
  });

  return resolvedGroupInfoMap;
}

function getResolvedGroupInfoFromMap(tab, normalizedSettings, resolvedGroupInfoMap) {
  if (resolvedGroupInfoMap && resolvedGroupInfoMap.has(tab)) {
    return resolvedGroupInfoMap.get(tab);
  }

  // 独立调用兼容旧入口；批量整理会始终命中预计算映射。
  return getResolvedGroupInfoFromNormalizedSettings(tab, normalizedSettings);
}

function buildPriorityGroupOrderMapFromNormalizedSettings(normalizedSettings) {
  const orderMap = new Map();

  normalizedSettings.priorityGroups.forEach((group, index) => {
    // 使用归一化后的连续编号，避免历史配置里的空洞影响实际排序。
    orderMap.set(group.groupKey, Number.isInteger(group.sortOrder) ? group.sortOrder : index);
  });

  return orderMap;
}

function buildPriorityGroupOrderMap(settings) {
  return buildPriorityGroupOrderMapFromNormalizedSettings(normalizeSettings(settings));
}

function buildCurrentGroupOrderMapFromNormalizedSettings(tabs, normalizedSettings, resolvedGroupInfoMap = null) {
  const orderMap = new Map();

  tabs.forEach((tab) => {
    if (tab.pinned) {
      return;
    }

    const groupKey = getResolvedGroupInfoFromMap(tab, normalizedSettings, resolvedGroupInfoMap).groupKey;

    if (!orderMap.has(groupKey)) {
      // 当前从左到右的首次出现顺序代表用户刚刚手动拖好的分组顺序。
      orderMap.set(groupKey, orderMap.size);
    }
  });

  return orderMap;
}

function buildCurrentGroupOrderMap(tabs, settings = DEFAULT_SETTINGS) {
  return buildCurrentGroupOrderMapFromNormalizedSettings(tabs, normalizeSettings(settings));
}

function buildGroupableDomainSetFromNormalizedSettings(tabs, normalizedSettings, resolvedGroupInfoMap = null) {
  const domainTabs = new Map();

  (Array.isArray(tabs) ? tabs : []).forEach((tab) => {
    if (tab.pinned || typeof tab.id !== 'number') {
      return;
    }

    const groupKey = getResolvedGroupInfoFromMap(tab, normalizedSettings, resolvedGroupInfoMap).groupKey;
    const groupTabs = domainTabs.get(groupKey) || [];
    groupTabs.push(tab);
    domainTabs.set(groupKey, groupTabs);
  });

  return new Set(Array.from(domainTabs.entries())
    .filter(([groupKey, groupTabs]) => {
      // 排序阶段必须复用真实建组阈值，否则单标签主域名会被当成分组插到原生分组之前。
      return shouldCreateNativeGroupForTabsFromNormalizedSettings(groupTabs, normalizedSettings, groupKey);
    })
    .map(([groupKey]) => groupKey));
}

function buildGroupableDomainSet(tabs, settings) {
  return buildGroupableDomainSetFromNormalizedSettings(tabs, normalizeSettings(settings));
}

function buildOrganizedTabsFromNormalizedSettings(tabs, normalizedSettings) {
  const safeTabs = Array.isArray(tabs) ? tabs : [];
  const resolvedGroupInfoMap = buildResolvedGroupInfoMap(safeTabs, normalizedSettings);
  const currentGroupOrderMap = buildCurrentGroupOrderMapFromNormalizedSettings(
    safeTabs,
    normalizedSettings,
    resolvedGroupInfoMap
  );
  const priorityGroupOrderMap = buildPriorityGroupOrderMapFromNormalizedSettings(normalizedSettings);
  const groupableDomainSet = buildGroupableDomainSetFromNormalizedSettings(
    safeTabs,
    normalizedSettings,
    resolvedGroupInfoMap
  );

  return [...safeTabs].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    const leftGroupInfo = resolvedGroupInfoMap.get(left);
    const rightGroupInfo = resolvedGroupInfoMap.get(right);
    const leftDomain = leftGroupInfo.groupKey;
    const rightDomain = rightGroupInfo.groupKey;
    const leftIsGroupable = groupableDomainSet.has(leftDomain);
    const rightIsGroupable = groupableDomainSet.has(rightDomain);

    if (leftIsGroupable !== rightIsGroupable) {
      // 只有达到阈值的主域名才会形成 Chrome 原生分组，必须整体排在零散单标签前面。
      return leftIsGroupable ? -1 : 1;
    }

    const leftIsPriority = leftIsGroupable && isPriorityGroup(normalizedSettings, leftDomain);
    const rightIsPriority = rightIsGroupable && isPriorityGroup(normalizedSettings, rightDomain);

    if (leftIsPriority !== rightIsPriority) {
      return leftIsPriority ? -1 : 1;
    }

    if (leftIsPriority && rightIsPriority) {
      const leftPriorityRank = priorityGroupOrderMap.get(leftDomain) ?? Number.POSITIVE_INFINITY;
      const rightPriorityRank = priorityGroupOrderMap.get(rightDomain) ?? Number.POSITIVE_INFINITY;

      if (leftPriorityRank !== rightPriorityRank) {
        // 高级管理里保存的顺序应覆盖当前标签栏顺序，否则上移下移不会影响下一次整理结果。
        return leftPriorityRank - rightPriorityRank;
      }
    }

    const leftCurrentRank = currentGroupOrderMap.get(leftDomain) ?? Number.POSITIVE_INFINITY;
    const rightCurrentRank = currentGroupOrderMap.get(rightDomain) ?? Number.POSITIVE_INFINITY;

    if (leftCurrentRank !== rightCurrentRank) {
      // 当前分组顺序来自最终分组键，避免命中规则与未命中规则的同键标签被其他分组插开。
      return leftCurrentRank - rightCurrentRank;
    }

    const domainCompare = leftDomain.localeCompare(rightDomain, 'zh-CN');

    if (domainCompare !== 0) {
      return domainCompare;
    }

    const leftHostname = getHostnameKey(left.url || '');
    const rightHostname = getHostnameKey(right.url || '');
    const hostnameCompare = leftHostname.localeCompare(rightHostname, 'zh-CN');

    return hostnameCompare === 0 ? left.index - right.index : hostnameCompare;
  });
}

function buildOrganizedTabs(tabs, settings) {
  return buildOrganizedTabsFromNormalizedSettings(tabs, normalizeSettings(settings));
}

async function queryCurrentWindowTabs() {
  return chrome.tabs.query({ currentWindow: true });
}

async function queryWindowTabs(windowId) {
  if (!Number.isInteger(windowId)) {
    throw new Error('目标窗口无效');
  }

  return chrome.tabs.query({ windowId });
}

async function queryAllWindowTabs() {
  return chrome.tabs.query({});
}

function getWindowIdFromTabs(tabs) {
  const safeTabs = Array.isArray(tabs) ? tabs : [];
  const activeTab = safeTabs.find((tab) => tab && tab.active && Number.isInteger(tab.windowId));
  const fallbackTab = safeTabs.find((tab) => tab && Number.isInteger(tab.windowId));

  return activeTab ? activeTab.windowId : fallbackTab ? fallbackTab.windowId : null;
}

async function resolveCurrentWindowId() {
  const tabs = await queryCurrentWindowTabs();
  const windowId = getWindowIdFromTabs(tabs);

  if (Number.isInteger(windowId)) {
    return windowId;
  }

  if (chrome.windows && typeof chrome.windows.getLastFocused === 'function') {
    const focusedWindow = await chrome.windows.getLastFocused().catch(() => null);

    if (focusedWindow && Number.isInteger(focusedWindow.id)) {
      return focusedWindow.id;
    }
  }

  throw new Error('无法确定目标窗口');
}

function buildRecentlyClosedTabSnapshot(tab, options) {
  const safeTab = tab || {};
  const sessionId = String(options && options.sessionId ? options.sessionId : '').trim();

  if (!sessionId) {
    return null;
  }

  const url = safeTab.url || '';
  const groupInfo = options.groupInfo
    || getResolvedGroupInfoFromNormalizedSettings(safeTab, options.settings);

  return {
    resultType: 'recentlyClosed',
    sessionId,
    id: `closed-${sessionId}-${options.sourceIndex}`,
    title: safeTab.title || '未命名标签',
    url,
    groupKey: groupInfo.groupKey,
    groupTitle: groupInfo.title,
    shortGroupTitle: getShortGroupTitle(groupInfo.groupKey),
    closedAt: options.closedAt,
    lastAccessedAt: options.closedAt,
    isCurrentWindow: false,
    windowLabel: options.windowLabel || '最近关闭',
    restoreScope: options.restoreScope || 'tab',
    index: options.sourceIndex
  };
}

function buildRecentlyClosedTabSnapshotsFromNormalizedSettings(recentlyClosedSessions, normalizedSettings) {
  const snapshots = [];
  const snapshotGroupInfos = [];

  for (const session of Array.isArray(recentlyClosedSessions) ? recentlyClosedSessions : []) {
    if (snapshots.length >= RECENTLY_CLOSED_SEARCH_LIMIT) {
      break;
    }

    const closedAt = Number(session.lastModified) || 0;
    const tabSessionId = session.tab && session.tab.sessionId ? session.tab.sessionId : '';
    const windowSessionId = session.window && session.window.sessionId ? session.window.sessionId : '';
    const fallbackSessionId = session.sessionId || '';

    if (session.tab) {
      const sessionId = tabSessionId || fallbackSessionId;

      if (!sessionId) {
        continue;
      }

      const groupInfo = getResolvedGroupInfoFromNormalizedSettings(session.tab, normalizedSettings);
      const snapshot = buildRecentlyClosedTabSnapshot(session.tab, {
        closedAt,
        // Chrome 把可恢复编号放在 tab/window 上，兼容兜底只用于非标准或旧数据结构。
        sessionId,
        groupInfo,
        settings: normalizedSettings,
        windowLabel: '最近关闭标签',
        restoreScope: 'tab',
        sourceIndex: snapshots.length
      });

      if (snapshot) {
        snapshots.push(snapshot);
        snapshotGroupInfos.push(groupInfo);
      }

      continue;
    }

    const windowTabs = session.window && Array.isArray(session.window.tabs) ? session.window.tabs : [];

    for (const tab of windowTabs) {
      if (snapshots.length >= RECENTLY_CLOSED_SEARCH_LIMIT) {
        break;
      }

      const sessionId = windowSessionId || tab.sessionId || fallbackSessionId;

      if (!sessionId) {
        continue;
      }

      const groupInfo = getResolvedGroupInfoFromNormalizedSettings(tab, normalizedSettings);
      const snapshot = buildRecentlyClosedTabSnapshot(tab, {
        closedAt,
        // 关闭窗口里的单个结果恢复时会恢复整个窗口，这是 Chrome sessionId 的原生粒度。
        sessionId,
        groupInfo,
        settings: normalizedSettings,
        windowLabel: `最近关闭窗口（${windowTabs.length} 个标签）`,
        restoreScope: 'window',
        sourceIndex: snapshots.length
      });

      if (snapshot) {
        snapshots.push(snapshot);
        snapshotGroupInfos.push(groupInfo);
      }
    }
  }

  const titleMap = buildResolvedGroupTitleMapFromGroupInfos(snapshotGroupInfos, normalizedSettings);

  return snapshots.map((snapshot) => Object.assign({}, snapshot, {
    // 最近关闭结果也必须使用批量标题映射，避免同一分组在搜索池内出现两种显示名。
    groupTitle: titleMap.get(snapshot.groupKey) || snapshot.groupTitle || snapshot.groupKey
  }));
}

function buildRecentlyClosedTabSnapshots(recentlyClosedSessions, settings) {
  return buildRecentlyClosedTabSnapshotsFromNormalizedSettings(
    recentlyClosedSessions,
    normalizeSettings(settings)
  );
}

function chooseDuplicateKeepTab(tabs) {
  const sortedTabs = [...tabs].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    if (left.active !== right.active) {
      return left.active ? -1 : 1;
    }

    if (left.audible !== right.audible) {
      return left.audible ? -1 : 1;
    }

    return left.index - right.index;
  });

  return sortedTabs[0];
}

function isBulkCloseProtectedTab(tab) {
  return Boolean(
    tab
    && (tab.pinned || tab.active || tab.audible || tab.pendingUrl)
  );
}

function buildDuplicateGroups(tabs) {
  const normalizedUrlMap = new Map();

  tabs.forEach((tab) => {
    if (!tab.url || typeof tab.id !== 'number') {
      return;
    }

    const normalizedUrl = normalizeUrlForDuplicate(tab.url);
    const normalizedTabs = normalizedUrlMap.get(normalizedUrl) || [];
    normalizedTabs.push(tab);
    normalizedUrlMap.set(normalizedUrl, normalizedTabs);
  });

  const duplicateGroups = [];

  normalizedUrlMap.forEach((groupTabs, normalizedUrl) => {
    if (groupTabs.length <= 1) {
      return;
    }

    const originalUrlSet = new Set(groupTabs.map((tab) => tab.url || ''));
    const reason = originalUrlSet.size === 1 ? '完整网址重复' : '忽略追踪参数后重复';
    const keepTab = chooseDuplicateKeepTab(groupTabs);
    const closeTabs = groupTabs
      .filter((tab) => tab.id !== keepTab.id && !isBulkCloseProtectedTab(tab))
      .sort((left, right) => left.index - right.index);

    if (closeTabs.length === 0) {
      return;
    }

    duplicateGroups.push({
      duplicateKey: normalizedUrl,
      reason,
      title: keepTab.title || '未命名标签',
      groupKey: getDomainKey(keepTab.url || ''),
      keepTabId: keepTab.id,
      keepTitle: keepTab.title || '未命名标签',
      keepUrl: keepTab.url || '',
      closeTabIds: closeTabs.map((tab) => tab.id),
      closeCount: closeTabs.length,
      tabCount: groupTabs.length
    });
  });

  return duplicateGroups;
}

function buildOverview(tabs) {
  const domainSet = new Set();
  const groupSet = new Set();

  tabs.forEach((tab) => {
    domainSet.add(getDomainKey(tab.url || ''));

    if (typeof tab.groupId === 'number' && tab.groupId >= 0) {
      groupSet.add(tab.groupId);
    }
  });

  return {
    tabCount: tabs.length,
    domainCount: domainSet.size,
    duplicateCount: null,
    groupCount: groupSet.size
  };
}

async function getDuplicateOverview() {
  // 顶部重复提示会直接引导用户点“智能去重”，必须和去重扫描保持当前窗口口径。
  const tabs = await queryCurrentWindowTabs();
  const duplicateCount = buildDuplicateGroups(tabs).reduce((total, group) => {
    return total + group.closeCount;
  }, 0);

  return {
    duplicateCount
  };
}

async function getRecentlyClosedState() {
  const [recentlyClosedSessions, stored] = await Promise.all([
    chrome.sessions.getRecentlyClosed({ maxResults: RECENTLY_CLOSED_SESSION_LIMIT }).catch(() => []),
    chrome.storage.local.get([STORAGE_KEYS.settings])
  ]);
  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);

  return {
    recentlyClosedTabs: buildRecentlyClosedTabSnapshotsFromNormalizedSettings(
      recentlyClosedSessions,
      settings
    )
  };
}

async function getManagementState() {
  const [tabs, stored, pendingCleanup] = await Promise.all([
    queryCurrentWindowTabs(),
    chrome.storage.local.get([
      STORAGE_KEYS.sessions,
      STORAGE_KEYS.settings
    ]),
    readPendingCleanup().catch(() => null)
  ]);
  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);

  return {
    groups: buildGroupSummariesFromNormalizedSettings(tabs, settings),
    sessions: sortWorkspaces(stored[STORAGE_KEYS.sessions] || []),
    pendingCleanup: pendingCleanup ? {
      token: pendingCleanup.token,
      tabCount: pendingCleanup.tabs.length
    } : null,
    settings
  };
}

async function organizeTabs() {
  const tabs = await queryCurrentWindowTabs();
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);

  if (tabs.length === 0) {
    return { organizedCount: 0, groupCount: 0 };
  }

  const sortedTabs = buildOrganizedTabsFromNormalizedSettings(tabs, settings);

  for (let index = 0; index < sortedTabs.length; index += 1) {
    const tab = sortedTabs[index];

    if (typeof tab.id === 'number') {
      // 逐个移动可以减少跨固定标签区域移动导致的失败，失败标签不会阻断后续整理。
      await chrome.tabs.move(tab.id, { index }).catch(() => undefined);
    }
  }

  const reconcileResult = await reconcileCurrentWindowGroupsFromNormalizedSettings(settings);

  return {
    organizedCount: tabs.length,
    groupCount: reconcileResult.groupedCount
  };
}

async function reconcileWindowGroupsFromTabs(tabs, normalizedSettings) {
  const groups = new Map();
  const groupInfos = [];

  tabs.forEach((tab) => {
    if (tab.pinned || typeof tab.id !== 'number') {
      return;
    }

    const groupInfo = getResolvedGroupInfoFromNormalizedSettings(tab, normalizedSettings);
    const groupKey = groupInfo.groupKey;
    groupInfos.push(groupInfo);
    const groupTabs = groups.get(groupKey) || [];
    groupTabs.push(tab);
    groups.set(groupKey, groupTabs);
  });

  let groupedCount = 0;
  let ungroupedTabCount = 0;
  const titleMap = buildResolvedGroupTitleMapFromGroupInfos(groupInfos, normalizedSettings);

  for (const [groupKey, groupTabs] of groups.entries()) {
    const tabIds = groupTabs.map((tab) => tab.id);

    if (!shouldCreateNativeGroupForTabsFromNormalizedSettings(groupTabs, normalizedSettings, groupKey)) {
      const groupedTabIds = groupTabs
        .filter((tab) => typeof tab.groupId === 'number' && tab.groupId >= 0)
        .map((tab) => tab.id);

      if (groupedTabIds.length > 0) {
        // 配置调高后，旧原生分组不再满足阈值，必须取消才能让当前页面状态和配置一致。
        const ungroupedCount = await chrome.tabs.ungroup(groupedTabIds)
          .then(() => groupedTabIds.length)
          .catch(() => 0);
        ungroupedTabCount += ungroupedCount;
      }

      continue;
    }

    const groupId = await chrome.tabs.group({ tabIds }).catch(() => null);

    if (typeof groupId === 'number') {
      await chrome.tabGroups.update(groupId, {
        title: titleMap.get(groupKey) || groupKey,
        color: getGroupColor(groupedCount)
      });
      groupedCount += 1;
    }
  }

  return {
    groupedCount,
    ungroupedTabCount
  };
}

async function reconcileWindowGroupsFromNormalizedSettings(windowId, normalizedSettings) {
  const tabs = await queryWindowTabs(windowId);
  return reconcileWindowGroupsFromTabs(tabs, normalizedSettings);
}

async function reconcileCurrentWindowGroupsFromNormalizedSettings(normalizedSettings) {
  const tabs = await queryCurrentWindowTabs();
  return reconcileWindowGroupsFromTabs(tabs, normalizedSettings);
}

async function reconcileCurrentWindowGroups(settings) {
  return reconcileCurrentWindowGroupsFromNormalizedSettings(normalizeSettings(settings));
}

function buildGroupSummariesFromNormalizedSettings(tabs, normalizedSettings) {
  const groupMap = new Map();
  const resolvedGroupInfoMap = buildResolvedGroupInfoMap(tabs, normalizedSettings);
  const currentGroupOrderMap = buildCurrentGroupOrderMapFromNormalizedSettings(
    tabs,
    normalizedSettings,
    resolvedGroupInfoMap
  );
  const priorityGroupOrderMap = buildPriorityGroupOrderMapFromNormalizedSettings(normalizedSettings);

  tabs.forEach((tab) => {
    if (tab.pinned || typeof tab.id !== 'number') {
      return;
    }

    const groupInfo = resolvedGroupInfoMap.get(tab);
    const groupKey = groupInfo.groupKey;
    const summary = groupMap.get(groupKey) || {
      groupKey,
      title: groupInfo.title,
      tabCount: 0,
      tabIds: [],
      tabs: [],
      groupInfos: [],
      starred: isPriorityGroup(normalizedSettings, groupKey),
      currentOrder: currentGroupOrderMap.get(groupKey) ?? Number.POSITIVE_INFINITY
    };

    summary.tabCount += 1;
    summary.tabIds.push(tab.id);
    summary.tabs.push(tab);
    summary.groupInfos.push(groupInfo);
    groupMap.set(groupKey, summary);
  });

  const groupSummaries = Array.from(groupMap.values()).filter((summary) => {
    // 优先分组列表只展示真实会创建原生分组的项，避免单标签主域名出现无意义星标入口。
    return shouldCreateNativeGroupForTabsFromNormalizedSettings(
      summary.tabs,
      normalizedSettings,
      summary.groupKey
    );
  });
  const titleMap = buildResolvedGroupTitleMapFromGroupInfos(
    groupSummaries.flatMap((summary) => summary.groupInfos),
    normalizedSettings
  );

  return groupSummaries.sort((left, right) => {
    if (left.starred !== right.starred) {
      return left.starred ? -1 : 1;
    }

    if (left.starred && right.starred) {
      const leftPriorityRank = priorityGroupOrderMap.get(left.groupKey) ?? Number.POSITIVE_INFINITY;
      const rightPriorityRank = priorityGroupOrderMap.get(right.groupKey) ?? Number.POSITIVE_INFINITY;

      if (leftPriorityRank !== rightPriorityRank) {
        // 列表顺序必须和整理顺序一致，用户才知道上移下移会产生什么结果。
        return leftPriorityRank - rightPriorityRank;
      }
    }

    if (left.currentOrder !== right.currentOrder) {
      return left.currentOrder - right.currentOrder;
    }

    return left.groupKey.localeCompare(right.groupKey, 'zh-CN');
  }).map((summary) => ({
    groupKey: summary.groupKey,
    title: titleMap.get(summary.groupKey) || summary.title || summary.groupKey,
    tabCount: summary.tabCount,
    starred: summary.starred,
    currentOrder: summary.currentOrder
  }));
}

function buildGroupSummaries(tabs, settings) {
  return buildGroupSummariesFromNormalizedSettings(tabs, normalizeSettings(settings));
}

async function scanDuplicateTabs(targetWindowId = null) {
  const tabs = Number.isInteger(targetWindowId)
    ? await queryWindowTabs(targetWindowId)
    : await queryCurrentWindowTabs();
  const windowId = Number.isInteger(targetWindowId) ? targetWindowId : getWindowIdFromTabs(tabs);

  if (!Number.isInteger(windowId)) {
    throw new Error('无法确定重复标签所在窗口');
  }

  return {
    windowId,
    groups: buildDuplicateGroups(tabs)
  };
}

function normalizeSelectedDuplicateTargets(selectedGroups) {
  const targetMap = new Map();

  (Array.isArray(selectedGroups) ? selectedGroups : []).forEach((group) => {
    const duplicateKey = String(group && group.duplicateKey ? group.duplicateKey : '').trim();

    if (!duplicateKey) {
      return;
    }

    (Array.isArray(group.closeTabIds) ? group.closeTabIds : []).forEach((tabId) => {
      if (Number.isInteger(tabId) && !targetMap.has(tabId)) {
        targetMap.set(tabId, { tabId, duplicateKey });
      }
    });
  });

  return Array.from(targetMap.values());
}

async function getRevalidatedDuplicateTab(windowId, target) {
  const currentTabs = await queryWindowTabs(windowId);
  const currentGroup = buildDuplicateGroups(currentTabs).find((group) => {
    return group.duplicateKey === target.duplicateKey;
  });

  if (!currentGroup || !currentGroup.closeTabIds.includes(target.tabId)) {
    return null;
  }

  const currentTab = currentTabs.find((tab) => tab.id === target.tabId);

  if (
    !currentTab
    || currentTab.windowId !== windowId
    || isBulkCloseProtectedTab(currentTab)
    || normalizeUrlForDuplicate(currentTab.url) !== target.duplicateKey
  ) {
    return null;
  }

  return currentTab;
}

async function closeSelectedDuplicateTabs(windowId, selectedGroups) {
  if (!Number.isInteger(windowId)) {
    throw new Error('重复标签所在窗口无效，请重新扫描');
  }

  const targets = normalizeSelectedDuplicateTargets(selectedGroups);

  if (targets.length === 0) {
    return {
      closedCount: 0,
      skippedCount: 0,
      failedCount: 0
    };
  }

  let closedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const target of targets) {
    let currentTab;

    try {
      // 每个标签关闭前都重新计算重复组，避免确认后页面跳转或保留项变化造成误关。
      currentTab = await getRevalidatedDuplicateTab(windowId, target);
    } catch (error) {
      currentTab = null;
    }

    if (!currentTab) {
      skippedCount += 1;
      continue;
    }

    try {
      await chrome.tabs.remove(currentTab.id);
      closedCount += 1;
    } catch (error) {
      failedCount += 1;
    }
  }

  return {
    closedCount,
    skippedCount,
    failedCount
  };
}

function createCleanupToken(createdAt) {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return `cleanup-${globalThis.crypto.randomUUID()}`;
  }

  // 极旧运行环境没有 randomUUID 时加入时间与随机片段，令牌只用于当前浏览器会话内防止误重放。
  return `cleanup-${createdAt}-${Math.random().toString(36).slice(2)}`;
}

function normalizePendingCleanup(value) {
  const token = String(value && value.token ? value.token : '').trim();
  const workspaceId = String(value && value.workspaceId ? value.workspaceId : '').trim();
  const sourceWindowId = Number.isInteger(value && value.sourceWindowId) ? value.sourceWindowId : null;
  const tabs = (Array.isArray(value && value.tabs) ? value.tabs : []).filter((tab) => {
    return Number.isInteger(tab && tab.id) && typeof tab.url === 'string' && tab.url;
  }).map((tab) => ({
    id: tab.id,
    url: tab.url
  }));

  if (!token || !workspaceId || !Number.isInteger(sourceWindowId) || tabs.length === 0) {
    return null;
  }

  return {
    token,
    workspaceId,
    sourceWindowId,
    createdAt: Number(value.createdAt) || Date.now(),
    tabs
  };
}

async function readPendingCleanup() {
  if (!chrome.storage.session || typeof chrome.storage.session.get !== 'function') {
    return null;
  }

  const stored = await chrome.storage.session.get([STORAGE_KEYS.pendingCleanup]);
  return normalizePendingCleanup(stored[STORAGE_KEYS.pendingCleanup]);
}

async function storePendingCleanup(workspace) {
  if (!chrome.storage.session || typeof chrome.storage.session.set !== 'function') {
    return null;
  }

  const pendingCleanup = normalizePendingCleanup({
    token: createCleanupToken(workspace.createdAt),
    workspaceId: workspace.id,
    sourceWindowId: workspace.sourceWindowId,
    createdAt: workspace.createdAt,
    tabs: workspace.tabs.map((tab) => ({
      id: tab.id,
      url: getTabUrl(tab)
    }))
  });

  if (!pendingCleanup) {
    if (typeof chrome.storage.session.remove === 'function') {
      await chrome.storage.session.remove([STORAGE_KEYS.pendingCleanup]);
    }
    return null;
  }

  try {
    await chrome.storage.session.set({
      [STORAGE_KEYS.pendingCleanup]: pendingCleanup
    });
  } catch (error) {
    // 新令牌写入失败时必须尽力清掉旧令牌，避免界面误把上一次保存当成本次待清理记录。
    if (typeof chrome.storage.session.remove === 'function') {
      await Promise.resolve(chrome.storage.session.remove([STORAGE_KEYS.pendingCleanup])).catch(() => undefined);
    }
    throw error;
  }
  return pendingCleanup;
}

async function clearPendingCleanupForWorkspace(workspaceId) {
  const pendingCleanup = await readPendingCleanup().catch(() => null);

  if (
    pendingCleanup
    && pendingCleanup.workspaceId === workspaceId
    && chrome.storage.session
    && typeof chrome.storage.session.remove === 'function'
  ) {
    await chrome.storage.session.remove([STORAGE_KEYS.pendingCleanup]);
  }
}

async function consumePendingCleanup(cleanupToken) {
  const safeToken = String(cleanupToken || '').trim();

  if (!safeToken || activeCleanupTokens.has(safeToken)) {
    throw new Error('待关闭记录已失效，请重新保存工作集');
  }

  activeCleanupTokens.add(safeToken);

  try {
    const pendingCleanup = await readPendingCleanup();

    if (!pendingCleanup || pendingCleanup.token !== safeToken) {
      throw new Error('待关闭记录已失效，请重新保存工作集');
    }

    if (!chrome.storage.session || typeof chrome.storage.session.remove !== 'function') {
      throw new Error('无法安全消费待关闭记录');
    }

    // 关闭前先消费一次性令牌，原因是重复点击不能再次作用于已经变化的标签页。
    await chrome.storage.session.remove([STORAGE_KEYS.pendingCleanup]);
    return pendingCleanup;
  } finally {
    activeCleanupTokens.delete(safeToken);
  }
}

async function saveWorkspace(name, options = {}) {
  const tabs = Number.isInteger(options.sourceWindowId)
    ? await queryWindowTabs(options.sourceWindowId)
    : await queryCurrentWindowTabs();
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
  const createdAt = Date.now();
  const snapshots = buildTabSnapshotsFromNormalizedSettings(tabs, settings);
  const activeTab = snapshots.find((tab) => tab.active);
  const groups = buildGroupSnapshots(snapshots);
  const sourceWindowId = getWindowIdFromTabs(tabs);
  const workspaceName = String(name || '').trim() || `${formatDateTime(createdAt)} 的工作集`;
  const workspace = normalizeWorkspace({
    id: `session-${createdAt}`,
    name: workspaceName,
    createdAt,
    updatedAt: createdAt,
    activeUrl: activeTab ? activeTab.url : '',
    sourceWindowId,
    tabs: snapshots,
    groups
  });
  await runWorkspaceStorageMutation(async () => {
    const workspaceStored = await chrome.storage.local.get([STORAGE_KEYS.sessions]);
    const existingSessions = sortWorkspaces(workspaceStored[STORAGE_KEYS.sessions] || []);
    const sessions = [workspace, ...existingSessions].slice(0, settings.maxSessionCount);

    await chrome.storage.local.set({
      [STORAGE_KEYS.sessions]: sessions
    });
  });
  const pendingCleanup = await storePendingCleanup(workspace).catch(() => null);

  return {
    workspace,
    session: workspace,
    savedCount: snapshots.length,
    cleanupToken: pendingCleanup ? pendingCleanup.token : '',
    cleanupTabCount: pendingCleanup ? pendingCleanup.tabs.length : 0
  };
}

async function saveCurrentSession() {
  return saveWorkspace();
}

async function activateTabAcrossWindows(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new Error('目标标签无效');
  }

  const tab = await chrome.tabs.get(tabId);

  if (!tab || !Number.isInteger(tab.id)) {
    throw new Error('目标标签可能已关闭');
  }

  if (Number.isInteger(tab.windowId)) {
    // 跨窗口切换必须先聚焦窗口，否则只激活标签会让用户看不到目标页面。
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  await chrome.tabs.update(tab.id, { active: true });
  await recordRecentTabAccess(tab.id).catch(() => undefined);

  return {
    activated: true,
    windowId: Number.isInteger(tab.windowId) ? tab.windowId : null
  };
}

async function restoreClosedSession(sessionId) {
  const safeSessionId = String(sessionId || '').trim();

  if (!safeSessionId) {
    throw new Error('历史标签无效');
  }

  try {
    const restoredSession = await chrome.sessions.restore(safeSessionId);

    return {
      restored: true,
      sessionId: safeSessionId,
      tabId: restoredSession && restoredSession.tab && Number.isInteger(restoredSession.tab.id)
        ? restoredSession.tab.id
        : null,
      windowId: restoredSession && restoredSession.window && Number.isInteger(restoredSession.window.id)
        ? restoredSession.window.id
        : null
    };
  } catch (error) {
    // 最近关闭会话可能已经被 Chrome 清理或被新的关闭记录挤出，统一提示能避免暴露浏览器内部错误文案。
    throw new Error('历史标签可能已过期');
  }
}

async function closeSavedTabs(cleanupToken) {
  const pendingCleanup = await consumePendingCleanup(cleanupToken);
  const stored = await chrome.storage.local.get([STORAGE_KEYS.sessions]);
  const workspace = sortWorkspaces(stored[STORAGE_KEYS.sessions] || []).find((item) => {
    return item.id === pendingCleanup.workspaceId;
  });

  if (!workspace) {
    throw new Error('对应工作集已不存在，未关闭任何标签');
  }

  const workspaceTabMap = new Map(workspace.tabs.map((tab) => [
    tab.id,
    getTabUrl(tab)
  ]));
  let windowTabs = [];

  try {
    windowTabs = await queryWindowTabs(pendingCleanup.sourceWindowId);
  } catch (error) {
    return {
      closedCount: 0,
      skippedCount: pendingCleanup.tabs.length,
      failedCount: 0
    };
  }

  const sourceTabIds = new Set(windowTabs.map((tab) => tab.id));
  let closedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const target of pendingCleanup.tabs) {
    const savedUrl = workspaceTabMap.get(target.id);

    if (!savedUrl || savedUrl !== target.url || !sourceTabIds.has(target.id)) {
      skippedCount += 1;
      continue;
    }

    let currentTab;

    try {
      currentTab = await chrome.tabs.get(target.id);
    } catch (error) {
      skippedCount += 1;
      continue;
    }

    if (
      !currentTab
      || currentTab.windowId !== pendingCleanup.sourceWindowId
      || isBulkCloseProtectedTab(currentTab)
      || getTabUrl(currentTab) !== target.url
    ) {
      skippedCount += 1;
      continue;
    }

    try {
      await chrome.tabs.remove(target.id);
      closedCount += 1;
    } catch (error) {
      failedCount += 1;
    }
  }

  return {
    closedCount,
    skippedCount,
    failedCount
  };
}

async function getLastFocusedWindowForCloseGuard() {
  if (!chrome.windows || typeof chrome.windows.getLastFocused !== 'function') {
    return null;
  }

  try {
    return await chrome.windows.getLastFocused();
  } catch (error) {
    // 读取失败时先返回空值，由关闭逻辑统一拒绝，避免无法确认当前活动页时误关用户正在看的标签。
    return null;
  }
}

function isFocusedActiveTab(tab, focusedWindow) {
  return Boolean(
    tab
    && tab.active
    && focusedWindow
    && typeof focusedWindow.id === 'number'
    && tab.windowId === focusedWindow.id
  );
}

async function closeSearchResultTab(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new Error('目标标签无效');
  }

  let tab;

  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    throw new Error('关闭失败，标签可能已经不存在');
  }

  const focusedWindow = await getLastFocusedWindowForCloseGuard();

  if (!focusedWindow || typeof focusedWindow.id !== 'number') {
    // 无法确认当前活动页时必须拒绝关闭，因为活动标签可能就是用户正在操作的页面。
    throw new Error('该标签受保护，未关闭');
  }

  if (tab.pinned || tab.audible || isFocusedActiveTab(tab, focusedWindow)) {
    throw new Error('该标签受保护，未关闭');
  }

  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    throw new Error('关闭失败，请稍后重试');
  }

  return {
    closedTabId: tabId,
    title: tab.title || '',
    url: getTabUrl(tab)
  };
}

async function togglePriorityGroup(groupKey) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
  const existingIndex = settings.priorityGroups.findIndex((group) => group.groupKey === groupKey);
  let starred = false;

  if (existingIndex >= 0) {
    settings.priorityGroups.splice(existingIndex, 1);
    settings.priorityGroups = settings.priorityGroups.map((group, index) => Object.assign({}, group, {
      // 取消星标后压紧顺序，避免再次上移下移时历史空洞影响用户看到的位置。
      sortOrder: index
    }));
  } else {
    settings.priorityGroups.push({
      groupKey,
      title: groupKey,
      starredAt: Date.now(),
      sortOrder: settings.priorityGroups.length
    });
    starred = true;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });

  return {
    groupKey,
    starred,
    priorityCount: settings.priorityGroups.length
  };
}

async function movePriorityGroup(groupKey, direction) {
  let moved = false;
  let movedGroup = null;
  const settings = await updateStoredSettings((settings) => {
    const groupIndex = settings.priorityGroups.findIndex((group) => group.groupKey === groupKey);

    if (groupIndex < 0) {
      throw new Error('没有找到要移动的优先分组');
    }

    movedGroup = settings.priorityGroups[groupIndex];
    const targetIndex = direction === 'down' ? groupIndex + 1 : groupIndex - 1;

    if (targetIndex < 0 || targetIndex >= settings.priorityGroups.length) {
      // 边界移动保持幂等，原因是用户重复点击首项上移或末项下移时不应看到错误。
      return settings;
    }

    const nextPriorityGroups = settings.priorityGroups.slice();
    nextPriorityGroups[groupIndex] = nextPriorityGroups[targetIndex];
    nextPriorityGroups[targetIndex] = movedGroup;
    moved = true;

    return Object.assign({}, settings, {
      priorityGroups: nextPriorityGroups.map((group, index) => Object.assign({}, group, {
        sortOrder: index
      }))
    });
  });

  return {
    group: movedGroup,
    moved,
    settings
  };
}

function buildRuleForCreate(rule) {
  if (!rule) {
    throw new Error('分组规则不能为空');
  }

  const now = Date.now();
  const targetTitle = String(rule && rule.targetTitle ? rule.targetTitle : '').trim();
  const name = String(rule && rule.name ? rule.name : targetTitle).trim();
  const ruleForCreate = Object.assign({}, rule || {}, {
    id: `rule-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    targetTitle,
    // 新建规则用目标标题生成分组键，原因是后续改标题时仍需要稳定定位原浏览器分组。
    targetGroupKey: `custom:${targetTitle}`,
    createdAt: now,
    updatedAt: now
  });

  assertValidGroupRule(ruleForCreate);

  return normalizeGroupRule(ruleForCreate, ruleForCreate.id);
}

function assertValidGroupRule(rule) {
  if (!rule) {
    throw new Error('分组规则不能为空');
  }

  const identity = buildGroupRuleIdentity(rule);
  const targetTitle = String(rule && rule.targetTitle ? rule.targetTitle : '').trim();
  const conditionTree = normalizeConditionTree(rule && rule.conditionTree);
  const conditionCount = countConditionTreeConditions(conditionTree);

  if (!identity.name) {
    throw new Error('规则名称不能为空');
  }

  if (!targetTitle) {
    throw new Error('目标分组名不能为空');
  }

  if (!conditionTree || conditionCount === 0) {
    throw new Error('至少需要一个匹配条件');
  }

  if (conditionCount > MAX_GROUP_RULE_CONDITION_COUNT) {
    throw new Error(`每条规则最多 ${MAX_GROUP_RULE_CONDITION_COUNT} 个条件`);
  }
}

async function updateStoredSettings(updater) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
  const nextSettings = normalizeSettings(updater(settings));

  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: nextSettings });

  return nextSettings;
}

async function createGroupRule(ruleInput) {
  let createdRule = null;
  const settings = await updateStoredSettings((settings) => {
    createdRule = buildRuleForCreate(ruleInput);

    return Object.assign({}, settings, {
      // 追加到末尾是为了让用户新建规则默认优先级低于现有规则，避免抢占已有匹配。
      groupRules: settings.groupRules.concat(createdRule)
    });
  });

  return {
    rule: createdRule,
    settings
  };
}

async function updateGroupRule(ruleId, partialRule) {
  let updatedRule = null;
  const settings = await updateStoredSettings((settings) => {
    const ruleIndex = settings.groupRules.findIndex((rule) => rule.id === ruleId);

    if (ruleIndex < 0) {
      throw new Error('没有找到要更新的分组规则');
    }

    const currentRule = settings.groupRules[ruleIndex];

    if (
      partialRule
      && Object.prototype.hasOwnProperty.call(partialRule, 'name')
      && !String(partialRule.name || '').trim()
    ) {
      throw new Error('规则名称不能为空');
    }

    const candidateRule = Object.assign({}, currentRule, partialRule || {}, {
      id: currentRule.id,
      // 分组键是规则的稳定身份，禁止通过编辑入口修改，避免已存在分组被悄悄迁移。
      targetGroupKey: currentRule.targetGroupKey,
      createdAt: currentRule.createdAt,
      updatedAt: Date.now()
    });

    assertValidGroupRule(candidateRule);
    updatedRule = normalizeGroupRule(candidateRule, currentRule.id);

    const nextRules = settings.groupRules.slice();
    nextRules[ruleIndex] = updatedRule;

    return Object.assign({}, settings, {
      groupRules: nextRules
    });
  });

  return {
    rule: updatedRule,
    settings
  };
}

async function deleteGroupRule(ruleId) {
  let deletedRule = null;
  const settings = await updateStoredSettings((settings) => {
    const ruleIndex = settings.groupRules.findIndex((rule) => rule.id === ruleId);

    if (ruleIndex < 0) {
      throw new Error('没有找到要删除的分组规则');
    }

    deletedRule = settings.groupRules[ruleIndex];

    return Object.assign({}, settings, {
      groupRules: settings.groupRules.filter((rule) => rule.id !== ruleId)
    });
  });

  return {
    rule: deletedRule,
    settings
  };
}

async function moveGroupRule(ruleId, direction) {
  let moved = false;
  let movedRule = null;
  const settings = await updateStoredSettings((settings) => {
    const ruleIndex = settings.groupRules.findIndex((rule) => rule.id === ruleId);

    if (ruleIndex < 0) {
      throw new Error('没有找到要移动的分组规则');
    }

    movedRule = settings.groupRules[ruleIndex];
    const targetIndex = direction === 'down' ? ruleIndex + 1 : ruleIndex - 1;

    if (targetIndex < 0 || targetIndex >= settings.groupRules.length) {
      // 边界移动保持幂等，原因是前端重复点击置顶/置底规则不应产生错误提示。
      return settings;
    }

    const nextRules = settings.groupRules.slice();
    nextRules[ruleIndex] = nextRules[targetIndex];
    nextRules[targetIndex] = movedRule;
    moved = true;

    return Object.assign({}, settings, {
      groupRules: nextRules
    });
  });

  return {
    rule: movedRule,
    moved,
    settings
  };
}

async function updateSettings(partialSettings) {
  const settings = await updateStoredSettings((settings) => Object.assign(
    {},
    settings,
    partialSettings || {}
  ));
  const reconcileResult = await reconcileCurrentWindowGroupsFromNormalizedSettings(settings);

  return Object.assign({
    settings
  }, reconcileResult);
}

async function updateStoredWorkspaces(updater) {
  return runWorkspaceStorageMutation(async () => {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.sessions]);
    const workspaces = sortWorkspaces(stored[STORAGE_KEYS.sessions] || []);
    const nextWorkspaces = updater(workspaces).map(normalizeWorkspace);
    const sortedNextWorkspaces = sortWorkspaces(nextWorkspaces);

    await chrome.storage.local.set({
      [STORAGE_KEYS.sessions]: sortedNextWorkspaces
    });

    return sortedNextWorkspaces;
  });
}

async function renameWorkspace(workspaceId, name) {
  const trimmedName = String(name || '').trim();

  if (!trimmedName) {
    throw new Error('工作集名称不能为空');
  }

  let renamedWorkspace = null;

  await updateStoredWorkspaces((workspaces) => {
    return workspaces.map((workspace) => {
      if (workspace.id !== workspaceId) {
        return workspace;
      }

      renamedWorkspace = normalizeWorkspace(Object.assign({}, workspace, {
        name: trimmedName,
        updatedAt: Date.now()
      }));
      return renamedWorkspace;
    });
  });

  if (!renamedWorkspace) {
    throw new Error('没有找到要重命名的工作集');
  }

  return {
    workspace: renamedWorkspace
  };
}

async function deleteWorkspace(workspaceId) {
  let deletedCount = 0;

  await updateStoredWorkspaces((workspaces) => {
    return workspaces.filter((workspace) => {
      if (workspace.id === workspaceId) {
        deletedCount += 1;
        return false;
      }

      return true;
    });
  });

  if (deletedCount === 0) {
    throw new Error('没有找到要删除的工作集');
  }

  await clearPendingCleanupForWorkspace(workspaceId).catch(() => undefined);

  return {
    deletedCount
  };
}

async function toggleWorkspaceFavorite(workspaceId) {
  let updatedWorkspace = null;

  await updateStoredWorkspaces((workspaces) => {
    return workspaces.map((workspace) => {
      if (workspace.id !== workspaceId) {
        return workspace;
      }

      const nextFavorite = !workspace.favorite;
      updatedWorkspace = normalizeWorkspace(Object.assign({}, workspace, {
        favorite: nextFavorite,
        favoritedAt: nextFavorite ? Date.now() : 0,
        updatedAt: Date.now()
      }));
      return updatedWorkspace;
    });
  });

  if (!updatedWorkspace) {
    throw new Error('没有找到要收藏的工作集');
  }

  return {
    workspace: updatedWorkspace,
    favorite: updatedWorkspace.favorite
  };
}

function buildGroupSnapshots(tabs) {
  const groupMap = new Map();

  tabs.forEach((tab) => {
    const groupKey = tab.groupKey || '其他';
    const snapshot = groupMap.get(groupKey) || {
      groupKey,
      title: tab.groupTitle || groupKey,
      color: getGroupColor(groupMap.size),
      tabCount: 0
    };

    snapshot.tabCount += 1;
    groupMap.set(groupKey, snapshot);
  });

  return Array.from(groupMap.values());
}

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

async function restoreSession(sessionId, options = {}) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.sessions, STORAGE_KEYS.settings]);
  const sessions = sortWorkspaces(stored[STORAGE_KEYS.sessions] || []);
  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
  const session = sessions.find((item) => item.id === sessionId);

  if (!session) {
    throw new Error('没有找到要恢复的工作集');
  }

  const createdTabs = [];
  let failedCount = 0;
  let targetWindowId = Number.isInteger(options.targetWindowId) ? options.targetWindowId : null;
  let createdFirstRestorableTab = false;
  let groupingFailed = false;
  let activationFailed = false;

  if (options.newWindow) {
    const firstRestorableTab = session.tabs.find((tab) => {
      const url = getTabUrl(tab);

      return url && !url.startsWith('chrome://');
    });

    if (!firstRestorableTab) {
      throw new Error('工作集中没有可恢复的页面');
    }
    const firstRestorableUrl = getTabUrl(firstRestorableTab);

    const createdWindow = await chrome.windows.create({
      url: firstRestorableUrl,
      focused: true
    });
    targetWindowId = createdWindow.id;

    if (!Number.isInteger(targetWindowId)) {
      throw new Error('无法确定新建窗口');
    }

    createdFirstRestorableTab = true;

    if (createdWindow.tabs && createdWindow.tabs[0]) {
      const createdFirstTab = createdWindow.tabs[0];

      if (firstRestorableTab.pinned && typeof createdFirstTab.id === 'number') {
        // 新窗口首个标签无法在 windows.create 参数里声明固定，创建后补固定以保留工作集状态。
        await chrome.tabs.update(createdFirstTab.id, { pinned: true }).catch(() => undefined);
      }

      createdTabs.push(Object.assign({}, createdFirstTab, {
        title: firstRestorableTab.title || createdWindow.tabs[0].title,
        url: firstRestorableUrl,
        pinned: Boolean(firstRestorableTab.pinned)
      }));
    }
  } else {
    if (!Number.isInteger(targetWindowId)) {
      targetWindowId = await resolveCurrentWindowId();
    }

    // 恢复开始前先验证目标窗口，后续即使焦点变化也不得回退到新的当前窗口。
    await queryWindowTabs(targetWindowId);
  }

  for (const tab of session.tabs) {
    const url = getTabUrl(tab);

    if (!url || url.startsWith('chrome://')) {
      // Chrome 内部页面通常不允许扩展创建，跳过可以避免恢复流程整体失败。
      failedCount += 1;
      continue;
    }

    if (createdFirstRestorableTab) {
      // 新窗口创建必须先带一个 URL，这个首个页面已经存在，避免重复恢复同一条记录。
      createdFirstRestorableTab = false;
      continue;
    }

    try {
      const createdTab = await chrome.tabs.create({
        url,
        active: false,
        pinned: Boolean(tab.pinned),
        windowId: targetWindowId
      });
      createdTabs.push(Object.assign({}, createdTab, {
        title: tab.title || createdTab.title,
        url
      }));
    } catch (error) {
      failedCount += 1;
    }
  }

  // 恢复工作集可能发生在已有同名分组的窗口中，必须重新梳理整个目标窗口，且不能受恢复期间焦点变化影响。
  try {
    await reconcileWindowGroupsFromNormalizedSettings(targetWindowId, settings);
  } catch (error) {
    // 标签已经成功创建时不能把分组失败冒充成整体失败，否则用户重试会重复恢复全部页面。
    groupingFailed = true;
  }

  const tabToActivate = createdTabs.find((tab) => tab.url === session.activeUrl) || createdTabs[0];

  if (tabToActivate && typeof tabToActivate.id === 'number') {
    try {
      await chrome.tabs.update(tabToActivate.id, { active: true });
    } catch (error) {
      // 激活失败不影响已经恢复的标签，单独返回状态供前台说明。
      activationFailed = true;
    }
  }

  return {
    restoredCount: createdTabs.length,
    failedCount,
    groupingFailed,
    activationFailed,
    targetWindowId
  };
}

async function regroupRestoredTabs(tabs, settings = DEFAULT_SETTINGS) {
  const normalizedSettings = normalizeSettings(settings);
  const groups = new Map();
  const groupInfos = [];

  tabs.forEach((tab) => {
    if (tab.pinned || typeof tab.id !== 'number') {
      return;
    }

    const groupInfo = getResolvedGroupInfoFromNormalizedSettings(tab, normalizedSettings);
    const groupKey = groupInfo.groupKey;
    groupInfos.push(groupInfo);
    const groupTabs = groups.get(groupKey) || [];
    groupTabs.push(tab);
    groups.set(groupKey, groupTabs);
  });

  let groupIndex = 0;
  const titleMap = buildResolvedGroupTitleMapFromGroupInfos(groupInfos, normalizedSettings);

  for (const [groupKey, groupTabs] of groups.entries()) {
    if (!shouldCreateNativeGroupForTabsFromNormalizedSettings(groupTabs, normalizedSettings, groupKey)) {
      // 恢复工作集时沿用用户阈值，避免恢复后出现用户刚刚选择隐藏的低数量分组。
      continue;
    }

    const tabIds = groupTabs.map((tab) => tab.id);
    const groupId = await chrome.tabs.group({ tabIds }).catch(() => null);

    if (typeof groupId === 'number') {
      await chrome.tabGroups.update(groupId, {
        title: titleMap.get(groupKey) || groupKey,
        color: getGroupColor(groupIndex)
      });
      groupIndex += 1;
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : '操作失败'
      });
    });

  return true;
});

async function showCommandBadge(text, color) {
  if (
    !chrome.action
    || typeof chrome.action.setBadgeText !== 'function'
    || typeof chrome.action.setBadgeBackgroundColor !== 'function'
  ) {
    return;
  }

  try {
    if (commandBadgeClearTimer && typeof globalThis.clearTimeout === 'function') {
      globalThis.clearTimeout(commandBadgeClearTimer);
    }

    await Promise.all([
      chrome.action.setBadgeBackgroundColor({ color }),
      chrome.action.setBadgeText({ text })
    ]);

    if (typeof globalThis.setTimeout === 'function') {
      commandBadgeClearTimer = globalThis.setTimeout(() => {
        Promise.resolve(chrome.action.setBadgeText({ text: '' })).catch(() => undefined);
      }, COMMAND_BADGE_CLEAR_DELAY_MS);
    }
  } catch (error) {
    // 徽标只是反馈通道，更新失败不能反过来影响整理或保存结果。
  }
}

async function handleCommand(command) {
  const operationMap = {
    'organize-tabs': organizeTabs,
    'save-session': saveCurrentSession
  };
  const operation = operationMap[command];

  if (!operation) {
    return { handled: false, success: false };
  }

  try {
    const result = await operation();
    await showCommandBadge('✓', COMMAND_BADGE_SUCCESS_COLOR);
    return { handled: true, success: true, result };
  } catch (error) {
    await showCommandBadge('!', COMMAND_BADGE_ERROR_COLOR);
    return {
      handled: true,
      success: false,
      error: error && error.message ? error.message : '操作失败'
    };
  }
}

chrome.commands.onCommand.addListener((command) => {
  // 快捷键没有前台状态区域，统一通过徽标反馈，并在内部消化错误避免未处理拒绝。
  handleCommand(command);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  // 事件记录只作为 lastAccessed 缺失时的排序兜底，失败不影响标签切换主流程。
  recordRecentTabAccess(activeInfo.tabId).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // 标签关闭后清理本地记录，避免已关闭标签长期占用最近使用存储。
  removeRecentTabAccess(tabId).catch(() => undefined);
});

async function handleMessage(message) {
  const action = message && message.action;

  if (action === 'get-recently-closed-tabs') {
    return getRecentlyClosedState();
  }

  if (action === 'get-management-state') {
    return getManagementState();
  }

  if (action === 'get-duplicate-overview') {
    return getDuplicateOverview();
  }

  if (action === 'organize-tabs') {
    return organizeTabs();
  }

  if (action === 'scan-duplicates') {
    return scanDuplicateTabs(message.windowId);
  }

  if (action === 'close-selected-duplicates') {
    return closeSelectedDuplicateTabs(message.windowId, message.groups);
  }

  if (action === 'close-search-result-tab') {
    return closeSearchResultTab(message.tabId);
  }

  if (action === 'save-workspace') {
    return saveWorkspace(message.name, { sourceWindowId: message.sourceWindowId });
  }

  if (action === 'close-saved-tabs') {
    return closeSavedTabs(message.cleanupToken);
  }

  if (action === 'restore-workspace') {
    return restoreSession(message.workspaceId || message.sessionId, {
      targetWindowId: message.targetWindowId
    });
  }

  if (action === 'restore-workspace-new-window') {
    return restoreSession(message.workspaceId || message.sessionId, { newWindow: true });
  }

  if (action === 'rename-workspace') {
    return renameWorkspace(message.workspaceId, message.name);
  }

  if (action === 'delete-workspace') {
    return deleteWorkspace(message.workspaceId);
  }

  if (action === 'toggle-workspace-favorite') {
    return toggleWorkspaceFavorite(message.workspaceId);
  }

  if (action === 'save-session') {
    return saveWorkspace(message.name);
  }

  if (action === 'restore-session') {
    return restoreSession(message.sessionId, {
      targetWindowId: message.targetWindowId
    });
  }

  if (action === 'toggle-priority-group') {
    return togglePriorityGroup(message.groupKey);
  }

  if (action === 'move-priority-group') {
    return movePriorityGroup(message.groupKey, message.direction);
  }

  if (action === 'create-group-rule') {
    return createGroupRule(message.rule);
  }

  if (action === 'update-group-rule') {
    return updateGroupRule(message.ruleId, message.rule);
  }

  if (action === 'delete-group-rule') {
    return deleteGroupRule(message.ruleId);
  }

  if (action === 'move-group-rule') {
    return moveGroupRule(message.ruleId, message.direction);
  }

  if (action === 'update-settings') {
    return updateSettings(message.settings);
  }

  if (action === 'activate-tab') {
    return activateTabAcrossWindows(message.tabId);
  }

  if (action === 'restore-closed-session') {
    return restoreClosedSession(message.sessionId);
  }

  throw new Error('未知操作');
}
