const STORAGE_KEYS = {
  sessions: 'tabgod.sessions',
  settings: 'tabgod.settings',
  recentAccess: 'tabgod.recentAccess'
};

const DEFAULT_SETTINGS = {
  // 限制保存数量是为了避免本地存储无限增长，同时保留最近的工作现场。
  maxSessionCount: 10,
  // 默认至少两个同主域名标签才建组，原因是单标签分组通常只会增加标签栏噪音。
  minTabsPerGroup: 2,
  organizeWithGroups: true,
  duplicateKeepStrategy: 'active-or-left',
  priorityGroups: []
};

// 只保留最近 300 个标签激活记录，原因是该记录只用于排序兜底，过多历史会浪费本地存储。
const RECENT_ACCESS_LIMIT = 300;

const GROUP_COLORS = ['blue', 'green', 'yellow', 'red', 'purple', 'cyan', 'orange', 'pink', 'grey'];

// 浏览器没有内置可注册主域名 API，这里保留常见多级公共后缀，避免把站点错误合并到公共后缀本身。
const COMMON_MULTI_PART_PUBLIC_SUFFIXES = new Set([
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'co.uk',
  'org.uk',
  'ac.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.jp',
  'ne.jp',
  'or.jp',
  'co.kr',
  'or.kr',
  'com.br',
  'com.mx',
  'com.sg',
  'com.hk',
  'com.tw'
]);

const TRACKING_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'ref',
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

function isIpAddressHost(hostname) {
  // IP 地址没有可注册主域名，保持原值可以避免把不同内网服务错误合并。
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}

function getPrimaryDomainFromHostname(hostname) {
  const normalizedHostname = String(hostname || '').toLowerCase().replace(/\.$/, '');

  if (!normalizedHostname) {
    return '其他';
  }

  if (isIpAddressHost(normalizedHostname)) {
    return normalizedHostname;
  }

  const parts = normalizedHostname.split('.').filter(Boolean);

  if (parts.length <= 2) {
    // 短主机名和二段域名本身已经是最稳定的分组键，不需要继续裁剪。
    return normalizedHostname;
  }

  const publicSuffix = parts.slice(-2).join('.');

  if (COMMON_MULTI_PART_PUBLIC_SUFFIXES.has(publicSuffix) && parts.length >= 3) {
    // 多级公共后缀需要保留注册名，否则 example.com.cn 会被错误合并为 com.cn。
    return parts.slice(-3).join('.');
  }

  return parts.slice(-2).join('.');
}

function getDomainKey(url) {
  try {
    const parsedUrl = new URL(url);
    return getPrimaryDomainFromHostname(parsedUrl.hostname);
  } catch (error) {
    // 无法解析的网址通常来自浏览器内部页面，归入“其他”能避免整理流程中断。
    return '其他';
  }
}

function getHostnameKey(url) {
  try {
    const parsedUrl = new URL(url);
    return String(parsedUrl.hostname || '其他').toLowerCase().replace(/\.$/, '');
  } catch (error) {
    // 异常网址没有可靠子域名，使用“其他”可以让它们在主域名兜底组内稳定排序。
    return '其他';
  }
}

function getGroupColor(index) {
  // Chrome 原生分组颜色数量有限，循环使用可以保证任意数量主域名都有稳定颜色。
  return GROUP_COLORS[index % GROUP_COLORS.length];
}

function normalizeMinTabsPerGroup(value) {
  const numericValue = typeof value === 'number' ? value : Number.NaN;

  if (!Number.isInteger(numericValue) || numericValue < 1) {
    // 阈值必须至少为 1，原因是 0 或负数会让“至少几个标签才分组”的语义失效。
    return DEFAULT_SETTINGS.minTabsPerGroup;
  }

  return numericValue;
}

function normalizeSettings(settings) {
  const normalized = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  normalized.minTabsPerGroup = normalizeMinTabsPerGroup(normalized.minTabsPerGroup);

  if (!Array.isArray(normalized.priorityGroups)) {
    // 旧版本没有该字段，兜底为空数组可以兼容已经安装过的用户配置。
    normalized.priorityGroups = [];
  }

  return normalized;
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
    tabs: Array.isArray(workspace && workspace.tabs) ? workspace.tabs : [],
    groups: Array.isArray(workspace && workspace.groups) ? workspace.groups : []
  });
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

  // 所有建组入口统一走这里，避免整理和恢复使用不同阈值。
  return Array.isArray(tabIds) && tabIds.length >= normalizedSettings.minTabsPerGroup;
}

function getShortGroupTitle(groupKey) {
  const normalizedGroupKey = String(groupKey || '其他').toLowerCase().replace(/\.$/, '');

  if (!normalizedGroupKey || normalizedGroupKey === '其他' || isIpAddressHost(normalizedGroupKey)) {
    // 无法确认公共后缀的特殊分组保持原样，避免把兜底名称或 IP 地址截断成难懂内容。
    return normalizedGroupKey || '其他';
  }

  const parts = normalizedGroupKey.split('.').filter(Boolean);

  if (parts.length <= 1) {
    return normalizedGroupKey;
  }

  const multiPartSuffix = parts.slice(-2).join('.');

  if (COMMON_MULTI_PART_PUBLIC_SUFFIXES.has(multiPartSuffix)) {
    // 多级公共后缀要整体省略，否则 example.com.cn 会只变成 example.com。
    return parts.slice(0, -2).join('.') || normalizedGroupKey;
  }

  return parts.slice(0, -1).join('.') || normalizedGroupKey;
}

function buildGroupTitleMap(groupKeys) {
  const uniqueGroupKeys = Array.from(new Set((Array.isArray(groupKeys) ? groupKeys : [])
    .map((groupKey) => String(groupKey || '其他'))));
  const titleBuckets = new Map();
  const titleMap = new Map();

  uniqueGroupKeys.forEach((groupKey) => {
    const shortTitle = getShortGroupTitle(groupKey);
    const bucket = titleBuckets.get(shortTitle) || [];
    bucket.push(groupKey);
    titleBuckets.set(shortTitle, bucket);
  });

  uniqueGroupKeys.forEach((groupKey) => {
    const shortTitle = getShortGroupTitle(groupKey);
    const conflictGroupKeys = titleBuckets.get(shortTitle) || [];

    // 短名冲突时回退完整主域名，原因是 foo.com 和 foo.net 不能都显示成 foo。
    titleMap.set(groupKey, conflictGroupKeys.length > 1 ? groupKey : shortTitle);
  });

  return titleMap;
}

function buildWindowOrderMap(tabs, currentWindowId) {
  const currentId = Number.isInteger(currentWindowId) ? currentWindowId : null;
  const windowIds = Array.from(new Set((Array.isArray(tabs) ? tabs : [])
    .map((tab) => tab.windowId)
    .filter((windowId) => Number.isInteger(windowId))));
  const orderedIds = [];

  if (currentId !== null && windowIds.includes(currentId)) {
    orderedIds.push(currentId);
  }

  windowIds
    .filter((windowId) => windowId !== currentId)
    .sort((left, right) => left - right)
    .forEach((windowId) => orderedIds.push(windowId));

  return new Map(orderedIds.map((windowId, index) => [windowId, index + 1]));
}

function getWindowLabel(windowId, currentWindowId, windowOrderMap) {
  if (Number.isInteger(windowId) && windowId === currentWindowId) {
    return '当前窗口';
  }

  // 非当前窗口只提示来源差异，不暴露用户难以理解的内部编号。
  return '其他窗口';
}

function getTabLastAccessedAt(tab, recentAccessMap = {}) {
  if (Number.isFinite(tab && tab.lastAccessed)) {
    return tab.lastAccessed;
  }

  const recentAccessedAt = recentAccessMap && recentAccessMap[String(tab && tab.id)];

  if (Number.isFinite(recentAccessedAt)) {
    // 旧版本浏览器可能没有 lastAccessed，本地激活记录用于保持最近使用排序可用。
    return recentAccessedAt;
  }

  return 0;
}

function buildSearchTabSnapshots(tabs, context = {}) {
  const safeTabs = Array.isArray(tabs) ? tabs : [];
  const currentWindowId = Number.isInteger(context.currentWindowId) ? context.currentWindowId : null;
  const recentAccessMap = context.recentAccessMap || {};
  const titleMap = buildGroupTitleMap(safeTabs.map((tab) => getDomainKey(tab.url || '')));
  const windowOrderMap = buildWindowOrderMap(safeTabs, currentWindowId);

  return safeTabs.map((tab) => {
    const groupKey = getDomainKey(tab.url || '');

    return Object.assign({}, buildTabSnapshot(tab), {
      windowId: Number.isInteger(tab.windowId) ? tab.windowId : null,
      groupTitle: titleMap.get(groupKey) || groupKey,
      isCurrentWindow: Number.isInteger(tab.windowId) && tab.windowId === currentWindowId,
      windowLabel: getWindowLabel(tab.windowId, currentWindowId, windowOrderMap),
      lastAccessedAt: getTabLastAccessedAt(tab, recentAccessMap)
    });
  });
}

function isPriorityGroup(settings, groupKey) {
  return settings.priorityGroups.some((group) => group.groupKey === groupKey);
}

function buildCurrentGroupOrderMap(tabs) {
  const orderMap = new Map();

  tabs.forEach((tab) => {
    if (tab.pinned) {
      return;
    }

    const groupKey = getDomainKey(tab.url || '');

    if (!orderMap.has(groupKey)) {
      // 当前从左到右的首次出现顺序代表用户刚刚手动拖好的分组顺序。
      orderMap.set(groupKey, orderMap.size);
    }
  });

  return orderMap;
}

function buildGroupableDomainSet(tabs, settings) {
  const normalizedSettings = normalizeSettings(settings);
  const domainTabIds = new Map();

  (Array.isArray(tabs) ? tabs : []).forEach((tab) => {
    if (tab.pinned || typeof tab.id !== 'number') {
      return;
    }

    const groupKey = getDomainKey(tab.url || '');
    const tabIds = domainTabIds.get(groupKey) || [];
    tabIds.push(tab.id);
    domainTabIds.set(groupKey, tabIds);
  });

  return new Set(Array.from(domainTabIds.entries())
    .filter(([, tabIds]) => {
      // 排序阶段必须复用真实建组阈值，否则单标签主域名会被当成分组插到原生分组之前。
      return shouldCreateNativeGroup(tabIds, normalizedSettings);
    })
    .map(([groupKey]) => groupKey));
}

function buildOrganizedTabs(tabs, settings) {
  const safeTabs = Array.isArray(tabs) ? tabs : [];
  const normalizedSettings = normalizeSettings(settings);
  const currentGroupOrderMap = buildCurrentGroupOrderMap(safeTabs);
  const groupableDomainSet = buildGroupableDomainSet(safeTabs, normalizedSettings);

  return [...safeTabs].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    const leftDomain = getDomainKey(left.url || '');
    const rightDomain = getDomainKey(right.url || '');
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

    const leftCurrentRank = currentGroupOrderMap.get(leftDomain) ?? Number.POSITIVE_INFINITY;
    const rightCurrentRank = currentGroupOrderMap.get(rightDomain) ?? Number.POSITIVE_INFINITY;

    if (leftCurrentRank !== rightCurrentRank) {
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

async function queryCurrentWindowTabs() {
  return chrome.tabs.query({ currentWindow: true });
}

async function queryAllWindowTabs() {
  return chrome.tabs.query({});
}

function buildTabSnapshot(tab) {
  const groupKey = getDomainKey(tab.url || '');

  return {
    id: tab.id,
    title: tab.title || '未命名标签',
    url: tab.url || '',
    favIconUrl: tab.favIconUrl || '',
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    index: Number.isInteger(tab.index) ? tab.index : 0,
    groupKey
  };
}

function buildTabSnapshots(tabs) {
  const snapshots = tabs.map(buildTabSnapshot);
  const titleMap = buildGroupTitleMap(snapshots.map((tab) => tab.groupKey));

  return snapshots.map((snapshot) => Object.assign({}, snapshot, {
    groupTitle: titleMap.get(snapshot.groupKey) || snapshot.groupKey
  }));
}

function chooseDuplicateKeepTab(tabs) {
  const sortedTabs = [...tabs].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    if (left.active !== right.active) {
      return left.active ? -1 : 1;
    }

    return left.index - right.index;
  });

  return sortedTabs[0];
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
      .filter((tab) => tab.id !== keepTab.id)
      .sort((left, right) => left.index - right.index);

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
  const allTabs = await queryAllWindowTabs();
  const duplicateCount = buildDuplicateGroups(allTabs).reduce((total, group) => {
    return total + group.closeCount;
  }, 0);

  return {
    duplicateCount
  };
}

async function getPopupState() {
  const [tabs, allTabs, stored] = await Promise.all([
    queryCurrentWindowTabs(),
    queryAllWindowTabs(),
    chrome.storage.local.get([
      STORAGE_KEYS.sessions,
      STORAGE_KEYS.settings,
      STORAGE_KEYS.recentAccess
    ])
  ]);
  const activeTab = tabs.find((tab) => tab.active);
  const currentWindowId = activeTab && Number.isInteger(activeTab.windowId) ? activeTab.windowId : null;
  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
  const recentAccessMap = normalizeRecentAccessMap(stored[STORAGE_KEYS.recentAccess]);
  const searchTabs = buildSearchTabSnapshots(allTabs, {
    currentWindowId,
    recentAccessMap
  });
  const windowCount = new Set(searchTabs
    .map((tab) => tab.windowId)
    .filter((windowId) => Number.isInteger(windowId))).size;

  return {
    tabs: searchTabs,
    groups: buildGroupSummaries(tabs, settings),
    overview: Object.assign({}, buildOverview(tabs), {
      allTabCount: searchTabs.length,
      windowCount
    }),
    sessions: sortWorkspaces(stored[STORAGE_KEYS.sessions] || []),
    settings,
    currentWindowId
  };
}

async function organizeTabs() {
  const tabs = await queryCurrentWindowTabs();
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);

  if (tabs.length === 0) {
    return { organizedCount: 0, groupCount: 0 };
  }

  const sortedTabs = buildOrganizedTabs(tabs, settings);

  for (let index = 0; index < sortedTabs.length; index += 1) {
    const tab = sortedTabs[index];

    if (typeof tab.id === 'number') {
      // 逐个移动可以减少跨固定标签区域移动导致的失败，失败标签不会阻断后续整理。
      await chrome.tabs.move(tab.id, { index }).catch(() => undefined);
    }
  }

  const reconcileResult = await reconcileCurrentWindowGroups(settings);

  return {
    organizedCount: tabs.length,
    groupCount: reconcileResult.groupedCount
  };
}

async function reconcileCurrentWindowGroups(settings) {
  const normalizedSettings = normalizeSettings(settings);
  const tabs = await queryCurrentWindowTabs();
  const groups = new Map();

  tabs.forEach((tab) => {
    if (tab.pinned || typeof tab.id !== 'number') {
      return;
    }

    const groupKey = getDomainKey(tab.url || '');
    const groupTabs = groups.get(groupKey) || [];
    groupTabs.push(tab);
    groups.set(groupKey, groupTabs);
  });

  let groupedCount = 0;
  let ungroupedTabCount = 0;
  const titleMap = buildGroupTitleMap(Array.from(groups.keys()));

  for (const [groupKey, groupTabs] of groups.entries()) {
    const tabIds = groupTabs.map((tab) => tab.id);

    if (!shouldCreateNativeGroup(tabIds, normalizedSettings)) {
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

function buildGroupSummaries(tabs, settings) {
  const normalizedSettings = normalizeSettings(settings);
  const groupMap = new Map();
  const currentGroupOrderMap = buildCurrentGroupOrderMap(tabs);

  tabs.forEach((tab) => {
    if (tab.pinned || typeof tab.id !== 'number') {
      return;
    }

    const groupKey = getDomainKey(tab.url || '');
    const summary = groupMap.get(groupKey) || {
      groupKey,
      title: groupKey,
      tabCount: 0,
      tabIds: [],
      starred: isPriorityGroup(settings, groupKey),
      currentOrder: currentGroupOrderMap.get(groupKey) ?? Number.POSITIVE_INFINITY
    };

    summary.tabCount += 1;
    summary.tabIds.push(tab.id);
    groupMap.set(groupKey, summary);
  });

  const groupSummaries = Array.from(groupMap.values()).filter((summary) => {
    // 优先分组列表只展示真实会创建原生分组的项，避免单标签主域名出现无意义星标入口。
    return shouldCreateNativeGroup(summary.tabIds, normalizedSettings);
  });
  const titleMap = buildGroupTitleMap(groupSummaries.map((summary) => summary.groupKey));

  return groupSummaries.sort((left, right) => {
    if (left.starred !== right.starred) {
      return left.starred ? -1 : 1;
    }

    if (left.currentOrder !== right.currentOrder) {
      return left.currentOrder - right.currentOrder;
    }

    return left.groupKey.localeCompare(right.groupKey, 'zh-CN');
  }).map((summary) => ({
    groupKey: summary.groupKey,
    title: titleMap.get(summary.groupKey) || summary.groupKey,
    tabCount: summary.tabCount,
    starred: summary.starred,
    currentOrder: summary.currentOrder
  }));
}

async function scanDuplicateTabs() {
  const tabs = await queryCurrentWindowTabs();

  return {
    groups: buildDuplicateGroups(tabs)
  };
}

async function closeSelectedDuplicateTabs(tabIds) {
  const safeTabIds = Array.from(new Set(Array.isArray(tabIds) ? tabIds : []))
    .filter((tabId) => Number.isInteger(tabId));

  if (safeTabIds.length === 0) {
    return {
      closedCount: 0,
      failedCount: 0
    };
  }

  try {
    await chrome.tabs.remove(safeTabIds);
    return {
      closedCount: safeTabIds.length,
      failedCount: 0
    };
  } catch (error) {
    // 批量关闭失败时逐个重试，因为用户可能在确认期间手动关闭了部分标签。
    let closedCount = 0;

    for (const tabId of safeTabIds) {
      try {
        await chrome.tabs.remove(tabId);
        closedCount += 1;
      } catch (innerError) {
        // 单个标签失败只影响统计，不应阻断后续可关闭标签的清理。
      }
    }

    return {
      closedCount,
      failedCount: safeTabIds.length - closedCount
    };
  }
}

async function closeDuplicateTabs() {
  const tabs = await queryCurrentWindowTabs();
  const duplicateGroups = buildDuplicateGroups(tabs);
  const tabIdsToClose = duplicateGroups.flatMap((group) => group.closeTabIds);
  const result = await closeSelectedDuplicateTabs(tabIdsToClose);

  return {
    closedCount: result.closedCount,
    failedCount: result.failedCount
  };
}

async function saveWorkspace(name) {
  const tabs = await queryCurrentWindowTabs();
  const stored = await chrome.storage.local.get([STORAGE_KEYS.sessions, STORAGE_KEYS.settings]);
  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
  const existingSessions = sortWorkspaces(stored[STORAGE_KEYS.sessions] || []);
  const createdAt = Date.now();
  const snapshots = tabs.map(buildTabSnapshot);
  const activeTab = snapshots.find((tab) => tab.active);
  const groups = buildGroupSnapshots(snapshots);
  const workspaceName = String(name || '').trim() || `${formatDateTime(createdAt)} 的工作集`;
  const workspace = normalizeWorkspace({
    id: `session-${createdAt}`,
    name: workspaceName,
    createdAt,
    updatedAt: createdAt,
    activeUrl: activeTab ? activeTab.url : '',
    tabs: snapshots,
    groups
  });
  const sessions = [workspace, ...existingSessions].slice(0, settings.maxSessionCount);

  await chrome.storage.local.set({
    [STORAGE_KEYS.sessions]: sessions,
    [STORAGE_KEYS.settings]: settings
  });

  return {
    workspace,
    session: workspace,
    savedCount: snapshots.length,
    savedTabIds: snapshots
      .map((tab) => tab.id)
      .filter((tabId) => Number.isInteger(tabId))
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

async function closeSavedTabs(tabIds) {
  const safeTabIds = Array.from(new Set(Array.isArray(tabIds) ? tabIds : []))
    .filter((tabId) => Number.isInteger(tabId));

  if (safeTabIds.length === 0) {
    return {
      closedCount: 0,
      failedCount: 0
    };
  }

  let closedCount = 0;

  for (const tabId of safeTabIds) {
    try {
      await chrome.tabs.remove(tabId);
      closedCount += 1;
    } catch (error) {
      // 保存成功后用户仍可能手动关闭标签，失败项只反馈数量，避免清场中断。
    }
  }

  return {
    closedCount,
    failedCount: safeTabIds.length - closedCount
  };
}

async function togglePriorityGroup(groupKey) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
  const existingIndex = settings.priorityGroups.findIndex((group) => group.groupKey === groupKey);
  let starred = false;

  if (existingIndex >= 0) {
    settings.priorityGroups.splice(existingIndex, 1);
  } else {
    settings.priorityGroups.push({
      groupKey,
      title: groupKey,
      starredAt: Date.now()
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

async function updateSettings(partialSettings) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  const settings = normalizeSettings(Object.assign(
    {},
    stored[STORAGE_KEYS.settings] || {},
    partialSettings || {}
  ));

  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  const reconcileResult = await reconcileCurrentWindowGroups(settings);

  return Object.assign({
    settings
  }, reconcileResult);
}

async function updateStoredWorkspaces(updater) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.sessions]);
  const workspaces = sortWorkspaces(stored[STORAGE_KEYS.sessions] || []);
  const nextWorkspaces = updater(workspaces).map(normalizeWorkspace);
  const sortedNextWorkspaces = sortWorkspaces(nextWorkspaces);

  await chrome.storage.local.set({
    [STORAGE_KEYS.sessions]: sortedNextWorkspaces
  });

  return sortedNextWorkspaces;
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

  const titleMap = buildGroupTitleMap(Array.from(groupMap.keys()));

  return Array.from(groupMap.values()).map((snapshot) => Object.assign({}, snapshot, {
    title: titleMap.get(snapshot.groupKey) || snapshot.title
  }));
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
  let targetWindowId = null;
  let createdFirstRestorableTab = false;

  if (options.newWindow) {
    const firstRestorableTab = session.tabs.find((tab) => tab.url && !tab.url.startsWith('chrome://'));

    if (!firstRestorableTab) {
      throw new Error('工作集中没有可恢复的页面');
    }

    const createdWindow = await chrome.windows.create({
      url: firstRestorableTab.url,
      focused: true
    });
    targetWindowId = createdWindow.id;
    createdFirstRestorableTab = true;

    if (createdWindow.tabs && createdWindow.tabs[0]) {
      createdTabs.push(Object.assign({}, createdWindow.tabs[0], {
        groupKey: firstRestorableTab.groupKey
      }));
    }
  }

  for (const tab of session.tabs) {
    if (!tab.url || tab.url.startsWith('chrome://')) {
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
        url: tab.url,
        active: false,
        pinned: Boolean(tab.pinned),
        windowId: targetWindowId || undefined
      });
      createdTabs.push(Object.assign({}, createdTab, { groupKey: tab.groupKey }));
    } catch (error) {
      failedCount += 1;
    }
  }

  await regroupRestoredTabs(createdTabs, settings);

  const tabToActivate = createdTabs.find((tab) => tab.url === session.activeUrl) || createdTabs[0];

  if (tabToActivate && typeof tabToActivate.id === 'number') {
    await chrome.tabs.update(tabToActivate.id, { active: true });
  }

  return {
    restoredCount: createdTabs.length,
    failedCount
  };
}

async function regroupRestoredTabs(tabs, settings = DEFAULT_SETTINGS) {
  const groups = new Map();

  tabs.forEach((tab) => {
    if (tab.pinned || typeof tab.id !== 'number') {
      return;
    }

    const groupKey = tab.groupKey || getDomainKey(tab.url || '');
    const groupTabs = groups.get(groupKey) || [];
    groupTabs.push(tab.id);
    groups.set(groupKey, groupTabs);
  });

  let groupIndex = 0;
  const titleMap = buildGroupTitleMap(Array.from(groups.keys()));

  for (const [groupKey, tabIds] of groups.entries()) {
    if (!shouldCreateNativeGroup(tabIds, settings)) {
      // 恢复工作集时沿用用户阈值，避免恢复后出现用户刚刚选择隐藏的低数量分组。
      continue;
    }

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

chrome.commands.onCommand.addListener((command) => {
  if (command === 'organize-tabs') {
    organizeTabs().catch(() => undefined);
  }

  if (command === 'save-session') {
    // 快捷键没有前台提示通道，捕获异常可以避免后台服务出现未处理拒绝。
    saveCurrentSession().catch(() => undefined);
  }
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

  if (action === 'get-state') {
    return getPopupState();
  }

  if (action === 'get-duplicate-overview') {
    return getDuplicateOverview();
  }

  if (action === 'organize-tabs') {
    return organizeTabs();
  }

  if (action === 'close-duplicates') {
    return closeDuplicateTabs();
  }

  if (action === 'scan-duplicates') {
    return scanDuplicateTabs();
  }

  if (action === 'close-selected-duplicates') {
    return closeSelectedDuplicateTabs(message.tabIds);
  }

  if (action === 'save-workspace') {
    return saveWorkspace(message.name);
  }

  if (action === 'close-saved-tabs') {
    return closeSavedTabs(message.tabIds);
  }

  if (action === 'restore-workspace') {
    return restoreSession(message.workspaceId || message.sessionId);
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
    return restoreSession(message.sessionId);
  }

  if (action === 'toggle-priority-group') {
    return togglePriorityGroup(message.groupKey);
  }

  if (action === 'update-settings') {
    return updateSettings(message.settings);
  }

  if (action === 'activate-tab') {
    return activateTabAcrossWindows(message.tabId);
  }

  if (action === 'close-tab') {
    await chrome.tabs.remove(message.tabId);
    return { closed: true };
  }

  throw new Error('未知操作');
}
