/**
 * API 文件夹（ApiGroup）的装配/变更工具。
 * 
 * 设计约定：
 * - 文件夹本身只存 { id, name, collapsed }，不存 API 列表；归属关系写在 ApiConfig.groupId 上。
 * - 因此「删文件夹」绝不能删 API —— 释放到未分组（groupId 清空）后再删文件夹。
 * - 所有写库函数都返回新的列表，方便调用方直接 setState。
 */
import type { ApiConfig, ApiGroup } from "./settings-types";
import { loadApiConfigs, loadApiGroups, saveApiConfigs, saveApiGroups } from "./settings-storage";

export type GroupedApiSection = {
    group: ApiGroup;
    items: ApiConfig[];
};

export type GroupedApiView = {
    sections: GroupedApiSection[];
    ungrouped: ApiConfig[];
};

/**
 * 按文件夹顺序分组；groupId 指向不存在文件夹的条目自动归入 ungrouped（防御孤儿引用）。
 */
export function buildGroupedApiView(configs: ApiConfig[], groups: ApiGroup[]): GroupedApiView {
    const groupMap = new Map<string, ApiConfig[]>();
    for (const g of groups) {
        groupMap.set(g.id, []);
    }
    const ungrouped: ApiConfig[] = [];
    for (const cfg of configs) {
        if (cfg.groupId && groupMap.has(cfg.groupId)) {
            groupMap.get(cfg.groupId)!.push(cfg);
        } else {
            ungrouped.push(cfg);
        }
    }
    const sections: GroupedApiSection[] = groups.map(group => ({
        group,
        items: groupMap.get(group.id) || [],
    }));
    return { sections, ungrouped };
}

export function createApiGroup(name: string, currentGroups?: ApiGroup[]): ApiGroup[] {
    const groups = currentGroups ?? loadApiGroups();
    const trimmed = name.trim() || "新建文件夹";
    const next: ApiGroup[] = [
        ...groups,
        {
            id: `api_group_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: trimmed,
            collapsed: false,
        },
    ];
    saveApiGroups(next);
    return next;
}

export function renameApiGroup(groupId: string, name: string, currentGroups?: ApiGroup[]): ApiGroup[] {
    const groups = currentGroups ?? loadApiGroups();
    const trimmed = name.trim();
    if (!trimmed) return groups;
    const next = groups.map(g => (g.id === groupId ? { ...g, name: trimmed } : g));
    saveApiGroups(next);
    return next;
}

export function toggleApiGroupCollapsed(groupId: string, currentGroups?: ApiGroup[]): ApiGroup[] {
    const groups = currentGroups ?? loadApiGroups();
    const next = groups.map(g => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g));
    saveApiGroups(next);
    return next;
}

/**
 * 删除文件夹：把该文件夹下的所有 API 释放回未分组（清除 groupId），然后移除文件夹。
 */
export function deleteApiGroupAndRelease(
    groupId: string,
    currentGroups?: ApiGroup[],
    currentConfigs?: ApiConfig[],
): { groups: ApiGroup[]; configs: ApiConfig[] } {
    const groups = (currentGroups ?? loadApiGroups()).filter(g => g.id !== groupId);
    const rawConfigs = currentConfigs ?? loadApiConfigs();
    let changed = false;
    const configs = rawConfigs.map(cfg => {
        if (cfg.groupId !== groupId) return cfg;
        changed = true;
        const next = { ...cfg };
        delete next.groupId;
        return next;
    });
    saveApiGroups(groups);
    if (changed) saveApiConfigs(configs);
    return { groups, configs };
}

/**
 * 将指定 API 移入目标文件夹（groupId 为 undefined/null/空串 时移回未分组）。
 */
export function moveApiConfigToGroup(
    configId: string,
    targetGroupId: string | undefined | null,
    currentConfigs?: ApiConfig[],
): ApiConfig[] {
    const rawConfigs = currentConfigs ?? loadApiConfigs();
    const normalizedTarget = targetGroupId ? targetGroupId : undefined;
    let changed = false;
    const configs = rawConfigs.map(cfg => {
        if (cfg.id !== configId) return cfg;
        if ((cfg.groupId || undefined) === normalizedTarget) return cfg;
        changed = true;
        const next = { ...cfg };
        if (normalizedTarget) {
            next.groupId = normalizedTarget;
        } else {
            delete next.groupId;
        }
        return next;
    });
    if (changed) saveApiConfigs(configs);
    return configs;
}
