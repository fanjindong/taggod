(() => {
  const DEFAULT_SETTINGS = {
    // 限制保存数量是为了避免本地存储无限增长，同时保留最近的工作现场。
    maxSessionCount: 10,
    // 默认至少两个同主域名标签才建组，原因是单标签分组通常只会增加标签栏噪音。
    minTabsPerGroup: 2,
    organizeWithGroups: true,
    duplicateKeepStrategy: 'active-or-left',
    // 自定义规则默认为空，旧用户升级后仍沿用主域名分组。
    groupRules: [],
    priorityGroups: []
  };

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

  const GROUP_RULE_FIELDS = new Set(['hostname', 'primaryDomain', 'path', 'url', 'title']);
  const GROUP_RULE_OPERATORS = new Set(['contains', 'equals', 'startsWith']);
  const GROUP_RULE_LOGICS = new Set(['and', 'or']);
  // 单条规则最多 8 个真实条件，原因是 OR 域名场景需要比旧版更多空间，但弹窗仍要保持可控。
  const MAX_GROUP_RULE_CONDITION_COUNT = 8;
  // 条件组最多两层，避免弹窗编辑器变成难以理解的表达式树。
  const MAX_GROUP_RULE_GROUP_DEPTH = 2;

  function isIpAddressHost(hostname) {
    // IP 地址没有可注册主域名，保持原值可以避免把不同内网服务错误合并。
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
  }

  /**
   * 从完整主机名中提取用于归组的主域名。
   * @param {string} hostname 完整主机名。
   * @returns {string} 归一化后的主域名或兜底分组名。
   */
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

  /**
   * 从网址中解析稳定的主域名分组键。
   * @param {string} url 标签页网址。
   * @returns {string} 主域名分组键。
   */
  function getDomainKey(url) {
    try {
      const parsedUrl = new URL(url);
      return getPrimaryDomainFromHostname(parsedUrl.hostname);
    } catch (error) {
      // 无法解析的网址通常来自浏览器内部页面，归入“其他”能避免整理流程中断。
      return '其他';
    }
  }

  /**
   * 从网址中解析完整主机名，用于同组标签的稳定排序。
   * @param {string} url 标签页网址。
   * @returns {string} 小写完整主机名。
   */
  function getHostnameKey(url) {
    try {
      const parsedUrl = new URL(url);
      return String(parsedUrl.hostname || '其他').toLowerCase().replace(/\.$/, '');
    } catch (error) {
      // 异常网址没有可靠子域名，使用“其他”可以让它们在主域名兜底组内稳定排序。
      return '其他';
    }
  }

  /**
   * 获取标签页当前可用的网址，兼容尚未完成恢复的标签。
   * @param {Object} tab Chrome 标签页对象。
   * @returns {string} 当前网址或待加载网址。
   */
  function getTabUrl(tab) {
    // Chrome 更新或懒加载恢复期间，标签可能暂时只有 pendingUrl；保存时必须保留它，否则工作集会把页面当成空地址跳过。
    return String((tab && (tab.url || tab.pendingUrl)) || '');
  }

  function buildRuleMatchContext(tab) {
    const url = getTabUrl(tab);

    try {
      const parsedUrl = new URL(url);
      const hostname = String(parsedUrl.hostname || '').toLowerCase().replace(/\.$/, '');

      return {
        hostname,
        primaryDomain: getPrimaryDomainFromHostname(hostname),
        path: parsedUrl.pathname || '/',
        url,
        title: tab && tab.title ? tab.title : ''
      };
    } catch (error) {
      // 异常网址仍允许用标题匹配，其他 URL 字段用空值避免误判。
      return {
        hostname: '其他',
        primaryDomain: '其他',
        path: '',
        url,
        title: tab && tab.title ? tab.title : ''
      };
    }
  }

  function doesRuleConditionMatch(context, condition) {
    const actualValue = String(context[condition.field] || '').toLowerCase();
    const expectedValue = String(condition.value || '').toLowerCase();

    if (condition.operator === 'equals') {
      return actualValue === expectedValue;
    }

    if (condition.operator === 'startsWith') {
      return actualValue.startsWith(expectedValue);
    }

    // contains 作为模糊包含匹配，是为了让“域名包含 / 标题包含 / 路径包含”保持直观；需要精确匹配时可使用 equals。
    return actualValue.includes(expectedValue);
  }

  function doesConditionTreeNodeMatch(context, node) {
    if (!node) {
      return false;
    }

    if (node.type === 'condition') {
      return doesRuleConditionMatch(context, node);
    }

    if (node.type !== 'group' || !Array.isArray(node.children) || node.children.length === 0) {
      return false;
    }

    if (node.logic === 'or') {
      return node.children.some((child) => doesConditionTreeNodeMatch(context, child));
    }

    return node.children.every((child) => doesConditionTreeNodeMatch(context, child));
  }

  /**
   * 判断归一化条件树是否匹配指定标签页。
   * @param {Object} conditionTree 已归一化的条件树。
   * @param {Object} tab Chrome 标签页对象。
   * @returns {boolean} 是否匹配。
   */
  function doesConditionTreeMatchTab(conditionTree, tab) {
    const context = buildRuleMatchContext(tab);

    return doesConditionTreeNodeMatch(context, conditionTree);
  }

  /**
   * 判断已归一化且启用的规则是否匹配指定标签页。
   * @param {Object} rule 已归一化的分组规则。
   * @param {Object} tab Chrome 标签页对象。
   * @returns {boolean} 是否匹配。
   */
  function doesRuleMatchTab(rule, tab) {
    if (tab && tab.pinned) {
      // 固定标签不参与规则匹配，因为固定区由浏览器管理，整理规则不应改变其归属。
      return false;
    }

    if (!rule || !rule.enabled || !rule.conditionTree) {
      return false;
    }

    return doesConditionTreeMatchTab(rule.conditionTree, tab);
  }

  /**
   * 归一化全局建组阈值，非法值回退到默认阈值。
   * @param {*} value 待校验的阈值。
   * @returns {number} 不小于 1 的整数阈值。
   */
  function normalizeMinTabsPerGroup(value) {
    const numericValue = typeof value === 'number' ? value : Number.NaN;

    if (!Number.isInteger(numericValue) || numericValue < 1) {
      // 阈值必须至少为 1，原因是 0 或负数会让“至少几个标签才分组”的语义失效。
      return DEFAULT_SETTINGS.minTabsPerGroup;
    }

    return numericValue;
  }

  /**
   * 归一化规则级可选阈值，空值或非法值表示沿用全局配置。
   * @param {*} value 待校验的规则阈值。
   * @returns {number|null} 有效整数阈值或空值。
   */
  function normalizeOptionalMinTabsPerGroup(value) {
    if (value === null || value === undefined || value === '') {
      // 规则阈值为空时沿用全局阈值，避免每条规则都要求重复填写。
      return null;
    }

    const numericValue = typeof value === 'number' ? value : Number.NaN;

    if (!Number.isInteger(numericValue) || numericValue < 1) {
      return null;
    }

    return numericValue;
  }

  function normalizeGroupRuleCondition(condition) {
    const field = String(condition && condition.field ? condition.field : '').trim();
    const operator = String(condition && condition.operator ? condition.operator : '').trim();
    const value = String(condition && condition.value ? condition.value : '').trim();

    if (!GROUP_RULE_FIELDS.has(field) || !GROUP_RULE_OPERATORS.has(operator) || !value) {
      return null;
    }

    return {
      field,
      operator,
      value
    };
  }

  /**
   * 统计条件树中的真实条件数量，用于限制规则复杂度。
   * @param {Object} tree 条件树。
   * @returns {number} 条件数量。
   */
  function countConditionTreeConditions(tree) {
    if (!tree) {
      return 0;
    }

    if (tree.type === 'condition') {
      return 1;
    }

    if (tree.type !== 'group' || !Array.isArray(tree.children)) {
      return 0;
    }

    return tree.children.reduce((total, child) => total + countConditionTreeConditions(child), 0);
  }

  function normalizeConditionTreeNode(node, depth = 1) {
    if (!node || typeof node !== 'object') {
      return null;
    }

    if (node.type === 'condition') {
      const condition = normalizeGroupRuleCondition(node);

      return condition ? Object.assign({ type: 'condition' }, condition) : null;
    }

    if (node.type !== 'group' || depth > MAX_GROUP_RULE_GROUP_DEPTH) {
      return null;
    }

    const rawLogic = String(node.logic || '').trim();
    const logic = GROUP_RULE_LOGICS.has(rawLogic) ? rawLogic : 'and';
    const children = (Array.isArray(node.children) ? node.children : [])
      .map((child) => normalizeConditionTreeNode(child, depth + 1))
      .filter(Boolean);

    if (children.length === 0) {
      // 空组没有明确匹配含义，直接丢弃可以避免误命中全部标签。
      return null;
    }

    return {
      type: 'group',
      logic,
      children
    };
  }

  /**
   * 归一化并校验分组规则条件树。
   * @param {Object} tree 原始条件树。
   * @returns {Object|null} 可执行的条件树或空值。
   */
  function normalizeConditionTree(tree) {
    const normalizedTree = normalizeConditionTreeNode(tree, 1);

    if (!normalizedTree || normalizedTree.type !== 'group') {
      return null;
    }

    if (countConditionTreeConditions(normalizedTree) > MAX_GROUP_RULE_CONDITION_COUNT) {
      return null;
    }

    return normalizedTree;
  }

  /**
   * 提取决定规则身份与稳定编号的业务字段。
   * @param {Object} rule 原始分组规则。
   * @returns {Object} 归一化后的规则身份字段。
   */
  function buildGroupRuleIdentity(rule) {
    const targetTitle = String(rule && rule.targetTitle ? rule.targetTitle : rule && rule.name ? rule.name : '').trim();
    const name = String(rule && rule.name ? rule.name : targetTitle).trim();
    const targetGroupKey = String(rule && rule.targetGroupKey ? rule.targetGroupKey : targetTitle ? `custom:${targetTitle}` : '').trim();
    const conditionTree = normalizeConditionTree(rule && rule.conditionTree);

    return {
      name,
      enabled: rule && Object.prototype.hasOwnProperty.call(rule, 'enabled') ? Boolean(rule.enabled) : true,
      targetGroupKey,
      targetTitle,
      minTabsPerGroup: normalizeOptionalMinTabsPerGroup(rule && rule.minTabsPerGroup),
      conditionTree
    };
  }

  function buildStableGroupRuleBaseId(identity) {
    const source = [
      identity.name,
      String(identity.enabled),
      String(identity.minTabsPerGroup),
      identity.targetGroupKey,
      identity.targetTitle,
      JSON.stringify(identity.conditionTree || null)
    ].join('|');
    let hash = 0;

    for (let charIndex = 0; charIndex < source.length; charIndex += 1) {
      // 左移 5 位相当于乘以 32，用于让前序字符对 hash 保持影响。
      hash = ((hash << 5) - hash) + source.charCodeAt(charIndex);
      hash |= 0;
    }

    return `rule-${Math.abs(hash)}`;
  }

  /**
   * 归一化单条分组规则，无法安全解释的规则会被丢弃。
   * @param {Object} rule 原始分组规则。
   * @param {string} generatedId 缺少编号时使用的稳定编号。
   * @returns {Object|null} 归一化规则或空值。
   */
  function normalizeGroupRule(rule, generatedId) {
    const now = Date.now();
    const identity = buildGroupRuleIdentity(rule);

    if (!identity.name || !identity.targetTitle || !identity.targetGroupKey || !identity.conditionTree) {
      // 无法解释或会误命中的规则直接丢弃，原因是旧配置可能被手动写坏。
      return null;
    }

    return {
      id: String(rule && rule.id ? rule.id : generatedId),
      name: identity.name,
      enabled: identity.enabled,
      targetGroupKey: identity.targetGroupKey,
      targetTitle: identity.targetTitle,
      minTabsPerGroup: identity.minTabsPerGroup,
      conditionTree: identity.conditionTree,
      // 时间字段只是兼容旧配置的展示/排查元数据，不参与稳定 id 和匹配行为。
      createdAt: Number(rule && rule.createdAt) || now,
      updatedAt: Number(rule && rule.updatedAt) || now
    };
  }

  /**
   * 归一化规则列表并移除无效或重复编号的规则。
   * @param {Array<Object>} groupRules 原始规则列表。
   * @returns {Array<Object>} 可执行的规则列表。
   */
  function normalizeGroupRules(groupRules) {
    if (!Array.isArray(groupRules)) {
      return [];
    }

    const usedIds = new Set();
    const generatedIdCounts = new Map();

    return groupRules.map((rule) => {
      const hasRuleId = Boolean(rule && rule.id);
      const baseId = buildStableGroupRuleBaseId(buildGroupRuleIdentity(rule));
      const duplicateCount = hasRuleId ? 1 : (generatedIdCounts.get(baseId) || 0) + 1;

      if (!hasRuleId) {
        generatedIdCounts.set(baseId, duplicateCount);
      }

      // 旧配置或导入配置缺失 id 时，规则管理需要尽量稳定定位；只有完全相同的无 id 规则才用序号后缀。
      return normalizeGroupRule(rule, duplicateCount === 1 ? baseId : `${baseId}-${duplicateCount}`);
    }).filter((rule) => {
      if (!rule || usedIds.has(rule.id)) {
        // 重复编号会让编辑和排序目标不明确，保留第一条更符合用户看到的列表顺序。
        return false;
      }

      usedIds.add(rule.id);
      return true;
    });
  }

  /**
   * 归一化优先分组顺序并压紧排序编号。
   * @param {Array<Object>} priorityGroups 原始优先分组列表。
   * @returns {Array<Object>} 顺序稳定的优先分组列表。
   */
  function normalizePriorityGroups(priorityGroups) {
    if (!Array.isArray(priorityGroups)) {
      return [];
    }

    const usedGroupKeys = new Set();

    return priorityGroups.map((group, index) => {
      const groupKey = String(group && group.groupKey ? group.groupKey : '').trim();

      if (!groupKey || usedGroupKeys.has(groupKey)) {
        // 重复分组键会让显式顺序出现歧义，保留第一条更符合用户在列表中看到的顺序。
        return null;
      }

      usedGroupKeys.add(groupKey);

      return {
        groupKey,
        title: String(group && group.title ? group.title : groupKey).trim() || groupKey,
        starredAt: Number(group && group.starredAt) || Date.now(),
        // 旧版本没有 sortOrder，按原数组位置迁移，原因是原数组顺序就是用户逐个星标后的唯一稳定顺序。
        sortOrder: Number.isInteger(group && group.sortOrder) && group.sortOrder >= 0 ? group.sortOrder : index
      };
    }).filter(Boolean).sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) {
        return left.sortOrder - right.sortOrder;
      }

      return left.starredAt - right.starredAt;
    }).map((group, index) => Object.assign({}, group, {
      // 重新压紧编号可以避免删除或历史异常数据留下空洞，后续上移下移只需要交换数组项。
      sortOrder: index
    }));
  }

  /**
   * 归一化插件配置，供普通单次调用入口使用。
   * @param {Object} settings 原始插件配置。
   * @returns {Object} 字段完整且规则可执行的配置。
   */
  function normalizeSettings(settings) {
    const normalized = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    normalized.minTabsPerGroup = normalizeMinTabsPerGroup(normalized.minTabsPerGroup);

    normalized.priorityGroups = normalizePriorityGroups(normalized.priorityGroups);
    normalized.groupRules = normalizeGroupRules(normalized.groupRules);

    return normalized;
  }

  /**
   * 使用已归一化配置解析标签页最终分组，批量路径应复用此入口。
   * @param {Object} tab Chrome 标签页对象。
   * @param {Object} normalizedSettings 已通过 normalizeSettings 处理的配置。
   * @returns {Object} 分组键、标题、命中规则编号和建组阈值。
   */
  function getResolvedGroupInfoFromNormalizedSettings(tab, normalizedSettings) {
    if (tab && tab.pinned) {
      const url = getTabUrl(tab);

      return {
        groupKey: getDomainKey(url),
        title: getDomainKey(url),
        ruleId: '',
        minTabsPerGroup: normalizedSettings.minTabsPerGroup
      };
    }

    for (const rule of normalizedSettings.groupRules) {
      if (doesRuleMatchTab(rule, tab)) {
        return {
          groupKey: rule.targetGroupKey,
          title: rule.targetTitle,
          ruleId: rule.id,
          minTabsPerGroup: rule.minTabsPerGroup || normalizedSettings.minTabsPerGroup
        };
      }
    }

    const groupKey = getDomainKey(getTabUrl(tab));

    return {
      groupKey,
      title: groupKey,
      ruleId: '',
      minTabsPerGroup: normalizedSettings.minTabsPerGroup
    };
  }

  /**
   * 使用原始配置解析单个标签页的最终分组。
   * @param {Object} tab Chrome 标签页对象。
   * @param {Object} settings 原始插件配置。
   * @returns {Object} 分组键、标题、命中规则编号和建组阈值。
   */
  function getResolvedGroupInfo(tab, settings) {
    return getResolvedGroupInfoFromNormalizedSettings(tab, normalizeSettings(settings));
  }

  /**
   * 为 Chrome 原生分组生成尽量简短的显示标题。
   * @param {string} groupKey 最终分组键。
   * @returns {string} 简短分组标题。
   */
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

  /**
   * 批量生成分组短标题，并在短标题冲突时回退完整分组键。
   * @param {Array<string>} groupKeys 分组键列表。
   * @returns {Map<string, string>} 分组键到显示标题的映射。
   */
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

  /**
   * 使用已解析的分组信息生成稳定标题映射，避免批量调用方重复执行规则匹配。
   * @param {Array<Object>} groupInfos 标签页最终分组信息列表。
   * @param {Object} normalizedSettings 已通过 normalizeSettings 处理的配置。
   * @returns {Map<string, string>} 分组键到最终标题的映射。
   */
  function buildResolvedGroupTitleMapFromGroupInfos(groupInfos, normalizedSettings) {
    const safeGroupInfos = Array.isArray(groupInfos) ? groupInfos : [];
    const domainTitleMap = buildGroupTitleMap(safeGroupInfos
      .filter((info) => !info.ruleId)
      .map((info) => info.groupKey));
    const titleMap = new Map(domainTitleMap);
    const resolvedRuleGroupKeys = new Set(safeGroupInfos
      .filter((info) => info.ruleId)
      .map((info) => info.groupKey));
    const customTitleGroupKeys = new Set();

    normalizedSettings.groupRules.forEach((rule) => {
      if (
        !rule.enabled
        || !resolvedRuleGroupKeys.has(rule.targetGroupKey)
        || customTitleGroupKeys.has(rule.targetGroupKey)
      ) {
        return;
      }

      // 同一分组键的标题只由规则顺序决定，不能随当前标签子集或最近关闭记录变化。
      titleMap.set(rule.targetGroupKey, rule.targetTitle);
      customTitleGroupKeys.add(rule.targetGroupKey);
    });

    return titleMap;
  }

  /**
   * 使用已归一化配置批量解析稳定的分组标题映射。
   * @param {Array<Object>} tabs Chrome 标签页列表。
   * @param {Object} normalizedSettings 已通过 normalizeSettings 处理的配置。
   * @returns {Map<string, string>} 分组键到最终标题的映射。
   */
  function buildResolvedGroupTitleMapFromNormalizedSettings(tabs, normalizedSettings) {
    const safeTabs = Array.isArray(tabs) ? tabs : [];
    const groupInfos = safeTabs.map((tab) => getResolvedGroupInfoFromNormalizedSettings(tab, normalizedSettings));

    return buildResolvedGroupTitleMapFromGroupInfos(groupInfos, normalizedSettings);
  }

  /**
   * 使用原始配置批量解析稳定的分组标题映射。
   * @param {Array<Object>} tabs Chrome 标签页列表。
   * @param {Object} settings 原始插件配置。
   * @returns {Map<string, string>} 分组键到最终标题的映射。
   */
  function buildResolvedGroupTitleMap(tabs, settings = DEFAULT_SETTINGS) {
    return buildResolvedGroupTitleMapFromNormalizedSettings(tabs, normalizeSettings(settings));
  }

  /**
   * 使用已解析的分组信息构建单个标签页快照。
   * @param {Object} tab Chrome 标签页对象。
   * @param {Object} groupInfo 标签页最终分组信息。
   * @returns {Object} 可保存和搜索的标签页快照。
   */
  function buildTabSnapshotFromResolvedGroupInfo(tab, groupInfo) {
    const url = getTabUrl(tab);

    return {
      id: tab.id,
      title: tab.title || '未命名标签',
      url,
      favIconUrl: tab.favIconUrl || '',
      active: Boolean(tab.active),
      pinned: Boolean(tab.pinned),
      index: Number.isInteger(tab.index) ? tab.index : 0,
      groupKey: groupInfo.groupKey,
      groupTitle: groupInfo.title
    };
  }

  function buildTabSnapshotFromNormalizedSettings(tab, normalizedSettings) {
    const groupInfo = getResolvedGroupInfoFromNormalizedSettings(tab, normalizedSettings);

    return buildTabSnapshotFromResolvedGroupInfo(tab, groupInfo);
  }

  /**
   * 使用原始配置构建单个标签页快照。
   * @param {Object} tab Chrome 标签页对象。
   * @param {Object} settings 原始插件配置。
   * @returns {Object} 可保存和搜索的标签页快照。
   */
  function buildTabSnapshot(tab, settings = DEFAULT_SETTINGS) {
    return buildTabSnapshotFromNormalizedSettings(tab, normalizeSettings(settings));
  }

  /**
   * 使用已归一化配置批量构建标签页快照。
   * @param {Array<Object>} tabs Chrome 标签页列表。
   * @param {Object} normalizedSettings 已通过 normalizeSettings 处理的配置。
   * @returns {Array<Object>} 标题语义统一的标签页快照列表。
   */
  function buildTabSnapshotsFromNormalizedSettings(tabs, normalizedSettings) {
    const safeTabs = Array.isArray(tabs) ? tabs : [];
    const resolvedTabs = safeTabs.map((tab) => ({
      tab,
      groupInfo: getResolvedGroupInfoFromNormalizedSettings(tab, normalizedSettings)
    }));
    const snapshots = resolvedTabs.map(({ tab, groupInfo }) => {
      return buildTabSnapshotFromResolvedGroupInfo(tab, groupInfo);
    });
    const titleMap = buildResolvedGroupTitleMapFromGroupInfos(
      resolvedTabs.map(({ groupInfo }) => groupInfo),
      normalizedSettings
    );

    return snapshots.map((snapshot) => Object.assign({}, snapshot, {
      groupTitle: titleMap.get(snapshot.groupKey) || snapshot.groupTitle || snapshot.groupKey
    }));
  }

  /**
   * 使用原始配置批量构建标签页快照，配置只会归一化一次。
   * @param {Array<Object>} tabs Chrome 标签页列表。
   * @param {Object} settings 原始插件配置。
   * @returns {Array<Object>} 标题语义统一的标签页快照列表。
   */
  function buildTabSnapshots(tabs, settings = DEFAULT_SETTINGS) {
    // 普通入口只在批量处理开始前归一化一次，避免每个标签重复重建全部规则。
    return buildTabSnapshotsFromNormalizedSettings(tabs, normalizeSettings(settings));
  }

  // 显式命名空间避免共享脚本向弹窗和后台散落大量隐式全局变量。
  globalThis.TabGodGrouping = Object.freeze({
    DEFAULT_SETTINGS,
    MAX_GROUP_RULE_CONDITION_COUNT,
    buildGroupRuleIdentity,
    buildGroupTitleMap,
    buildResolvedGroupTitleMap,
    buildResolvedGroupTitleMapFromGroupInfos,
    buildResolvedGroupTitleMapFromNormalizedSettings,
    buildTabSnapshot,
    buildTabSnapshots,
    buildTabSnapshotsFromNormalizedSettings,
    countConditionTreeConditions,
    doesConditionTreeMatchTab,
    doesRuleMatchTab,
    getDomainKey,
    getHostnameKey,
    getPrimaryDomainFromHostname,
    getResolvedGroupInfo,
    getResolvedGroupInfoFromNormalizedSettings,
    getShortGroupTitle,
    getTabUrl,
    normalizeGroupRule,
    normalizeGroupRules,
    normalizeMinTabsPerGroup,
    normalizeOptionalMinTabsPerGroup,
    normalizePriorityGroups,
    normalizeConditionTree,
    normalizeSettings
  });
})();
