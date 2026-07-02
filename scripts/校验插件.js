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

if (!manifest.permissions.includes('tabs')
  || !manifest.permissions.includes('tabGroups')
  || !manifest.permissions.includes('storage')
  || !manifest.permissions.includes('sessions')) {
  throw new Error('manifest.json 缺少必要权限');
}

if (!manifest.icons || !manifest.action || !manifest.action.default_icon) {
  throw new Error('manifest.json 必须声明插件图标');
}

assert.ok(manifest.description.includes('一键整理'));
assert.ok(manifest.description.includes('搜索'));

const popupHtmlPath = path.join(rootDir, 'popup.html');
const popupStructureHtmlContent = fs.readFileSync(popupHtmlPath, 'utf8');
const popupCssPath = path.join(rootDir, 'popup.css');
const popupStructureCssContent = fs.readFileSync(popupCssPath, 'utf8');
const popupJsPath = path.join(rootDir, 'popup.js');
const popupStructureJsContent = fs.readFileSync(popupJsPath, 'utf8');
const readmePath = path.join(rootDir, 'README.md');
const readmeStructureContent = fs.readFileSync(readmePath, 'utf8');

assert.ok(popupStructureHtmlContent.includes('class="primary-action main-organize-action"'));
assert.ok(popupStructureHtmlContent.includes('class="secondary-action-grid"'));
assert.ok(popupStructureHtmlContent.includes('搜索标签页'));
assert.ok(popupStructureHtmlContent.includes('id="searchResultList"'));
assert.ok(popupStructureHtmlContent.includes('id="sortHelpButton"'));
assert.ok(popupStructureHtmlContent.includes('id="sortHelpText"'));
assert.ok(popupStructureHtmlContent.includes('aria-label="高级管理"'));
assert.ok(popupStructureHtmlContent.includes('>高级管理</button>'));
assert.ok(!popupStructureHtmlContent.includes('<h2>管理操作</h2>'));
assert.ok(popupStructureHtmlContent.includes('class="management-overview"'));
assert.ok(popupStructureHtmlContent.includes('id="managementRulesSummary"'));
assert.ok(popupStructureHtmlContent.includes('id="managementPrioritySummary"'));
assert.ok(popupStructureHtmlContent.includes('id="managementWorkspaceSummary"'));
assert.ok(popupStructureHtmlContent.includes('id="managementCleanupSummary"'));
assert.ok(popupStructureHtmlContent.includes('id="managementRulesPanel"'));
assert.ok(popupStructureHtmlContent.includes('id="managementPriorityPanel"'));
assert.ok(popupStructureHtmlContent.includes('id="managementWorkspacePanel"'));
assert.ok(popupStructureHtmlContent.includes('id="managementCleanupPanel"'));
assert.strictEqual((popupStructureHtmlContent.match(/data-management-panel-button="/g) || []).length, 4);
assert.strictEqual((popupStructureHtmlContent.match(/data-management-panel="/g) || []).length, 4);
assert.strictEqual((popupStructureHtmlContent.match(/id="scanDuplicatesButton"/g) || []).length, 1);
assert.strictEqual((popupStructureHtmlContent.match(/id="saveWorkspaceButton"/g) || []).length, 1);
// 重复清理是当前窗口即时操作，应在首屏常用操作区内确认，避免把用户带到高级管理。
assert.ok(popupStructureHtmlContent.indexOf('id="duplicateReviewSection"') > popupStructureHtmlContent.indexOf('class="quick-action-area"'));
assert.ok(popupStructureHtmlContent.indexOf('id="duplicateReviewSection"') < popupStructureHtmlContent.indexOf('id="moreToolsSection"'));
assert.ok(popupStructureHtmlContent.includes('id="duplicateReviewHelp"'));
assert.ok(popupStructureHtmlContent.includes('id="duplicateReviewResult"'));
assert.ok(popupStructureHtmlContent.includes('id="rescanDuplicatesButton"'));
assert.ok(popupStructureHtmlContent.includes('tabindex="-1"'));
assert.ok(popupStructureCssContent.includes('.main-organize-action'));
assert.ok(popupStructureCssContent.includes('.secondary-action-grid'));
assert.ok(popupStructureCssContent.includes('.management-toggle-button'));
assert.ok(popupStructureCssContent.includes('.management-summary-button'));
assert.ok(popupStructureCssContent.includes('.management-panel'));
assert.ok(popupStructureCssContent.includes('.quick-result-item'));
assert.ok(popupStructureJsContent.includes('activeManagementPanel'));
assert.ok(popupStructureJsContent.includes('renderManagementOverview'));
// 首屏常用操作必须避免空状态文本占位，否则整理按钮和辅助操作之间会出现无意义留白。
assert.ok(popupStructureCssContent.includes('.action-status-text:empty'));
// 弹窗主体不能拉伸自动网格行，否则可用高度增加时会把各模块之间的间距放大。
assert.match(popupStructureCssContent, /\.popup-shell\s*\{[^}]*align-content: start;[^}]*min-height: auto;/s);
// 标题区是弹窗入口信息，不应该用大卡片高度挤占高频操作的可见空间。
assert.match(popupStructureCssContent, /\.popup-header\s*\{\s*align-items: flex-start;\s*padding: 10px 12px;/);
// 弹窗滚动容器很短，按钮和列表项不应使用位移或阴影过渡，否则滚动和点击会显得卡顿。
assert.ok(!popupStructureCssContent.includes('transform 160ms'));
assert.ok(!popupStructureCssContent.includes('box-shadow 160ms'));
assert.ok(!popupStructureCssContent.includes('transform: translateY(1px)'));
assert.ok(!popupStructureCssContent.includes('box-shadow: 0 1px 0 rgba(15, 23, 42, 0.03)'));
assert.ok(popupStructureCssContent.includes('.duplicate-review-panel'));
assert.ok(readmeStructureContent.includes('“高级管理”里新增自定义分组规则'));
assert.ok(readmeStructureContent.includes('搜索框会自动聚焦'));
assert.ok(readmeStructureContent.includes('最近关闭的标签页'));
assert.ok(readmeStructureContent.includes('`sessions`'));
assert.ok(!readmeStructureContent.includes('“更多工具”里新增自定义分组规则'));

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

function makeConditionTree(children, logic = 'and') {
  return {
    type: 'group',
    logic,
    children: children.map((condition) => Object.assign({ type: 'condition' }, condition))
  };
}

// 主域名归并是核心分组契约，校验脚本覆盖它可以避免后续改动退回完整域名分组。
assert.strictEqual(backgroundSandbox.getDomainKey('https://mail.google.com/inbox'), 'google.com');
assert.strictEqual(backgroundSandbox.getDomainKey('https://docs.google.com/document'), 'google.com');
assert.strictEqual(backgroundSandbox.getDomainKey('https://a.example.com.cn/path'), 'example.com.cn');
assert.strictEqual(backgroundSandbox.getDomainKey('http://localhost:3000'), 'localhost');
assert.strictEqual(backgroundSandbox.getDomainKey('http://127.0.0.1:8080'), '127.0.0.1');
assert.strictEqual(backgroundSandbox.getDomainKey('不是有效网址'), '其他');
assert.strictEqual(backgroundSandbox.getHostnameKey('https://mail.google.com/inbox'), 'mail.google.com');
assert.strictEqual(backgroundSandbox.getHostnameKey('不是有效网址'), '其他');

const recentlyClosedSnapshots = backgroundSandbox.buildRecentlyClosedTabSnapshots([
  {
    lastModified: 1710000000000,
    tab: {
      sessionId: 'closed-tab-1',
      title: '关闭页面',
      url: 'https://docs.example.com/page'
    }
  }
], {});

assert.strictEqual(recentlyClosedSnapshots.length, 1);
assert.strictEqual(recentlyClosedSnapshots[0].resultType, 'recentlyClosed');
assert.strictEqual(recentlyClosedSnapshots[0].sessionId, 'closed-tab-1');
assert.strictEqual(recentlyClosedSnapshots[0].groupKey, 'example.com');

const recentlyClosedWindowSnapshots = backgroundSandbox.buildRecentlyClosedTabSnapshots([
  {
    lastModified: 1710000000000,
    window: {
      sessionId: 'closed-window-1',
      tabs: [
        {
          title: '窗口里的关闭页面',
          url: 'https://mail.example.com/inbox'
        }
      ]
    }
  }
], {});

assert.strictEqual(recentlyClosedWindowSnapshots.length, 1);
assert.strictEqual(recentlyClosedWindowSnapshots[0].sessionId, 'closed-window-1');
assert.strictEqual(recentlyClosedWindowSnapshots[0].groupKey, 'example.com');

assert.strictEqual(backgroundSandbox.normalizeSettings({}).minTabsPerGroup, 2);
assert.strictEqual(backgroundSandbox.normalizeSettings({ minTabsPerGroup: 3 }).minTabsPerGroup, 3);
assert.strictEqual(backgroundSandbox.normalizeSettings({ minTabsPerGroup: 0 }).minTabsPerGroup, 2);
assert.strictEqual(backgroundSandbox.normalizeSettings({ minTabsPerGroup: 1 }).minTabsPerGroup, 1);
assert.strictEqual(backgroundSandbox.normalizeSettings({ minTabsPerGroup: 2.5 }).minTabsPerGroup, 2);
assert.strictEqual(backgroundSandbox.normalizeSettings({ minTabsPerGroup: '3' }).minTabsPerGroup, 2);

const normalizedRuleSettings = backgroundSandbox.normalizeSettings({
  minTabsPerGroup: 3,
  groupRules: [
    {
      id: 'rule-old',
      name: '  项目 A  ',
      enabled: true,
      targetGroupKey: 'custom:项目 A',
      targetTitle: '  项目 A  ',
      minTabsPerGroup: 1,
      conditionTree: makeConditionTree([
        { field: 'hostname', operator: 'contains', value: 'github.com' }
      ]),
      createdAt: 10,
      updatedAt: 20
    },
    {
      id: '',
      name: '',
      targetTitle: '',
      conditionTree: makeConditionTree([])
    }
  ]
});

assert.strictEqual(normalizedRuleSettings.groupRules.length, 1);
assert.strictEqual(normalizedRuleSettings.groupRules[0].name, '项目 A');
assert.strictEqual(normalizedRuleSettings.groupRules[0].targetTitle, '项目 A');
assert.strictEqual(normalizedRuleSettings.groupRules[0].minTabsPerGroup, 1);
assert.strictEqual(normalizedRuleSettings.groupRules[0].conditionTree.children[0].value, 'github.com');
assert.strictEqual(normalizedRuleSettings.groupRules[0].conditions, undefined);

const normalizedTreeRuleSettings = backgroundSandbox.normalizeSettings({
  minTabsPerGroup: 2,
  groupRules: [
    {
      id: 'rule-project-a',
      name: '项目 A',
      enabled: true,
      targetGroupKey: 'custom:项目 A',
      targetTitle: '项目 A',
      minTabsPerGroup: null,
      conditionTree: {
        type: 'group',
        logic: 'and',
        children: [
          {
            type: 'group',
            logic: 'or',
            children: [
              { type: 'condition', field: 'hostname', operator: 'contains', value: 'github.com' },
              { type: 'condition', field: 'hostname', operator: 'contains', value: 'docs.example.com' }
            ]
          },
          { type: 'condition', field: 'path', operator: 'contains', value: 'project-a' }
        ]
      },
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'rule-old-conditions',
      name: '旧规则不兼容',
      enabled: true,
      targetGroupKey: 'custom:旧规则',
      targetTitle: '旧规则',
      conditions: [{ field: 'hostname', operator: 'contains', value: 'legacy.example.com' }]
    }
  ]
});

assert.strictEqual(normalizedTreeRuleSettings.groupRules.length, 1);
assert.strictEqual(normalizedTreeRuleSettings.groupRules[0].conditionTree.logic, 'and');
assert.strictEqual(normalizedTreeRuleSettings.groupRules[0].conditionTree.children[0].logic, 'or');
assert.strictEqual(backgroundSandbox.countConditionTreeConditions(normalizedTreeRuleSettings.groupRules[0].conditionTree), 3);

assert.strictEqual(backgroundSandbox.doesRuleMatchTab(normalizedTreeRuleSettings.groupRules[0], {
  title: '项目 A 仓库',
  url: 'https://github.com/my-org/project-a/issues',
  pinned: false
}), true);
assert.strictEqual(backgroundSandbox.doesRuleMatchTab(normalizedTreeRuleSettings.groupRules[0], {
  title: '项目 A 文档',
  url: 'https://docs.example.com/project-a/intro',
  pinned: false
}), true);
assert.strictEqual(backgroundSandbox.doesRuleMatchTab(normalizedTreeRuleSettings.groupRules[0], {
  title: '其他仓库',
  url: 'https://github.com/my-org/other/issues',
  pinned: false
}), false);
assert.strictEqual(backgroundSandbox.doesRuleMatchTab(normalizedTreeRuleSettings.groupRules[0], {
  title: '其他站点',
  url: 'https://jira.example.com/project-a',
  pinned: false
}), false);

const matchedProjectGroup = backgroundSandbox.getResolvedGroupInfo({
  title: '项目 A 问题',
  url: 'https://github.com/my-org/project-a/issues',
  pinned: false
}, normalizedRuleSettings);
assert.strictEqual(matchedProjectGroup.groupKey, 'custom:项目 A');
assert.strictEqual(matchedProjectGroup.title, '项目 A');
assert.strictEqual(matchedProjectGroup.ruleId, 'rule-old');

const fallbackProjectGroup = backgroundSandbox.getResolvedGroupInfo({
  title: '邮箱',
  url: 'https://mail.google.com/inbox',
  pinned: false
}, normalizedRuleSettings);
assert.strictEqual(fallbackProjectGroup.groupKey, 'google.com');
assert.strictEqual(fallbackProjectGroup.title, 'google.com');
assert.strictEqual(fallbackProjectGroup.ruleId, '');

assert.strictEqual(backgroundSandbox.doesRuleMatchTab(normalizedRuleSettings.groupRules[0], {
  title: '项目 A',
  url: 'https://github.com/my-org/project-a',
  pinned: false
}), true);
assert.strictEqual(backgroundSandbox.doesRuleMatchTab(normalizedRuleSettings.groupRules[0], {
  title: '项目 A',
  url: 'https://github.com/my-org/project-a',
  pinned: true
}), false);
assert.strictEqual(backgroundSandbox.doesRuleMatchTab(normalizedRuleSettings.groupRules[0], {
  title: '项目 B',
  url: 'https://gitlab.com/my-org/project-a',
  pinned: false
}), false);

const boundaryRuleInput = {
  minTabsPerGroup: 4,
  groupRules: [
    {
      name: '精确匹配项目',
      targetTitle: '精确匹配项目',
      minTabsPerGroup: '',
      conditionTree: makeConditionTree([
        { field: 'primaryDomain', operator: 'equals', value: 'github.com' }
      ])
    },
    {
      name: '路径前缀项目',
      targetTitle: '路径前缀项目',
      conditionTree: makeConditionTree([
        { field: 'path', operator: 'startsWith', value: '/my-org' }
      ])
    },
    {
      name: '多条件项目',
      targetTitle: '多条件项目',
      conditionTree: makeConditionTree([
        { field: 'hostname', operator: 'contains', value: 'github.com' },
        { field: 'path', operator: 'startsWith', value: '/missing' }
      ])
    },
    {
      name: '停用项目',
      enabled: false,
      targetTitle: '停用项目',
      conditionTree: makeConditionTree([
        { field: 'hostname', operator: 'contains', value: 'github.com' }
      ])
    },
    {
      name: '标题兜底项目',
      targetTitle: '标题兜底项目',
      conditionTree: makeConditionTree([
        { field: 'title', operator: 'contains', value: '内部页面' }
      ])
    },
    {
      name: '条件截断项目',
      targetTitle: '条件截断项目',
      conditionTree: makeConditionTree([
        { field: 'title', operator: 'contains', value: '不会命中标题' },
        { field: 'url', operator: 'contains', value: '不会命中网址' },
        { field: 'hostname', operator: 'contains', value: '不会命中主机' },
        { field: 'primaryDomain', operator: 'equals', value: 'missing.example' },
        { field: 'path', operator: 'startsWith', value: '/missing' },
        { field: 'title', operator: 'contains', value: '第六条件可以命中' }
      ])
    }
  ]
};
const normalizedBoundaryRuleSettings = backgroundSandbox.normalizeSettings(boundaryRuleInput);
const normalizedBoundaryRuleSettingsAgain = backgroundSandbox.normalizeSettings(boundaryRuleInput);
const swappedBoundaryRuleInput = Object.assign({}, boundaryRuleInput, {
  groupRules: [
    boundaryRuleInput.groupRules[1],
    boundaryRuleInput.groupRules[0],
    ...boundaryRuleInput.groupRules.slice(2)
  ]
});
const normalizedSwappedBoundaryRuleSettings = backgroundSandbox.normalizeSettings(swappedBoundaryRuleInput);
const boundaryRuleIdMap = new Map(Array.from(normalizedBoundaryRuleSettings.groupRules, (rule) => [rule.targetTitle, rule.id]));
const swappedBoundaryRuleIdMap = new Map(Array.from(normalizedSwappedBoundaryRuleSettings.groupRules, (rule) => [rule.targetTitle, rule.id]));

assert.strictEqual(normalizedBoundaryRuleSettings.groupRules.length, 6);
assert.notStrictEqual(
  normalizedBoundaryRuleSettings.groupRules[0].id,
  normalizedBoundaryRuleSettings.groupRules[1].id
);
assert.strictEqual(
  normalizedBoundaryRuleSettings.groupRules[0].id,
  normalizedBoundaryRuleSettingsAgain.groupRules[0].id
);
assert.strictEqual(
  normalizedBoundaryRuleSettings.groupRules[1].id,
  normalizedBoundaryRuleSettingsAgain.groupRules[1].id
);
assert.strictEqual(boundaryRuleIdMap.get('精确匹配项目'), swappedBoundaryRuleIdMap.get('精确匹配项目'));
assert.strictEqual(boundaryRuleIdMap.get('路径前缀项目'), swappedBoundaryRuleIdMap.get('路径前缀项目'));

const duplicatedGeneratedIdSettings = backgroundSandbox.normalizeSettings({
  groupRules: [
    boundaryRuleInput.groupRules[0],
    boundaryRuleInput.groupRules[0]
  ]
});
assert.strictEqual(duplicatedGeneratedIdSettings.groupRules.length, 2);
assert.notStrictEqual(
  duplicatedGeneratedIdSettings.groupRules[0].id,
  duplicatedGeneratedIdSettings.groupRules[1].id
);
assert.strictEqual(
  duplicatedGeneratedIdSettings.groupRules[1].id,
  `${duplicatedGeneratedIdSettings.groupRules[0].id}-2`
);

const sameTargetDifferentIdentityInput = {
  groupRules: [
    {
      name: '同目标规则一',
      targetGroupKey: 'custom:同目标',
      targetTitle: '同目标',
      minTabsPerGroup: 1,
      conditionTree: makeConditionTree([
        { field: 'hostname', operator: 'contains', value: 'github.com' }
      ])
    },
    {
      name: '同目标规则二',
      targetGroupKey: 'custom:同目标',
      targetTitle: '同目标',
      minTabsPerGroup: 2,
      conditionTree: makeConditionTree([
        { field: 'hostname', operator: 'contains', value: 'github.com' }
      ])
    }
  ]
};
const normalizedSameTargetDifferentIdentitySettings = backgroundSandbox.normalizeSettings(sameTargetDifferentIdentityInput);
const normalizedSwappedSameTargetDifferentIdentitySettings = backgroundSandbox.normalizeSettings({
  groupRules: [
    sameTargetDifferentIdentityInput.groupRules[1],
    sameTargetDifferentIdentityInput.groupRules[0]
  ]
});
const sameTargetDifferentIdentityIdMap = new Map(Array.from(
  normalizedSameTargetDifferentIdentitySettings.groupRules,
  (rule) => [rule.name, rule.id]
));
const swappedSameTargetDifferentIdentityIdMap = new Map(Array.from(
  normalizedSwappedSameTargetDifferentIdentitySettings.groupRules,
  (rule) => [rule.name, rule.id]
));
assert.notStrictEqual(
  sameTargetDifferentIdentityIdMap.get('同目标规则一'),
  sameTargetDifferentIdentityIdMap.get('同目标规则二')
);
assert.strictEqual(
  sameTargetDifferentIdentityIdMap.get('同目标规则一'),
  swappedSameTargetDifferentIdentityIdMap.get('同目标规则一')
);
assert.strictEqual(
  sameTargetDifferentIdentityIdMap.get('同目标规则二'),
  swappedSameTargetDifferentIdentityIdMap.get('同目标规则二')
);

assert.strictEqual(
  backgroundSandbox.countConditionTreeConditions(normalizedBoundaryRuleSettings.groupRules[5].conditionTree),
  6
);
assert.strictEqual(backgroundSandbox.doesRuleMatchTab(normalizedBoundaryRuleSettings.groupRules[5], {
  title: '第六条件可以命中',
  url: 'https://example.com/a',
  pinned: false
}), false);
assert.strictEqual(backgroundSandbox.doesRuleMatchTab(normalizedBoundaryRuleSettings.groupRules[0], {
  title: '精确匹配',
  url: 'https://github.com/my-org/project-a',
  pinned: false
}), true);
assert.strictEqual(backgroundSandbox.doesRuleMatchTab(normalizedBoundaryRuleSettings.groupRules[1], {
  title: '路径前缀',
  url: 'https://github.com/my-org/project-a',
  pinned: false
}), true);
assert.strictEqual(backgroundSandbox.doesRuleMatchTab(normalizedBoundaryRuleSettings.groupRules[2], {
  title: '多条件',
  url: 'https://github.com/my-org/project-a',
  pinned: false
}), false);
assert.strictEqual(backgroundSandbox.doesRuleMatchTab(normalizedBoundaryRuleSettings.groupRules[3], {
  title: '停用项目',
  url: 'https://github.com/my-org/project-a',
  pinned: false
}), false);

const fallbackThresholdGroup = backgroundSandbox.getResolvedGroupInfo({
  title: '精确匹配',
  url: 'https://github.com/my-org/project-a',
  pinned: false
}, normalizedBoundaryRuleSettings);
assert.strictEqual(fallbackThresholdGroup.minTabsPerGroup, 4);

assert.strictEqual(backgroundSandbox.doesRuleMatchTab(normalizedBoundaryRuleSettings.groupRules[4], {
  title: '内部页面标题',
  url: '不是有效网址',
  pinned: false
}), true);

assert.strictEqual(matchedProjectGroup.minTabsPerGroup, 1);

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

const pendingUrlTabSnapshots = backgroundSandbox.buildTabSnapshots([
  { id: 104, title: '更新后待恢复页面', url: '', pendingUrl: 'https://a.ldxp.com/home', active: false, pinned: false, index: 0 },
  { id: 105, title: '更新后待恢复文档', pendingUrl: 'https://b.ldxp.com/docs', active: false, pinned: false, index: 1 }
]);
assert.deepStrictEqual(Array.from(pendingUrlTabSnapshots, (tab) => tab.url), [
  'https://a.ldxp.com/home',
  'https://b.ldxp.com/docs'
]);
assert.deepStrictEqual(Array.from(pendingUrlTabSnapshots, (tab) => tab.groupKey), ['ldxp.com', 'ldxp.com']);
assert.deepStrictEqual(Array.from(pendingUrlTabSnapshots, (tab) => tab.groupTitle), ['ldxp', 'ldxp']);
assert.strictEqual(typeof backgroundSandbox.normalizeRecentAccessMap, 'function');
assert.strictEqual(typeof backgroundSandbox.activateTabAcrossWindows, 'function');

const normalizedRecentAccessMap = backgroundSandbox.normalizeRecentAccessMap({
  101: 10,
  102: 30,
  abc: 40
});
assert.strictEqual(normalizedRecentAccessMap['102'], 30);
assert.strictEqual(normalizedRecentAccessMap['101'], 10);
assert.strictEqual(normalizedRecentAccessMap.abc, undefined);

const visibleGroupSummaries = backgroundSandbox.buildGroupSummaries([
  { id: 201, url: 'https://mail.google.com/inbox', pinned: false, index: 0 },
  { id: 202, url: 'https://docs.google.com/document', pinned: false, index: 1 },
  { id: 203, url: 'https://solo.example.com', pinned: false, index: 2 },
  { id: 204, url: 'https://pinned.example.net', pinned: true, index: 3 }
], { minTabsPerGroup: 2, priorityGroups: [] });
assert.deepStrictEqual(Array.from(visibleGroupSummaries, (group) => group.groupKey), ['google.com']);
assert.strictEqual(visibleGroupSummaries[0].title, 'google');

const organizedTabsWithSoloFirst = backgroundSandbox.buildOrganizedTabs([
  { id: 301, url: 'https://solo.example.com', pinned: false, index: 0 },
  { id: 302, url: 'https://mail.google.com/inbox', pinned: false, index: 1 },
  { id: 303, url: 'https://docs.google.com/document', pinned: false, index: 2 },
  { id: 304, url: 'https://github.com/example/repo', pinned: false, index: 3 },
  { id: 305, url: 'https://github.com/example/repo/issues', pinned: false, index: 4 },
  { id: 306, url: 'https://fixed.example.com', pinned: true, index: 5 }
], {
  minTabsPerGroup: 2,
  // 历史配置里可能残留单标签星标，排序仍应以真实会创建原生分组的主域名优先。
  priorityGroups: [{ groupKey: 'example.com' }]
});
assert.deepStrictEqual(Array.from(organizedTabsWithSoloFirst, (tab) => tab.id), [306, 303, 302, 304, 305, 301]);

const organizedTabsWithSavedPriorityOrder = backgroundSandbox.buildOrganizedTabs([
  { id: 311, url: 'https://mail.google.com/inbox', pinned: false, index: 0 },
  { id: 312, url: 'https://docs.google.com/document', pinned: false, index: 1 },
  { id: 313, url: 'https://github.com/example/repo', pinned: false, index: 2 },
  { id: 314, url: 'https://github.com/example/repo/issues', pinned: false, index: 3 }
], {
  minTabsPerGroup: 2,
  priorityGroups: [
    { groupKey: 'google.com', sortOrder: 1 },
    { groupKey: 'github.com', sortOrder: 0 }
  ]
});
// 显式保存的优先分组顺序必须覆盖当前标签栏顺序，否则高级管理里的排序按钮没有实际意义。
assert.deepStrictEqual(Array.from(organizedTabsWithSavedPriorityOrder, (tab) => tab.id), [313, 314, 312, 311]);

const customRuleSettings = backgroundSandbox.normalizeSettings({
  minTabsPerGroup: 3,
  priorityGroups: [],
  groupRules: [
    {
      id: 'rule-project-a-github',
      name: '项目 A 仓库',
      enabled: true,
      targetGroupKey: 'custom:项目 A',
      targetTitle: '项目 A',
      minTabsPerGroup: null,
      conditionTree: makeConditionTree([{ field: 'hostname', operator: 'contains', value: 'github.com' }]),
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'rule-project-a-doc',
      name: '项目 A 文档',
      enabled: true,
      targetGroupKey: 'custom:项目 A',
      targetTitle: '项目 A',
      minTabsPerGroup: null,
      conditionTree: makeConditionTree([{ field: 'hostname', operator: 'contains', value: 'docs.example.com' }]),
      createdAt: 2,
      updatedAt: 2
    }
  ]
});

const customOrganizedTabs = backgroundSandbox.buildOrganizedTabs([
  { id: 401, title: '零散', url: 'https://solo.example.com', pinned: false, index: 0 },
  { id: 402, title: '仓库', url: 'https://github.com/my-org/project-a', pinned: false, index: 1 },
  { id: 403, title: '其他', url: 'https://other.example.com', pinned: false, index: 2 },
  { id: 404, title: '文档', url: 'https://docs.example.com/project-a', pinned: false, index: 3 }
], customRuleSettings);
const customOrganizedIds = Array.from(customOrganizedTabs, (tab) => tab.id);
assert.strictEqual(Math.abs(customOrganizedIds.indexOf(402) - customOrganizedIds.indexOf(404)), 1);

const orRuleOrganizedTabs = backgroundSandbox.buildOrganizedTabs([
  { id: 701, title: '仓库', url: 'https://github.com/my-org/project-a', pinned: false, index: 0 },
  { id: 702, title: '普通', url: 'https://other.example.com/a', pinned: false, index: 1 },
  { id: 703, title: '文档', url: 'https://docs.example.com/project-a', pinned: false, index: 2 }
], backgroundSandbox.normalizeSettings({
  minTabsPerGroup: 2,
  priorityGroups: [],
  groupRules: [
    {
      id: 'rule-project-a-or',
      name: '项目 A',
      enabled: true,
      targetGroupKey: 'custom:项目 A',
      targetTitle: '项目 A',
      minTabsPerGroup: null,
      conditionTree: {
        type: 'group',
        logic: 'or',
        children: [
          { type: 'condition', field: 'hostname', operator: 'contains', value: 'github.com' },
          { type: 'condition', field: 'hostname', operator: 'contains', value: 'docs.example.com' }
        ]
      },
      createdAt: 1,
      updatedAt: 1
    }
  ]
}));
// 同一自定义分组内继续沿用完整主机名排序，因此这里断言聚拢结果而不是输入顺序。
assert.deepStrictEqual(Array.from(orRuleOrganizedTabs, (tab) => tab.id), [703, 701, 702]);

const customGroupSummaries = backgroundSandbox.buildGroupSummaries([
  { id: 411, title: '仓库', url: 'https://github.com/my-org/project-a', pinned: false, index: 0 },
  { id: 412, title: '文档', url: 'https://docs.example.com/project-a', pinned: false, index: 1 }
], customRuleSettings);
assert.strictEqual(customGroupSummaries.length, 0);

const customRuleThresholdSummaries = backgroundSandbox.buildGroupSummaries([
  { id: 421, title: '仓库', url: 'https://github.com/my-org/project-a', pinned: false, index: 0 }
], backgroundSandbox.normalizeSettings({
  minTabsPerGroup: 3,
  priorityGroups: [],
  groupRules: [
    {
      id: 'rule-project-a-one',
      name: '项目 A',
      enabled: true,
      targetGroupKey: 'custom:项目 A',
      targetTitle: '项目 A',
      minTabsPerGroup: 1,
      conditionTree: makeConditionTree([{ field: 'hostname', operator: 'contains', value: 'github.com' }]),
      createdAt: 1,
      updatedAt: 1
    }
  ]
}));
assert.strictEqual(customRuleThresholdSummaries.length, 1);
assert.strictEqual(customRuleThresholdSummaries[0].groupKey, 'custom:项目 A');
assert.strictEqual(customRuleThresholdSummaries[0].title, '项目 A');

const firstMatchedRuleThresholdSummaries = backgroundSandbox.buildGroupSummaries([
  { id: 431, title: '仓库', url: 'https://github.com/my-org/project-a', pinned: false, index: 0 },
  { id: 432, title: '文档', url: 'https://docs.example.com/project-a', pinned: false, index: 1 }
], backgroundSandbox.normalizeSettings({
  minTabsPerGroup: 3,
  priorityGroups: [],
  groupRules: [
    {
      id: 'rule-project-a-github',
      name: '项目 A 仓库',
      enabled: true,
      targetGroupKey: 'custom:项目 A',
      targetTitle: '项目 A',
      minTabsPerGroup: 3,
      conditionTree: makeConditionTree([{ field: 'hostname', operator: 'contains', value: 'github.com' }]),
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'rule-project-a-doc',
      name: '项目 A 文档',
      enabled: true,
      targetGroupKey: 'custom:项目 A',
      targetTitle: '项目 A',
      minTabsPerGroup: 1,
      conditionTree: makeConditionTree([{ field: 'hostname', operator: 'contains', value: 'docs.example.com' }]),
      createdAt: 2,
      updatedAt: 2
    }
  ]
}));
assert.strictEqual(firstMatchedRuleThresholdSummaries.length, 0);

const customTabSnapshots = backgroundSandbox.buildTabSnapshots([
  { id: 441, title: '仓库', url: 'https://github.com/my-org/project-a', active: false, pinned: false, index: 0 }
], customRuleSettings);
assert.strictEqual(customTabSnapshots[0].groupKey, 'custom:项目 A');
assert.strictEqual(customTabSnapshots[0].groupTitle, '项目 A');

const customGroupSnapshots = backgroundSandbox.buildGroupSnapshots(customTabSnapshots);
assert.strictEqual(customGroupSnapshots[0].groupKey, 'custom:项目 A');
assert.strictEqual(customGroupSnapshots[0].title, '项目 A');

const sameTargetDifferentTitleSettings = backgroundSandbox.normalizeSettings({
  minTabsPerGroup: 2,
  priorityGroups: [],
  groupRules: [
    {
      id: 'rule-same-target-one',
      name: '同组规则一',
      enabled: true,
      targetGroupKey: 'custom:同组',
      targetTitle: '标题一',
      minTabsPerGroup: null,
      conditionTree: makeConditionTree([{ field: 'hostname', operator: 'contains', value: 'one.example.com' }]),
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'rule-same-target-two',
      name: '同组规则二',
      enabled: true,
      targetGroupKey: 'custom:同组',
      targetTitle: '标题二',
      minTabsPerGroup: null,
      conditionTree: makeConditionTree([{ field: 'hostname', operator: 'contains', value: 'two.example.com' }]),
      createdAt: 2,
      updatedAt: 2
    }
  ]
});
const sameTargetDifferentTitleTabs = [
  { id: 445, title: '规则一标签', url: 'https://one.example.com/a', active: false, pinned: false, index: 0 },
  { id: 446, title: '规则二标签', url: 'https://two.example.com/a', active: false, pinned: false, index: 1 }
];
const sameTargetDifferentTitleSnapshots = backgroundSandbox.buildTabSnapshots(
  sameTargetDifferentTitleTabs,
  sameTargetDifferentTitleSettings
);
const reversedSameTargetDifferentTitleSnapshots = backgroundSandbox.buildTabSnapshots(
  [...sameTargetDifferentTitleTabs].reverse(),
  sameTargetDifferentTitleSettings
);
assert.deepStrictEqual(Array.from(sameTargetDifferentTitleSnapshots, (tab) => tab.groupTitle), ['标题一', '标题一']);
assert.deepStrictEqual(Array.from(reversedSameTargetDifferentTitleSnapshots, (tab) => tab.groupTitle), ['标题一', '标题一']);

const sameTargetDifferentTitleSummaries = backgroundSandbox.buildGroupSummaries(
  sameTargetDifferentTitleTabs,
  sameTargetDifferentTitleSettings
);
const reversedSameTargetDifferentTitleSummaries = backgroundSandbox.buildGroupSummaries(
  [...sameTargetDifferentTitleTabs].reverse(),
  sameTargetDifferentTitleSettings
);
assert.strictEqual(sameTargetDifferentTitleSummaries.length, 1);
assert.strictEqual(reversedSameTargetDifferentTitleSummaries.length, 1);
assert.strictEqual(sameTargetDifferentTitleSummaries[0].title, '标题一');
assert.strictEqual(reversedSameTargetDifferentTitleSummaries[0].title, '标题一');

const overshadowedDomainTitleSettings = backgroundSandbox.normalizeSettings({
  minTabsPerGroup: 1,
  priorityGroups: [],
  groupRules: [
    {
      id: 'rule-project-a-first',
      name: '项目 A 优先规则',
      enabled: true,
      targetGroupKey: 'custom:项目A',
      targetTitle: '项目A',
      minTabsPerGroup: null,
      conditionTree: makeConditionTree([{ field: 'path', operator: 'startsWith', value: '/my-org/project-a' }]),
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'rule-github-lower',
      name: '低优先级代码仓库规则',
      enabled: true,
      targetGroupKey: 'github.com',
      targetTitle: '代码仓库',
      minTabsPerGroup: null,
      conditionTree: makeConditionTree([{ field: 'path', operator: 'startsWith', value: '/my-org/project-a' }]),
      createdAt: 2,
      updatedAt: 2
    }
  ]
});
const overshadowedDomainTitleSummaries = backgroundSandbox.buildGroupSummaries([
  { id: 447, title: '项目仓库', url: 'https://github.com/my-org/project-a', active: false, pinned: false, index: 0 },
  { id: 448, title: '普通仓库', url: 'https://github.com/other-org/other', active: false, pinned: false, index: 1 }
], overshadowedDomainTitleSettings);
const overshadowedGithubSummary = overshadowedDomainTitleSummaries.find((summary) => summary.groupKey === 'github.com');
assert.strictEqual(overshadowedGithubSummary.title, 'github');

const domainKeyCustomTitleSettings = backgroundSandbox.normalizeSettings({
  minTabsPerGroup: 2,
  priorityGroups: [],
  groupRules: [
    {
      id: 'rule-github-project',
      name: '代码仓库规则',
      enabled: true,
      targetGroupKey: 'github.com',
      targetTitle: '代码仓库',
      minTabsPerGroup: null,
      conditionTree: makeConditionTree([{ field: 'path', operator: 'startsWith', value: '/my-org/project-a' }]),
      createdAt: 1,
      updatedAt: 1
    }
  ]
});
const mixedGithubTabs = [
  { id: 451, title: '项目仓库', url: 'https://github.com/my-org/project-a', active: false, pinned: false, index: 0 },
  { id: 452, title: '普通仓库', url: 'https://github.com/other-org/other', active: false, pinned: false, index: 1 }
];
const domainKeyCustomTitleSnapshots = backgroundSandbox.buildTabSnapshots(mixedGithubTabs, domainKeyCustomTitleSettings);
assert.deepStrictEqual(Array.from(domainKeyCustomTitleSnapshots, (tab) => tab.groupKey), ['github.com', 'github.com']);
assert.deepStrictEqual(Array.from(domainKeyCustomTitleSnapshots, (tab) => tab.groupTitle), ['代码仓库', '代码仓库']);

const domainKeyCustomTitleSummaries = backgroundSandbox.buildGroupSummaries(mixedGithubTabs, domainKeyCustomTitleSettings);
assert.strictEqual(domainKeyCustomTitleSummaries.length, 1);
assert.strictEqual(domainKeyCustomTitleSummaries[0].groupKey, 'github.com');
assert.strictEqual(domainKeyCustomTitleSummaries[0].title, '代码仓库');

const domainKeyCustomTitleGroupSnapshots = backgroundSandbox.buildGroupSnapshots(domainKeyCustomTitleSnapshots);
assert.strictEqual(domainKeyCustomTitleGroupSnapshots[0].groupKey, 'github.com');
assert.strictEqual(domainKeyCustomTitleGroupSnapshots[0].title, '代码仓库');

const laterMatchedDomainKeyThresholdSettings = backgroundSandbox.normalizeSettings({
  minTabsPerGroup: 3,
  priorityGroups: [],
  groupRules: [
    {
      id: 'rule-github-threshold',
      name: '代码仓库阈值规则',
      enabled: true,
      targetGroupKey: 'github.com',
      targetTitle: '代码仓库',
      minTabsPerGroup: 1,
      conditionTree: makeConditionTree([{ field: 'path', operator: 'startsWith', value: '/my-org/project-a' }]),
      createdAt: 1,
      updatedAt: 1
    }
  ]
});
const laterMatchedDomainKeyThresholdSummaries = backgroundSandbox.buildGroupSummaries([
  { id: 461, title: '普通仓库', url: 'https://github.com/other-org/other', active: false, pinned: false, index: 0 },
  { id: 462, title: '项目仓库', url: 'https://github.com/my-org/project-a', active: false, pinned: false, index: 1 }
], laterMatchedDomainKeyThresholdSettings);
assert.strictEqual(laterMatchedDomainKeyThresholdSummaries.length, 1);
assert.strictEqual(laterMatchedDomainKeyThresholdSummaries[0].groupKey, 'github.com');
assert.strictEqual(laterMatchedDomainKeyThresholdSummaries[0].title, '代码仓库');

const mixedRuleOrganizedTabs = backgroundSandbox.buildOrganizedTabs([
  { id: 471, title: '普通仓库', url: 'https://github.com/other-org/other', active: false, pinned: false, index: 0 },
  { id: 472, title: '其他项目', url: 'https://jira.example.com/browse/ONE', active: false, pinned: false, index: 1 },
  { id: 473, title: '项目仓库', url: 'https://github.com/my-org/project-a', active: false, pinned: false, index: 2 }
], backgroundSandbox.normalizeSettings({
  minTabsPerGroup: 3,
  priorityGroups: [],
  groupRules: [
    {
      id: 'rule-github-path',
      name: '代码仓库规则',
      enabled: true,
      targetGroupKey: 'github.com',
      targetTitle: '代码仓库',
      minTabsPerGroup: null,
      conditionTree: makeConditionTree([{ field: 'path', operator: 'startsWith', value: '/my-org/project-a' }]),
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'rule-jira-project',
      name: '其他项目规则',
      enabled: true,
      targetGroupKey: 'custom:其他项目',
      targetTitle: '其他项目',
      minTabsPerGroup: null,
      conditionTree: makeConditionTree([{ field: 'hostname', operator: 'contains', value: 'jira.example.com' }]),
      createdAt: 2,
      updatedAt: 2
    }
  ]
}));
const mixedRuleOrganizedIds = Array.from(mixedRuleOrganizedTabs, (tab) => tab.id);
const firstGithubPosition = mixedRuleOrganizedIds.indexOf(471);
const secondGithubPosition = mixedRuleOrganizedIds.indexOf(473);
assert.strictEqual(Math.abs(firstGithubPosition - secondGithubPosition), 1);

const customAndDomainGroupedOrderTabs = backgroundSandbox.buildOrganizedTabs([
  { id: 481, title: '普通一', url: 'https://zeta.example.com/a', active: false, pinned: false, index: 0 },
  { id: 482, title: '自定义一', url: 'https://alpha.example.com/a', active: false, pinned: false, index: 1 },
  { id: 483, title: '普通二', url: 'https://zeta.example.com/b', active: false, pinned: false, index: 2 },
  { id: 484, title: '自定义二', url: 'https://beta.example.com/b', active: false, pinned: false, index: 3 }
], backgroundSandbox.normalizeSettings({
  minTabsPerGroup: 2,
  priorityGroups: [],
  groupRules: [
    {
      id: 'rule-custom-order',
      name: '自定义排序规则',
      enabled: true,
      targetGroupKey: 'custom:排序分组',
      targetTitle: '排序分组',
      minTabsPerGroup: null,
      conditionTree: makeConditionTree([{ field: 'title', operator: 'contains', value: '自定义' }]),
      createdAt: 1,
      updatedAt: 1
    }
  ]
}));
assert.deepStrictEqual(Array.from(customAndDomainGroupedOrderTabs, (tab) => tab.id).slice(0, 2), [481, 483]);

const customHostnameSortedTabs = backgroundSandbox.buildOrganizedTabs([
  { id: 491, title: '乙', url: 'https://b.example.com/a', active: false, pinned: false, index: 0 },
  { id: 492, title: '甲', url: 'https://a.example.com/a', active: false, pinned: false, index: 1 }
], backgroundSandbox.normalizeSettings({
  minTabsPerGroup: 3,
  priorityGroups: [],
  groupRules: [
    {
      id: 'rule-custom-hostname',
      name: '同组主机排序规则',
      enabled: true,
      targetGroupKey: 'custom:同组主机',
      targetTitle: '同组主机',
      minTabsPerGroup: null,
      conditionTree: makeConditionTree([{ field: 'hostname', operator: 'contains', value: 'example.com' }]),
      createdAt: 1,
      updatedAt: 1
    }
  ]
}));
assert.deepStrictEqual(Array.from(customHostnameSortedTabs, (tab) => tab.id), [492, 491]);

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
const popupChromeCalls = {
  messages: [],
  tabQueries: [],
  storageGets: []
};
const popupSandbox = {
  console,
  URL,
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
      sendMessage(message) {
        popupChromeCalls.messages.push(message);
        return Promise.resolve({ ok: true, payload: {} });
      }
    },
    tabs: {
      async query(queryInfo) {
        popupChromeCalls.tabQueries.push(queryInfo);

        const currentTabs = [
          { id: 1, title: '当前页面', url: 'https://a.example.com', active: true, windowId: 10, index: 0, lastAccessed: 100 }
        ];
        const otherTabs = [
          { id: 2, title: '其他页面', url: 'https://b.example.com', active: false, windowId: 20, index: 0, lastAccessed: 200 }
        ];

        return queryInfo && queryInfo.currentWindow ? currentTabs : [...currentTabs, ...otherTabs];
      }
    },
    storage: {
      local: {
        async get(keys) {
          popupChromeCalls.storageGets.push(keys);

          return {
            'tabgod.settings': { minTabsPerGroup: 3 },
            'tabgod.recentAccess': { 2: 300 }
          };
        }
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

async function assertPopupDirectStateContract() {
  popupChromeCalls.messages.length = 0;
  popupChromeCalls.tabQueries.length = 0;
  popupChromeCalls.storageGets.length = 0;

  const localState = await popupSandbox.loadPopupStateFromBrowser();

  // 首屏直接读浏览器 API，原因是唤醒后台 service worker 是冷启动的主要耗时。
  assert.strictEqual(popupChromeCalls.messages.length, 0);
  assert.strictEqual(popupChromeCalls.tabQueries.length, 2);
  assert.strictEqual(popupChromeCalls.storageGets.length, 1);
  assert.strictEqual(localState.tabs.length, 2);
  assert.strictEqual(localState.tabs[0].groupKey, 'a.example.com');
  assert.strictEqual(localState.settings.minTabsPerGroup, 3);
  assert.strictEqual(localState.overview.allTabCount, 2);
  assert.strictEqual(localState.recentlyClosedTabs.length, 0);
  assert.strictEqual(localState.sessions.length, 0);
}

assert.strictEqual(typeof popupSandbox.getVisibleTabsFromState, 'function');
assert.strictEqual(typeof popupSandbox.formatRecentAccessTime, 'function');
assert.strictEqual(popupSandbox.formatRecentAccessTime(Date.now()), '刚刚');
assert.strictEqual(typeof popupSandbox.getSortHelpText, 'function');
assert.ok(popupSandbox.getSortHelpText('项目').includes('标题完全匹配 +400'));
assert.ok(popupSandbox.getSortHelpText('项目').includes('最近 1 分钟 +260'));
assert.ok(popupSandbox.getSortHelpText('').includes('最近使用按页面最近激活时间排序'));
const visibleSearchTabs = popupSandbox.getVisibleTabsFromState({
  query: '项目',
  tabs: [
    { id: 1, title: '普通页面', url: 'https://example.com', groupKey: 'example.com', groupTitle: 'example', lastAccessedAt: 1 },
    { id: 2, title: '项目页面', url: 'https://project.example.com', groupKey: 'custom:项目', groupTitle: '项目', lastAccessedAt: 2 }
  ]
});
assert.deepStrictEqual(Array.from(visibleSearchTabs, (tab) => tab.id), [2]);
const searchEnhancementTabs = [
  {
    id: 11,
    title: 'GitHub Pull Requests',
    url: 'https://github.com/acme/tabgod/pulls',
    groupKey: 'github.com',
    groupTitle: '研发协作',
    shortGroupTitle: 'github',
    isCurrentWindow: true,
    active: false,
    index: 0,
    lastAccessedAt: 1000
  },
  {
    id: 12,
    title: 'Issue 详情',
    url: 'https://github.com/acme/tabgod/issues/12',
    groupKey: 'github.com',
    groupTitle: '研发协作',
    shortGroupTitle: 'github',
    isCurrentWindow: true,
    active: false,
    index: 1,
    lastAccessedAt: 900
  },
  {
    id: 13,
    title: 'GitLab 合并请求',
    url: 'https://gitlab.example.com/acme/tabgod/-/merge_requests',
    groupKey: 'gitlab.example.com',
    groupTitle: '代码平台',
    shortGroupTitle: 'gitlab',
    isCurrentWindow: true,
    active: false,
    index: 2,
    lastAccessedAt: 800
  }
];
const multiKeywordResults = popupSandbox.getVisibleTabsFromState({
  query: 'github issue',
  tabs: searchEnhancementTabs,
  recentlyClosedTabs: []
});
assert.deepStrictEqual(Array.from(multiKeywordResults, (tab) => tab.id), [12]);
assert.ok(
  popupSandbox.getSearchMatchScore(searchEnhancementTabs[0], 'gpr') > 0,
  '标题首字母缩写应能命中 GitHub Pull Requests'
);
assert.ok(
  popupSandbox.getSearchMatchScore(searchEnhancementTabs[0], 'gh pr') > 0,
  '站点缩写和标题关键词组合应能命中 GitHub Pull Requests'
);
assert.ok(
  popupSandbox.getSearchMatchScore(searchEnhancementTabs[2], 'gh pr')
    < popupSandbox.getSearchMatchScore(searchEnhancementTabs[0], 'gh pr'),
  '缩写匹配不能压过更明确的站点和标题组合命中'
);
const visibleRecentTabs = popupSandbox.getVisibleTabsFromState({
  query: '',
  tabs: [
    { id: 3, title: '当前页面', active: true, isCurrentWindow: true, lastAccessedAt: 5, index: 0 },
    { id: 4, title: '最近页面', active: false, isCurrentWindow: false, lastAccessedAt: 10, index: 1 }
  ]
});
assert.deepStrictEqual(Array.from(visibleRecentTabs, (tab) => tab.id), [4]);
assert.strictEqual(typeof popupSandbox.getSearchRankingScore, 'function');
const nowForSearchRank = Date.now();
const recentInternalPageScore = popupSandbox.getSearchRankingScore({
  id: 5,
  title: '扩展程序',
  url: 'chrome://extensions/',
  groupKey: '其他',
  groupTitle: '其他',
  lastAccessedAt: nowForSearchRank
}, 'ex', nowForSearchRank);
const oldTitleMatchScore = popupSandbox.getSearchRankingScore({
  id: 6,
  title: 'Nexus Repository Manager',
  url: 'https://nexus.ddxq.mobi/#browse/search=keyword%3Dplan-base-data-client',
  groupKey: 'ddxq.mobi',
  groupTitle: 'ddxq',
  lastAccessedAt: nowForSearchRank - (2 * 60 * 60 * 1000)
}, 'ex', nowForSearchRank);
assert.ok(recentInternalPageScore > oldTitleMatchScore);
assert.strictEqual(typeof popupSandbox.formatGroupRuleThresholdText, 'function');
assert.strictEqual(popupSandbox.formatGroupRuleThresholdText(null, 2), '使用全局阈值：至少 2 个标签');
assert.strictEqual(popupSandbox.formatGroupRuleThresholdText(1, 2), '规则阈值：至少 1 个标签');
assert.strictEqual(typeof popupSandbox.createDefaultGroupRuleDraft, 'function');
assert.strictEqual(popupSandbox.createDefaultGroupRuleDraft().enabled, true);
assert.strictEqual(popupSandbox.createDefaultGroupRuleDraft().conditionTree.type, 'group');
assert.strictEqual(popupSandbox.createDefaultGroupRuleDraft().conditionTree.logic, 'and');
assert.strictEqual(popupSandbox.createDefaultGroupRuleDraft().conditionTree.children[0].type, 'condition');
assert.strictEqual(typeof popupSandbox.moveGroupRuleWithoutReload, 'function');
assert.strictEqual(typeof popupSandbox.applyGroupRuleMutationWithoutReload, 'function');
const popupJsContent = fs.readFileSync(popupPath, 'utf8');
assert.ok(!popupJsContent.includes('请在高级管理中确认'));
assert.ok(popupJsContent.includes('function focusDuplicateReviewPanel()'));
assert.ok(popupJsContent.includes('focusDuplicateReviewPanel();'));
assert.ok(popupJsContent.includes('move-priority-group'));
assert.ok(popupJsContent.includes('group-order-button'));

const popupHtml = fs.readFileSync(path.join(rootDir, 'popup.html'), 'utf8');
const popupCssContent = fs.readFileSync(path.join(rootDir, 'popup.css'), 'utf8');
const readmeContent = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');
const usageSvgContent = fs.readFileSync(path.join(rootDir, 'assets/插件使用页面标注.svg'), 'utf8');

// 弹窗和说明文档必须同时展示核心中文文案，避免功能已实现但入口或文档仍停留在旧“会话”命名。
assert.ok(popupHtml.includes('智能去重'));
assert.ok(popupHtml.includes('保存工作集'));
assert.ok(popupHtml.includes('工作集'));
assert.ok(popupHtml.includes('minTabsPerGroupInput'));
assert.ok(popupHtml.includes('分组阈值'));
assert.ok(popupHtml.includes('一键整理'));
assert.ok(popupHtml.includes('把当前窗口整理成清晰分组'));
assert.ok(popupHtml.includes('moreToolsButton'));
assert.ok(popupHtml.includes('moreToolsSection'));
assert.ok(popupHtml.includes('打开弹窗'));
assert.ok(popupHtml.includes('⌘⇧L'));
assert.ok(popupHtml.includes('Ctrl Shift L'));
assert.ok(popupHtml.includes('默认快捷键'));
assert.ok(popupHtml.includes('⌘⇧Y'));
assert.ok(popupHtml.includes('Ctrl Shift Y'));
assert.ok(popupHtml.includes('不会直接关闭'));
assert.ok(popupHtml.includes('groupRuleList'));
assert.ok(popupHtml.includes('groupRuleForm'));
assert.ok(popupHtml.includes('groupRuleFormStatus'));
assert.ok(popupHtml.includes('新增分组规则'));
assert.ok(popupHtml.includes('留空使用全局阈值'));
assert.ok(popupHtml.includes('当前全局'));
assert.ok(popupHtml.includes('启用此规则'));
assert.ok(!popupHtml.includes('保存后参与整理规则'));
assert.ok(popupHtml.includes('addRuleGroupButton'));
assert.ok(popupHtml.includes('条件组'));
assert.ok(popupHtml.includes('满足全部'));
assert.ok(popupHtml.includes('满足任一'));
assert.ok(popupHtml.includes('searchInput'));
assert.ok(popupHtml.includes('searchResultList'));
assert.ok(popupHtml.includes('sortHelpButton'));
assert.ok(popupHtml.includes('搜索标签页'));
assert.ok(popupHtml.includes('快速切换结果'));
assert.ok(popupHtml.includes('最近使用'));
assert.ok(popupCssContent.includes('.quick-result-list'));
assert.ok(popupCssContent.includes('.quick-result-item'));
assert.ok(popupCssContent.includes('.group-rule-form'));
assert.ok(popupCssContent.includes('.condition-row'));
assert.ok(popupCssContent.includes('.condition-group'));
assert.ok(popupCssContent.includes('.condition-group-child'));
assert.ok(popupCssContent.includes('.group-rule-item'));
assert.ok(popupCssContent.includes('.rule-form-status.is-error'));
assert.ok(readmeContent.includes('一键理顺满屏标签'));
assert.ok(readmeContent.includes('快速找回页面'));
assert.ok(readmeContent.includes('分组规则是插件的核心能力'));
assert.ok(readmeContent.includes('自定义分组规则'));
assert.ok(readmeContent.includes('规则阈值'));
assert.ok(readmeContent.includes('留空使用全局阈值'));
assert.ok(readmeContent.includes('条件组'));
assert.ok(readmeContent.includes('满足全部'));
assert.ok(readmeContent.includes('满足任一'));
assert.ok(readmeContent.includes('多个域名'));
assert.ok(readmeContent.includes('点击“整理当前窗口”'));
assert.ok(readmeContent.includes('搜索框会自动聚焦'));
assert.ok(readmeContent.includes('最近使用的已打开页面'));
assert.ok(usageSvgContent.includes('一键整理当前窗口'));
assert.ok(usageSvgContent.includes('搜索已打开标签'));
assert.ok(usageSvgContent.includes('最近使用与键盘选择'));
assert.ok(usageSvgContent.includes('分组规则是核心能力'));
assert.ok(usageSvgContent.includes('满足全部或满足任一'));

async function runAsyncChecks() {
  await assertPopupDirectStateContract();

  let storedSettingsForPriorityMove = {
    priorityGroups: [
      { groupKey: 'google.com', sortOrder: 0, starredAt: 1 },
      { groupKey: 'github.com', sortOrder: 1, starredAt: 2 }
    ]
  };
  backgroundSandbox.chrome.storage = {
    local: {
      get: async () => ({
        'tabgod.settings': storedSettingsForPriorityMove
      }),
      set: async (nextStored) => {
        storedSettingsForPriorityMove = nextStored['tabgod.settings'];
      }
    }
  };

  const priorityMoveResult = await backgroundSandbox.movePriorityGroup('github.com', 'up');

  assert.strictEqual(priorityMoveResult.moved, true);
  assert.deepStrictEqual(Array.from(storedSettingsForPriorityMove.priorityGroups, (group) => group.groupKey), ['github.com', 'google.com']);
  assert.deepStrictEqual(Array.from(storedSettingsForPriorityMove.priorityGroups, (group) => group.sortOrder), [0, 1]);

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

  groupOperations.grouped = [];
  groupOperations.ungrouped = [];
  groupOperations.updated = [];
  backgroundSandbox.queryCurrentWindowTabs = async () => [
    { id: 61, title: '仓库', url: 'https://github.com/my-org/project-a', pinned: false, groupId: -1 },
    { id: 62, title: '文档', url: 'https://docs.example.com/project-a', pinned: false, groupId: -1 }
  ];

  await backgroundSandbox.reconcileCurrentWindowGroups({
    minTabsPerGroup: 3,
    priorityGroups: [],
    groupRules: [
      {
        id: 'rule-project-a-github',
        name: '项目 A 仓库',
        enabled: true,
        targetGroupKey: 'custom:项目 A',
        targetTitle: '项目 A',
        minTabsPerGroup: 1,
        conditionTree: makeConditionTree([{ field: 'hostname', operator: 'contains', value: 'github.com' }]),
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'rule-project-a-doc',
        name: '项目 A 文档',
        enabled: true,
        targetGroupKey: 'custom:项目 A',
        targetTitle: '项目 A',
        minTabsPerGroup: null,
        conditionTree: makeConditionTree([{ field: 'hostname', operator: 'contains', value: 'docs.example.com' }]),
        createdAt: 2,
        updatedAt: 2
      }
    ]
  });
  assert.deepStrictEqual(groupOperations.grouped, [[61, 62]]);
  assert.deepStrictEqual(groupOperations.ungrouped, []);
  assert.strictEqual(groupOperations.updated[0].options.title, '项目 A');

  groupOperations.grouped = [];
  groupOperations.ungrouped = [];
  groupOperations.updated = [];
  backgroundSandbox.queryCurrentWindowTabs = async () => [
    { id: 71, title: '固定冲突', url: 'https://one.foo.net/a', pinned: true, groupId: 7 },
    { id: 72, title: '工作页一', url: 'https://a.foo.com/a', pinned: false, groupId: -1 },
    { id: 73, title: '工作页二', url: 'https://b.foo.com/b', pinned: false, groupId: -1 }
  ];

  await backgroundSandbox.reconcileCurrentWindowGroups({
    minTabsPerGroup: 2,
    priorityGroups: [],
    groupRules: []
  });
  assert.deepStrictEqual(groupOperations.grouped, [[72, 73]]);
  assert.strictEqual(groupOperations.updated[0].options.title, 'foo');

  groupOperations.grouped = [];
  groupOperations.updated = [];
  await backgroundSandbox.regroupRestoredTabs([
    { id: 81, title: '固定冲突', url: 'https://one.foo.net/a', pinned: true, index: 0 },
    { id: 82, title: '工作页一', url: 'https://a.foo.com/a', pinned: false, index: 1 },
    { id: 83, title: '工作页二', url: 'https://b.foo.com/b', pinned: false, index: 2 }
  ], {
    minTabsPerGroup: 2,
    priorityGroups: [],
    groupRules: []
  });
  assert.deepStrictEqual(groupOperations.grouped, [[82, 83]]);
  assert.strictEqual(groupOperations.updated[0].options.title, 'foo');

  const restoreOperations = {
    tabUpdates: [],
    createdTabs: [],
    grouped: []
  };
  const restoreWindowTabs = [];
  backgroundSandbox.chrome.storage = {
    local: {
      get: async () => ({
        'tabgod.sessions': [
          {
            id: 'session-pinned-first',
            name: '固定首个标签工作集',
            createdAt: 1,
            updatedAt: 1,
            activeUrl: 'https://github.com/other',
            tabs: [
              {
                id: 901,
                title: '固定仓库',
                url: 'https://github.com/pinned',
                pinned: true,
                active: false,
                index: 0
              },
              {
                id: 902,
                title: '普通仓库',
                url: 'https://github.com/other',
                pinned: false,
                active: true,
                index: 1
              }
            ],
            groups: []
          }
        ],
        'tabgod.settings': {
          minTabsPerGroup: 1,
          priorityGroups: [],
          groupRules: []
        }
      })
    }
  };
  backgroundSandbox.chrome.windows = {
    create: async ({ url, focused }) => {
      const createdWindowTab = { id: 911, title: '固定仓库', url, pinned: false, active: true, index: 0, windowId: 900 };
      restoreWindowTabs.push(createdWindowTab);

      return {
        id: 900,
        tabs: [createdWindowTab],
        focused
      };
    }
  };
  backgroundSandbox.chrome.tabs = {
    create: async (options) => {
      const createdTab = Object.assign({ id: 912, title: '普通仓库', index: 1, windowId: 900 }, options);
      restoreOperations.createdTabs.push(createdTab);
      restoreWindowTabs.push(createdTab);
      return createdTab;
    },
    update: async (tabId, options) => {
      restoreOperations.tabUpdates.push({ tabId, options });
      const tab = restoreWindowTabs.find((item) => item.id === tabId);

      if (tab) {
        Object.assign(tab, options);
      }

      return Object.assign({ id: tabId }, options);
    },
    group: async ({ tabIds }) => {
      restoreOperations.grouped.push(Array.from(tabIds));
      return 90;
    }
  };
  backgroundSandbox.chrome.tabGroups = {
    update: async () => undefined
  };
  backgroundSandbox.queryCurrentWindowTabs = async () => restoreWindowTabs;

  await backgroundSandbox.restoreSession('session-pinned-first', { newWindow: true });
  assert.ok(restoreOperations.tabUpdates.some((item) => {
    return item.tabId === 911 && item.options.pinned === true;
  }));
  assert.deepStrictEqual(restoreOperations.grouped, [[912]]);

  const duplicateRestoreOperations = {
    createdTabs: [],
    grouped: [],
    updated: []
  };
  const duplicateRestoreTabs = [
    { id: 921, title: '项目首页', url: 'https://a.ldxp.com/home', pinned: false, groupId: 21, index: 0 },
    { id: 922, title: '项目文档', url: 'https://b.ldxp.com/docs', pinned: false, groupId: 21, index: 1 }
  ];
  backgroundSandbox.chrome.storage = {
    local: {
      get: async () => ({
        'tabgod.sessions': [
          {
            id: 'session-duplicate-current-window',
            name: '重复恢复工作集',
            createdAt: 1,
            updatedAt: 1,
            activeUrl: 'https://a.ldxp.com/home',
            tabs: [
              {
                id: 923,
                title: '项目首页',
                url: 'https://a.ldxp.com/home',
                pinned: false,
                active: true,
                index: 0
              },
              {
                id: 924,
                title: '项目文档',
                url: 'https://b.ldxp.com/docs',
                pinned: false,
                active: false,
                index: 1
              }
            ],
            groups: []
          }
        ],
        'tabgod.settings': {
          minTabsPerGroup: 2,
          priorityGroups: [],
          groupRules: []
        }
      })
    }
  };
  backgroundSandbox.queryCurrentWindowTabs = async () => duplicateRestoreTabs;
  backgroundSandbox.chrome.tabs = {
    create: async (options) => {
      const createdTab = Object.assign({
        id: 923 + duplicateRestoreOperations.createdTabs.length,
        title: duplicateRestoreOperations.createdTabs.length === 0 ? '项目首页' : '项目文档',
        groupId: -1,
        index: duplicateRestoreTabs.length + duplicateRestoreOperations.createdTabs.length
      }, options);
      duplicateRestoreOperations.createdTabs.push(createdTab);
      duplicateRestoreTabs.push(createdTab);
      return createdTab;
    },
    update: async (tabId, options) => Object.assign({ id: tabId }, options),
    group: async ({ tabIds }) => {
      duplicateRestoreOperations.grouped.push(Array.from(tabIds));
      return 91;
    }
  };
  backgroundSandbox.chrome.tabGroups = {
    update: async (groupId, options) => {
      duplicateRestoreOperations.updated.push({ groupId, options });
    }
  };

  await backgroundSandbox.restoreSession('session-duplicate-current-window');
  assert.deepStrictEqual(duplicateRestoreOperations.grouped, [[921, 922, 923, 924]]);
  assert.strictEqual(duplicateRestoreOperations.updated[0].options.title, 'ldxp');

  const pendingRestoreOperations = {
    createdUrls: [],
    grouped: []
  };
  const pendingRestoreTabs = [];
  backgroundSandbox.chrome.storage = {
    local: {
      get: async () => ({
        'tabgod.sessions': [
          {
            id: 'session-pending-url',
            name: '更新后待恢复工作集',
            createdAt: 1,
            updatedAt: 1,
            activeUrl: 'https://a.ldxp.com/home',
            tabs: [
              {
                id: 931,
                title: '项目首页',
                url: '',
                pendingUrl: 'https://a.ldxp.com/home',
                pinned: false,
                active: true,
                index: 0
              },
              {
                id: 932,
                title: '项目文档',
                pendingUrl: 'https://b.ldxp.com/docs',
                pinned: false,
                active: false,
                index: 1
              }
            ],
            groups: []
          }
        ],
        'tabgod.settings': {
          minTabsPerGroup: 2,
          priorityGroups: [],
          groupRules: []
        }
      })
    }
  };
  backgroundSandbox.queryCurrentWindowTabs = async () => pendingRestoreTabs;
  backgroundSandbox.chrome.tabs = {
    create: async (options) => {
      const createdTab = Object.assign({
        id: 931 + pendingRestoreOperations.createdUrls.length,
        title: '待恢复页面',
        groupId: -1,
        index: pendingRestoreOperations.createdUrls.length
      }, options);
      pendingRestoreOperations.createdUrls.push(options.url);
      pendingRestoreTabs.push(createdTab);
      return createdTab;
    },
    update: async (tabId, options) => Object.assign({ id: tabId }, options),
    group: async ({ tabIds }) => {
      pendingRestoreOperations.grouped.push(Array.from(tabIds));
      return 92;
    }
  };
  backgroundSandbox.chrome.tabGroups = {
    update: async () => undefined
  };

  const pendingRestoreResult = await backgroundSandbox.restoreSession('session-pending-url');
  assert.deepStrictEqual(pendingRestoreOperations.createdUrls, [
    'https://a.ldxp.com/home',
    'https://b.ldxp.com/docs'
  ]);
  assert.deepStrictEqual(pendingRestoreOperations.grouped, [[931, 932]]);
  assert.strictEqual(pendingRestoreResult.failedCount, 0);

  const storedState = {
    'tabgod.settings': backgroundSandbox.normalizeSettings({
      minTabsPerGroup: 2,
      priorityGroups: [],
      groupRules: []
    })
  };

  backgroundSandbox.chrome.storage = {
    local: {
      get: async (keys) => {
        const result = {};
        keys.forEach((key) => {
          result[key] = storedState[key];
        });
        return result;
      },
      set: async (values) => {
        Object.assign(storedState, values);
      }
    }
  };
  // 规则消息只验证设置写入，不需要真实浏览器标签；空列表可避免整理当前窗口时依赖外部状态。
  backgroundSandbox.queryCurrentWindowTabs = async () => [];
  backgroundSandbox.chrome.tabs = {
    group: async () => {
      throw new Error('规则管理校验不应创建浏览器分组');
    },
    ungroup: async () => {
      throw new Error('规则管理校验不应解散浏览器分组');
    }
  };
  backgroundSandbox.chrome.tabGroups = {
    update: async () => {
      throw new Error('规则管理校验不应更新浏览器分组');
    }
  };

  await assert.rejects(
    () => backgroundSandbox.handleMessage({
      action: 'create-group-rule'
    }),
    /分组规则不能为空/
  );

  await assert.rejects(
    () => backgroundSandbox.handleMessage({
      action: 'create-group-rule',
      rule: {
        name: '空目标',
        targetTitle: '',
        conditionTree: makeConditionTree([{ field: 'hostname', operator: 'contains', value: 'github.com' }])
      }
    }),
    /目标分组名不能为空/
  );

  await assert.rejects(
    () => backgroundSandbox.handleMessage({
      action: 'create-group-rule',
      rule: {
        name: '空条件',
        targetTitle: '空条件',
        conditionTree: makeConditionTree([{ field: 'hostname', operator: 'contains', value: '' }])
      }
    }),
    /至少需要一个匹配条件/
  );

  const createdRuleResult = await backgroundSandbox.handleMessage({
    action: 'create-group-rule',
    rule: {
      name: '',
      targetTitle: '项目 A',
      minTabsPerGroup: '',
      conditionTree: {
        type: 'group',
        logic: 'or',
        children: [
          { type: 'condition', field: 'hostname', operator: 'contains', value: 'github.com' },
          { type: 'condition', field: 'hostname', operator: 'contains', value: 'docs.example.com' }
        ]
      }
    }
  });
  assert.strictEqual(createdRuleResult.rule.name, '项目 A');
  assert.strictEqual(createdRuleResult.rule.targetGroupKey, 'custom:项目 A');
  assert.strictEqual(createdRuleResult.rule.minTabsPerGroup, null);
  assert.strictEqual(createdRuleResult.rule.conditionTree.logic, 'or');
  assert.strictEqual(createdRuleResult.rule.conditionTree.children.length, 2);
  assert.strictEqual(createdRuleResult.rule.conditions, undefined);
  assert.strictEqual(createdRuleResult.settings.groupRules.length, 1);

  await assert.rejects(
    () => backgroundSandbox.handleMessage({
      action: 'update-group-rule',
      ruleId: createdRuleResult.rule.id,
      rule: {
        name: ''
      }
    }),
    /规则名称不能为空/
  );

  const updatedRuleResult = await backgroundSandbox.handleMessage({
    action: 'update-group-rule',
    ruleId: createdRuleResult.rule.id,
    rule: {
      enabled: false,
      minTabsPerGroup: 1,
      targetGroupKey: 'custom:非法改名'
    }
  });
  assert.strictEqual(updatedRuleResult.rule.enabled, false);
  assert.strictEqual(updatedRuleResult.rule.minTabsPerGroup, 1);
  assert.strictEqual(updatedRuleResult.rule.targetGroupKey, 'custom:项目 A');

  const secondRuleResult = await backgroundSandbox.handleMessage({
    action: 'create-group-rule',
    rule: {
      name: '项目 B',
      targetTitle: '项目 B',
      conditionTree: makeConditionTree([{ field: 'hostname', operator: 'contains', value: 'gitlab.com' }])
    }
  });
  assert.deepStrictEqual(
    storedState['tabgod.settings'].groupRules.map((rule) => rule.id),
    [createdRuleResult.rule.id, secondRuleResult.rule.id]
  );

  const moveSecondUpResult = await backgroundSandbox.handleMessage({
    action: 'move-group-rule',
    ruleId: secondRuleResult.rule.id,
    direction: 'up'
  });
  assert.strictEqual(moveSecondUpResult.moved, true);
  assert.deepStrictEqual(
    moveSecondUpResult.settings.groupRules.map((rule) => rule.id),
    [secondRuleResult.rule.id, createdRuleResult.rule.id]
  );

  const moveSecondUpBoundaryResult = await backgroundSandbox.handleMessage({
    action: 'move-group-rule',
    ruleId: secondRuleResult.rule.id,
    direction: 'up'
  });
  assert.strictEqual(moveSecondUpBoundaryResult.moved, false);

  const moveSecondDownResult = await backgroundSandbox.handleMessage({
    action: 'move-group-rule',
    ruleId: secondRuleResult.rule.id,
    direction: 'down'
  });
  assert.strictEqual(moveSecondDownResult.moved, true);
  assert.deepStrictEqual(
    moveSecondDownResult.settings.groupRules.map((rule) => rule.id),
    [createdRuleResult.rule.id, secondRuleResult.rule.id]
  );

  const movedRuleResult = await backgroundSandbox.handleMessage({
    action: 'move-group-rule',
    ruleId: createdRuleResult.rule.id,
    direction: 'up'
  });
  assert.strictEqual(movedRuleResult.moved, false);
  assert.strictEqual(movedRuleResult.settings.groupRules.length, 2);

  await assert.rejects(
    () => backgroundSandbox.handleMessage({
      action: 'move-group-rule',
      ruleId: 'missing-rule',
      direction: 'up'
    }),
    /没有找到要移动的分组规则/
  );

  await assert.rejects(
    () => backgroundSandbox.handleMessage({
      action: 'delete-group-rule',
      ruleId: 'missing-rule'
    }),
    /没有找到要删除的分组规则/
  );

  const deletedSecondRuleResult = await backgroundSandbox.handleMessage({
    action: 'delete-group-rule',
    ruleId: secondRuleResult.rule.id
  });
  assert.strictEqual(deletedSecondRuleResult.settings.groupRules.length, 1);

  const deletedRuleResult = await backgroundSandbox.handleMessage({
    action: 'delete-group-rule',
    ruleId: createdRuleResult.rule.id
  });
  assert.strictEqual(deletedRuleResult.settings.groupRules.length, 0);

  const updateSettingsStoredState = {
    'tabgod.settings': backgroundSandbox.normalizeSettings({
      minTabsPerGroup: 3,
      priorityGroups: [],
      groupRules: []
    })
  };
  const updateSettingsOperations = {
    grouped: [],
    ungrouped: [],
    updated: []
  };

  backgroundSandbox.chrome.storage = {
    local: {
      get: async (keys) => {
        const result = {};
        keys.forEach((key) => {
          result[key] = updateSettingsStoredState[key];
        });
        return result;
      },
      set: async (values) => {
        Object.assign(updateSettingsStoredState, values);
      }
    }
  };
  backgroundSandbox.queryCurrentWindowTabs = async () => [
    { id: 1001, title: '项目一', url: 'https://solo.example.com/a', pinned: false, groupId: -1 }
  ];
  backgroundSandbox.chrome.tabs = {
    group: async ({ tabIds }) => {
      updateSettingsOperations.grouped.push(Array.from(tabIds));
      return 100;
    },
    ungroup: async (tabIds) => {
      updateSettingsOperations.ungrouped.push(Array.from(tabIds));
    }
  };
  backgroundSandbox.chrome.tabGroups = {
    update: async (groupId, options) => {
      updateSettingsOperations.updated.push({ groupId, options });
    }
  };

  const updateSettingsResult = await backgroundSandbox.handleMessage({
    action: 'update-settings',
    settings: {
      minTabsPerGroup: 1
    }
  });
  assert.strictEqual(updateSettingsResult.settings.minTabsPerGroup, 1);
  assert.strictEqual(updateSettingsStoredState['tabgod.settings'].minTabsPerGroup, 1);
  assert.deepStrictEqual(updateSettingsOperations.grouped, [[1001]]);
}

runAsyncChecks()
  .then(() => {
    console.log('插件文件校验通过');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
