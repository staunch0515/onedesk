import { describe, expect, it } from "vitest";
import type { Resource } from "../plugin-api";
import { buildMenu, EMPTY_MENU_PREFS, moveGroup, moveItem, normalizeMenuPrefs, setCollapsed } from "./menu-model";

function res(id: string, name: string, group = ""): Resource {
  return {
    id,
    kind: "sample",
    name,
    group,
    tags: [],
    description: "",
    body: {},
    visibility: "private",
    aiVisible: false,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    origin: "original",
  };
}

const list = [res("a", "乙", "工作"), res("b", "甲", "工作"), res("c", "丙"), res("d", "丁", "个人"), res("e", "戊", " 工作 ")];

describe("菜单分组与排序", () => {
  it("按 group 分组（去掉首尾空格），默认分组按名字排序、未分组在最后、组内按名字", () => {
    const menu = buildMenu(list, EMPTY_MENU_PREFS);
    expect(menu.map((g) => g.key)).toEqual(["个人", "工作", ""]);
    expect(menu[1]!.items.map((r) => r.id)).toEqual(["b", "e", "a"]); // 甲 jiǎ, 戊 wù, 乙 yǐ
    expect(menu[2]!.items.map((r) => r.id)).toEqual(["c"]);
  });

  it("保存的顺序优先，新出现的项目排在后面", () => {
    const prefs = { groupOrder: ["", "工作"], itemOrder: { 工作: ["e", "a"] }, collapsed: [] };
    const menu = buildMenu(list, prefs);
    expect(menu.map((g) => g.key)).toEqual(["", "工作", "个人"]);
    expect(menu[1]!.items.map((r) => r.id)).toEqual(["e", "a", "b"]);
  });

  it("拖动：把 active 移到 over 的位置，只改该分组的顺序", () => {
    const menu = buildMenu(list, EMPTY_MENU_PREFS);
    const work = menu.find((g) => g.key === "工作")!;
    const before = work.items.map((r) => r.id);
    const next = moveItem(EMPTY_MENU_PREFS, work, before[2]!, before[0]!);
    expect(next.itemOrder["工作"]).toEqual([before[2], before[0], before[1]]);
    expect(buildMenu(list, next).find((g) => g.key === "工作")!.items.map((r) => r.id)).toEqual(next.itemOrder["工作"]);
    expect(moveItem(EMPTY_MENU_PREFS, work, "x", "a")).toBe(EMPTY_MENU_PREFS);
  });

  it("分组上移下移，越界不变", () => {
    const menu = buildMenu(list, EMPTY_MENU_PREFS);
    const up = moveGroup(EMPTY_MENU_PREFS, menu, "工作", -1);
    expect(up.groupOrder).toEqual(["工作", "个人", ""]);
    expect(moveGroup(EMPTY_MENU_PREFS, menu, "个人", -1)).toBe(EMPTY_MENU_PREFS);
    expect(moveGroup(EMPTY_MENU_PREFS, menu, "", 1)).toBe(EMPTY_MENU_PREFS);
  });

  it("折叠状态可切换且不重复", () => {
    const a = setCollapsed(EMPTY_MENU_PREFS, "工作", true);
    expect(setCollapsed(a, "工作", true).collapsed).toEqual(["工作"]);
    expect(setCollapsed(a, "工作", false).collapsed).toEqual([]);
  });

  it("存储内容不合法时回到默认值", () => {
    expect(normalizeMenuPrefs(null)).toEqual(EMPTY_MENU_PREFS);
    expect(normalizeMenuPrefs("x")).toEqual(EMPTY_MENU_PREFS);
    expect(normalizeMenuPrefs({ groupOrder: [1], itemOrder: { a: ["x"], b: 3 }, collapsed: ["c"] })).toEqual({
      groupOrder: [],
      itemOrder: { a: ["x"] },
      collapsed: ["c"],
    });
  });
});
