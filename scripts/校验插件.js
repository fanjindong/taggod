const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const rootDir = path.resolve(__dirname, '..');
const requiredFiles = [
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'README.md',
  'assets/logo.png',
  'assets/icons/icon-source.png',
  'assets/icons/icon-16.png',
  'assets/icons/icon-32.png',
  'assets/icons/icon-48.png',
  'assets/icons/icon-128.png'
];

for (const file of requiredFiles) {
  const filePath = path.join(rootDir, file);

  if (!fs.existsSync(filePath)) {
    throw new Error(`缺少必要文件：${file}`);
  }
}

const manifestPath = path.join(rootDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (manifest.manifest_version !== 3) {
  throw new Error('manifest.json 必须使用 Manifest V3');
}

if (!manifest.permissions.includes('tabs') || !manifest.permissions.includes('tabGroups') || !manifest.permissions.includes('storage')) {
  throw new Error('manifest.json 缺少必要权限');
}

if (!manifest.icons || !manifest.action || !manifest.action.default_icon) {
  throw new Error('manifest.json 必须声明插件图标');
}

for (const scriptFile of ['background.js', 'popup.js']) {
  const scriptPath = path.join(rootDir, scriptFile);
  const scriptContent = fs.readFileSync(scriptPath, 'utf8');

  // 使用 vm.Script 只做语法解析，不执行浏览器专属 API，避免在 Node 环境误触发逻辑。
  new vm.Script(scriptContent, { filename: scriptFile });
}

const backgroundPath = path.join(rootDir, 'background.js');
const backgroundContent = fs.readFileSync(backgroundPath, 'utf8');
const backgroundSandbox = {
  URL,
  chrome: {
    runtime: {
      onMessage: {
        addListener() {}
      }
    },
    commands: {
      onCommand: {
        addListener() {}
      }
    },
    tabs: {
      onActivated: {
        addListener() {}
      },
      onRemoved: {
        addListener() {}
      }
    }
  }
};

vm.createContext(backgroundSandbox);
vm.runInContext(backgroundContent, backgroundSandbox, { filename: 'background.js' });

// 主域名归并是核心分组契约，校验脚本覆盖它可以避免后续改动退回完整域名分组。
assert.strictEqual(backgroundSandbox.getDomainKey('https://mail.google.com/inbox'), 'google.com');
assert.strictEqual(backgroundSandbox.getDomainKey('https://docs.google.com/document'), 'google.com');
assert.strictEqual(backgroundSandbox.getDomainKey('https://a.example.com.cn/path'), 'example.com.cn');
assert.strictEqual(backgroundSandbox.getDomainKey('http://localhost:3000'), 'localhost');
assert.strictEqual(backgroundSandbox.getDomainKey('http://127.0.0.1:8080'), '127.0.0.1');
assert.strictEqual(backgroundSandbox.getDomainKey('不是有效网址'), '其他');
assert.strictEqual(backgroundSandbox.getHostnameKey('https://mail.google.com/inbox'), 'mail.google.com');
assert.strictEqual(backgroundSandbox.getHostnameKey('不是有效网址'), '其他');

assert.strictEqual(backgroundSandbox.normalizeSettings({}).minTabsPerGroup, 2);
assert.strictEqual(backgroundSandbox.normalizeSettings({ minTabsPerGroup: 3 }).minTabsPerGroup, 3);
assert.strictEqual(backgroundSandbox.normalizeSettings({ minTabsPerGroup: 0 }).minTabsPerGroup, 2);
assert.strictEqual(backgroundSandbox.normalizeSettings({ minTabsPerGroup: 1 }).minTabsPerGroup, 1);
assert.strictEqual(backgroundSandbox.normalizeSettings({ minTabsPerGroup: 2.5 }).minTabsPerGroup, 2);
assert.strictEqual(backgroundSandbox.normalizeSettings({ minTabsPerGroup: '3' }).minTabsPerGroup, 2);
assert.strictEqual(backgroundSandbox.shouldCreateNativeGroup([1, 2], { minTabsPerGroup: 2 }), true);
assert.strictEqual(backgroundSandbox.shouldCreateNativeGroup([1, 2], { minTabsPerGroup: 3 }), false);
assert.strictEqual(backgroundSandbox.shouldCreateNativeGroup([1], { minTabsPerGroup: 1 }), true);
assert.strictEqual(backgroundSandbox.getShortGroupTitle('google.com'), 'google');
assert.strictEqual(backgroundSandbox.getShortGroupTitle('example.com.cn'), 'example');
assert.strictEqual(backgroundSandbox.getShortGroupTitle('localhost'), 'localhost');
assert.strictEqual(backgroundSandbox.getShortGroupTitle('127.0.0.1'), '127.0.0.1');
assert.strictEqual(backgroundSandbox.getShortGroupTitle('其他'), '其他');

const conflictTitleMap = backgroundSandbox.buildGroupTitleMap(['foo.com', 'foo.net', 'google.com']);
assert.strictEqual(conflictTitleMap.get('foo.com'), 'foo.com');
assert.strictEqual(conflictTitleMap.get('foo.net'), 'foo.net');
assert.strictEqual(conflictTitleMap.get('google.com'), 'google');

const titledTabSnapshots = backgroundSandbox.buildTabSnapshots([
  { id: 101, title: '邮箱', url: 'https://mail.google.com/inbox', active: false, pinned: false, index: 0 },
  { id: 102, title: '站点一', url: 'https://foo.com', active: false, pinned: false, index: 1 },
  { id: 103, title: '站点二', url: 'https://foo.net', active: false, pinned: false, index: 2 }
]);
assert.deepStrictEqual(Array.from(titledTabSnapshots, (tab) => tab.groupTitle), ['google', 'foo.com', 'foo.net']);

const windowOrderMap = backgroundSandbox.buildWindowOrderMap([
  { id: 1, windowId: 20 },
  { id: 2, windowId: 10 },
  { id: 3, windowId: 30 },
  { id: 4, windowId: 20 }
], 20);
assert.strictEqual(windowOrderMap.get(20), 1);
assert.strictEqual(windowOrderMap.get(10), 2);
assert.strictEqual(windowOrderMap.get(30), 3);
assert.strictEqual(backgroundSandbox.getWindowLabel(20, 20, windowOrderMap), '当前窗口');
assert.strictEqual(backgroundSandbox.getWindowLabel(10, 20, windowOrderMap), '其他窗口');
assert.strictEqual(backgroundSandbox.getWindowLabel(999, 20, windowOrderMap), '其他窗口');

const searchSnapshots = backgroundSandbox.buildSearchTabSnapshots([
  {
    id: 101,
    title: '飞书需求文档',
    url: 'https://docs.example.com/a',
    active: false,
    pinned: false,
    index: 2,
    windowId: 20,
    lastAccessed: 1780645200000
  },
  {
    id: 102,
    title: 'GitHub PR',
    url: 'https://github.com/example/repo/pull/1',
    active: true,
    pinned: false,
    index: 1,
    windowId: 10
  }
], {
  currentWindowId: 20,
  recentAccessMap: {
    102: 1780645300000
  }
});
assert.strictEqual(searchSnapshots[0].groupKey, 'example.com');
assert.strictEqual(searchSnapshots[0].groupTitle, 'example');
assert.strictEqual(searchSnapshots[0].isCurrentWindow, true);
assert.strictEqual(searchSnapshots[0].windowLabel, '当前窗口');
assert.strictEqual(searchSnapshots[0].lastAccessedAt, 1780645200000);
assert.strictEqual(searchSnapshots[1].groupKey, 'github.com');
assert.strictEqual(searchSnapshots[1].groupTitle, 'github');
assert.strictEqual(searchSnapshots[1].isCurrentWindow, false);
assert.strictEqual(searchSnapshots[1].windowLabel, '其他窗口');
assert.strictEqual(searchSnapshots[1].lastAccessedAt, 1780645300000);

const normalizedRecentAccess = backgroundSandbox.normalizeRecentAccessMap({
  101: 1780645000000,
  102: '不是时间',
  abc: 1780645100000
});
assert.deepStrictEqual(JSON.parse(JSON.stringify(normalizedRecentAccess)), {
  101: 1780645000000
});

const visibleGroupSummaries = backgroundSandbox.buildGroupSummaries([
  { id: 201, url: 'https://mail.google.com/inbox', pinned: false, index: 0 },
  { id: 202, url: 'https://docs.google.com/document', pinned: false, index: 1 },
  { id: 203, url: 'https://solo.example.com', pinned: false, index: 2 },
  { id: 204, url: 'https://pinned.example.net', pinned: true, index: 3 }
], { minTabsPerGroup: 2, priorityGroups: [] });
assert.deepStrictEqual(Array.from(visibleGroupSummaries, (group) => group.groupKey), ['google.com']);
assert.strictEqual(visibleGroupSummaries[0].title, 'google');

const samePrimaryDomainUrls = [
  'https://mail.google.com/inbox',
  'https://docs.google.com/document',
  'https://calendar.google.com/calendar'
];
const sortedSamePrimaryDomainUrls = [...samePrimaryDomainUrls].sort((left, right) => {
  const leftHostname = backgroundSandbox.getHostnameKey(left);
  const rightHostname = backgroundSandbox.getHostnameKey(right);

  // 同一主域名内按完整子域名排序，能让一个网站的不同产品稳定排列。
  return leftHostname.localeCompare(rightHostname, 'zh-CN');
});

assert.deepStrictEqual(sortedSamePrimaryDomainUrls, [
  'https://calendar.google.com/calendar',
  'https://docs.google.com/document',
  'https://mail.google.com/inbox'
]);

const duplicateTabs = [
  { id: 1, title: '文章', url: 'https://example.com/a?utm_source=news&x=1', active: false, pinned: false, index: 0 },
  { id: 2, title: '文章副本', url: 'https://example.com/a?x=1&utm_medium=email', active: true, pinned: false, index: 1 },
  { id: 3, title: '文章固定', url: 'https://example.com/a?x=1&utm_campaign=spring', active: false, pinned: true, index: 2 },
  { id: 4, title: '不同锚点', url: 'https://example.com/a?x=1#section', active: false, pinned: false, index: 3 }
];

assert.strictEqual(
  backgroundSandbox.normalizeUrlForDuplicate('https://example.com/a?utm_source=news&x=1'),
  'https://example.com/a?x=1'
);
assert.strictEqual(
  backgroundSandbox.normalizeUrlForDuplicate('https://example.com/a?x=1#section'),
  'https://example.com/a?x=1#section'
);

const duplicateGroups = backgroundSandbox.buildDuplicateGroups(duplicateTabs);
assert.strictEqual(duplicateGroups.length, 1);
assert.strictEqual(duplicateGroups[0].reason, '忽略追踪参数后重复');
assert.strictEqual(duplicateGroups[0].keepTabId, 3);
// vm 沙箱返回的数组原型不同，转成本上下文数组后再比较内容，避免误判业务结果。
assert.deepStrictEqual(Array.from(duplicateGroups[0].closeTabIds), [1, 2]);
assert.strictEqual(backgroundSandbox.buildOverview(duplicateTabs).duplicateCount, null);

const exactDuplicateGroups = backgroundSandbox.buildDuplicateGroups([
  { id: 10, title: '同页', url: 'https://example.com/same', active: false, pinned: false, index: 2 },
  { id: 11, title: '同页', url: 'https://example.com/same', active: false, pinned: false, index: 1 }
]);
assert.strictEqual(exactDuplicateGroups[0].reason, '完整网址重复');
assert.strictEqual(exactDuplicateGroups[0].keepTabId, 11);

const workspaceItems = backgroundSandbox.sortWorkspaces([
  { id: 'a', name: '旧收藏', createdAt: 1, favorite: true, favoritedAt: 10, tabs: [], groups: [] },
  { id: 'b', name: '新普通', createdAt: 20, favorite: false, tabs: [], groups: [] },
  { id: 'c', name: '新收藏', createdAt: 5, favorite: true, favoritedAt: 30, tabs: [], groups: [] }
]);
// 工作集列表来自后台沙箱，显式转数组可以让断言只关注排序契约。
assert.deepStrictEqual(Array.from(workspaceItems, (item) => item.id), ['c', 'a', 'b']);

const oldWorkspace = backgroundSandbox.normalizeWorkspace({
  id: 'session-1',
  name: '旧会话',
  createdAt: 1,
  tabs: [],
  groups: []
});
assert.strictEqual(oldWorkspace.favorite, false);
assert.strictEqual(oldWorkspace.favoritedAt, 0);
assert.strictEqual(oldWorkspace.updatedAt, 1);

const popupPath = path.join(rootDir, 'popup.js');
const popupSandbox = {
  console,
  document: {
    addEventListener() {},
    getElementById() {
      return {
        addEventListener() {},
        appendChild() {},
        querySelectorAll() {
          return [];
        },
        classList: {
          toggle() {}
        },
        style: {},
        dataset: {},
        innerHTML: '',
        textContent: '',
        value: '',
        hidden: false,
        disabled: false
      };
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      return {
        className: '',
        dataset: {},
        classList: {
          toggle() {}
        },
        addEventListener() {},
        appendChild() {},
        querySelectorAll() {
          return [];
        },
        set innerHTML(value) {
          this.html = value;
        },
        get innerHTML() {
          return this.html || '';
        }
      };
    }
  },
  chrome: {
    runtime: {
      sendMessage() {
        return Promise.resolve({ ok: true, payload: {} });
      }
    }
  },
  window: {
    prompt() {
      return null;
    },
    confirm() {
      return false;
    }
  },
  Intl,
  Date,
  Number,
  String,
  Array,
  Set,
  Map,
  Promise
};

vm.createContext(popupSandbox);
vm.runInContext(fs.readFileSync(popupPath, 'utf8'), popupSandbox, { filename: 'popup.js' });

const rankedRecentTabs = popupSandbox.getVisibleTabsFromState({
  query: '',
  tabs: [
    { id: 1, title: '旧页面', url: 'https://old.example.com', groupKey: 'example.com', groupTitle: 'example', index: 0, isCurrentWindow: true, lastAccessedAt: 10 },
    { id: 2, title: '新页面', url: 'https://new.example.com', groupKey: 'example.com', groupTitle: 'example', index: 1, isCurrentWindow: false, lastAccessedAt: 30 },
    { id: 3, title: '无时间页面', url: 'https://none.example.com', groupKey: 'example.com', groupTitle: 'example', index: 2, isCurrentWindow: true, lastAccessedAt: 0 },
    { id: 4, title: '当前页面', url: 'https://current.example.com', groupKey: 'example.com', groupTitle: 'example', active: true, index: 3, isCurrentWindow: true, lastAccessedAt: 100 }
  ]
});
assert.deepStrictEqual(Array.from(rankedRecentTabs, (tab) => tab.id), [2, 1, 3]);

const manyRecentTabs = Array.from({ length: 35 }, (_, index) => ({
  id: index + 100,
  title: `最近页面 ${index}`,
  url: `https://example.com/${index}`,
  groupKey: 'example.com',
  groupTitle: 'example',
  index,
  isCurrentWindow: false,
  lastAccessedAt: 1000 - index
}));
assert.strictEqual(popupSandbox.getVisibleTabsFromState({
  query: '',
  tabs: manyRecentTabs
}).length, 30);

const rankedSearchTabs = popupSandbox.getVisibleTabsFromState({
  query: 'github',
  tabs: [
    { id: 10, title: '普通文章', url: 'https://example.com/github-guide', groupKey: 'example.com', groupTitle: 'example', index: 0, isCurrentWindow: true, lastAccessedAt: 100 },
    { id: 11, title: 'GitHub PR', url: 'https://github.com/acme/repo/pull/1', groupKey: 'github.com', groupTitle: 'github', index: 1, isCurrentWindow: false, lastAccessedAt: 50 },
    { id: 12, title: 'GitHub 首页', url: 'https://github.com', groupKey: 'github.com', groupTitle: 'github', index: 2, isCurrentWindow: true, lastAccessedAt: 30 },
    { id: 13, title: 'GitHub 当前页', url: 'https://github.com/current', groupKey: 'github.com', groupTitle: 'github', active: true, index: 3, isCurrentWindow: true, lastAccessedAt: 200 }
  ]
});
assert.deepStrictEqual(Array.from(rankedSearchTabs, (tab) => tab.id), [13, 11, 12, 10]);

assert.strictEqual(popupSandbox.clampSelectedIndex(-1, 3), 2);
assert.strictEqual(popupSandbox.clampSelectedIndex(3, 3), 0);
assert.strictEqual(popupSandbox.clampSelectedIndex(1, 3), 1);
assert.strictEqual(popupSandbox.clampSelectedIndex(0, 0), -1);
assert.strictEqual(popupSandbox.formatRecentAccessTime(20000000, 20000000), '刚刚');
assert.strictEqual(popupSandbox.formatRecentAccessTime(20000000 - 2 * 60 * 1000, 20000000), '2 分钟前');
assert.strictEqual(popupSandbox.formatRecentAccessTime(20000000 - 3 * 60 * 60 * 1000, 20000000), '3 小时前');
assert.strictEqual(popupSandbox.formatRecentAccessTime(0, 20000000), '');
let selectedScrollOptions = null;
popupSandbox.keepSelectedResultVisible({
  querySelector(selector) {
    assert.strictEqual(selector, '.quick-result-item.is-selected');

    return {
      scrollIntoView(options) {
        selectedScrollOptions = options;
      }
    };
  }
});
assert.strictEqual(selectedScrollOptions.block, 'nearest');

const popupHtml = fs.readFileSync(path.join(rootDir, 'popup.html'), 'utf8');
const readmeContent = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');

// 弹窗和说明文档必须同时展示核心中文文案，避免功能已实现但入口或文档仍停留在旧“会话”命名。
assert.ok(popupHtml.includes('智能去重'));
assert.ok(popupHtml.includes('保存工作集'));
assert.ok(popupHtml.includes('工作集'));
assert.ok(popupHtml.includes('minTabsPerGroupInput'));
assert.ok(popupHtml.includes('分组阈值'));
assert.ok(popupHtml.includes('快速切换'));
assert.ok(popupHtml.includes('searchResultList'));
assert.ok(popupHtml.includes('moreToolsButton'));
assert.ok(popupHtml.includes('moreToolsSection'));
assert.ok(popupHtml.includes('打开后默认展示最近使用页面'));
assert.ok(readmeContent.includes('智能去重'));
assert.ok(readmeContent.includes('保存工作集'));
assert.ok(readmeContent.includes('工作集'));
assert.ok(readmeContent.includes('分组阈值'));
assert.ok(readmeContent.includes('分组显示名'));
assert.ok(readmeContent.includes('重新梳理当前窗口分组'));
assert.ok(readmeContent.includes('快速切换'));
assert.ok(readmeContent.includes('跨窗口最近使用页面'));
assert.ok(readmeContent.includes('点击任意结果项'));

async function runAsyncChecks() {
  const groupOperations = {
    grouped: [],
    ungrouped: [],
    updated: []
  };

  backgroundSandbox.queryCurrentWindowTabs = async () => [
    { id: 21, url: 'https://mail.google.com/inbox', pinned: false, groupId: 1 },
    { id: 22, url: 'https://docs.google.com/document', pinned: false, groupId: 1 },
    { id: 23, url: 'https://calendar.google.com/calendar', pinned: false, groupId: 1 },
    { id: 31, url: 'https://a.example.com', pinned: false, groupId: 2 },
    { id: 41, url: 'https://solo.test.com', pinned: false, groupId: 3 },
    { id: 51, url: 'https://pinned.test.com', pinned: true, groupId: 4 }
  ];
  backgroundSandbox.chrome.tabs = {
    group: async ({ tabIds }) => {
      groupOperations.grouped.push(Array.from(tabIds));
      return groupOperations.grouped.length;
    },
    ungroup: async (tabIds) => {
      groupOperations.ungrouped.push(Array.from(tabIds));
    }
  };
  backgroundSandbox.chrome.tabGroups = {
    update: async (groupId, options) => {
      groupOperations.updated.push({ groupId, options });
    }
  };

  await backgroundSandbox.reconcileCurrentWindowGroups({ minTabsPerGroup: 3 });
  assert.deepStrictEqual(groupOperations.grouped, [[21, 22, 23]]);
  assert.deepStrictEqual(groupOperations.ungrouped, [[31], [41]]);
  assert.strictEqual(groupOperations.updated[0].options.title, 'google');

  const activationOperations = {
    focusedWindowIds: [],
    activatedTabIds: []
  };

  backgroundSandbox.chrome.tabs.get = async (tabId) => {
    assert.strictEqual(tabId, 88);
    return {
      id: 88,
      windowId: 66
    };
  };
  backgroundSandbox.chrome.windows = {
    update: async (windowId, updateInfo) => {
      activationOperations.focusedWindowIds.push(windowId);
      assert.strictEqual(updateInfo.focused, true);
    }
  };
  backgroundSandbox.chrome.tabs.update = async (tabId, updateInfo) => {
    activationOperations.activatedTabIds.push(tabId);
    assert.strictEqual(updateInfo.active, true);
  };

  const activationResult = await backgroundSandbox.activateTabAcrossWindows(88);
  assert.deepStrictEqual(activationOperations.focusedWindowIds, [66]);
  assert.deepStrictEqual(activationOperations.activatedTabIds, [88]);
  assert.strictEqual(activationResult.activated, true);
  assert.strictEqual(activationResult.windowId, 66);
}

runAsyncChecks()
  .then(() => {
    console.log('插件文件校验通过');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
