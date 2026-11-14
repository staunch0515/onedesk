import { expect, sidebar, t, test } from "./fixtures/app";
import { createResource, openFromMenu } from "./fixtures/helpers";

const main = (page: import("@playwright/test").Page) => page.getByRole("main", { name: t("app.mainLabel") });

async function save(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: t("common.save"), exact: true }).first().click();
  await expect(page.getByText(t("edit.saved")).first()).toBeVisible();
}

test.describe("create and use the four resource kinds", () => {
  test("link: create, open calls the platform", async ({ app }) => {
    await createResource(app, "网址", "我的网址", { 网址: "https://example.org/docs" });
    await expect(sidebar(app).getByRole("button", { name: "我的网址", exact: true })).toBeVisible();
    await app.getByRole("tab", { name: "详情" }).click();
    await app.getByRole("button", { name: "打开", exact: true }).click();
    await expect.poll(() => app.evaluate(() => window.__opened)).toEqual(["https://example.org/docs"]);
    await expect(main(app).getByText(t("action.success", { label: "打开" }))).toBeVisible();
  });

  test("note: markdown is rendered in the reading view", async ({ app }) => {
    await createResource(app, "笔记", "会议记录");
    await app.getByRole("textbox", { name: "内容" }).fill("# 本周结论\n\n- 要点甲\n- 要点乙\n\n**加粗文字**");
    await save(app);
    await app.getByRole("tab", { name: "阅读" }).click();
    await expect(main(app).getByRole("heading", { name: "本周结论" })).toBeVisible();
    await expect(main(app).getByRole("listitem")).toHaveCount(2);
    await expect(main(app).locator("strong", { hasText: "加粗文字" })).toBeVisible();
  });

  test("prompt: fill parameters and copy to the clipboard", async ({ app }) => {
    await createResource(app, "提示词", "问候", { 模板: "你好" });
    await app.getByRole("button", { name: t("param.add") }).click();
    await app.getByRole("textbox", { name: t("param.name") }).first().fill("who");
    await app.getByRole("textbox", { name: t("param.default") }).first().fill("世界");
    await app.getByRole("button", { name: t("param.add") }).click();
    await app.getByRole("textbox", { name: t("param.name") }).nth(1).fill("day");
    await app.getByRole("textbox", { name: "模板" }).fill("你好，{{who}}！今天是{{day}}。");
    await save(app);
    await app.getByRole("tab", { name: "预览" }).click();
    await app.getByRole("button", { name: "复制", exact: true }).click();
    const dialog = app.getByRole("dialog", { name: t("action.inputTitle", { label: "复制" }) });
    await expect(dialog).toBeVisible();
    // The default value is pre-filled.
    await expect(dialog.getByRole("textbox", { name: /who/ })).toHaveValue("世界");
    await dialog.getByRole("textbox", { name: /day/ }).fill("周五");
    await dialog.getByRole("button", { name: t("action.run") }).click();
    await expect(main(app).getByText(t("action.success", { label: "复制" }))).toBeVisible();
    expect(await app.evaluate(() => navigator.clipboard.readText())).toBe("你好，世界！今天是周五。");
  });

  test("http: send to a local server and read the status in the response view", async ({ app, server }) => {
    await createResource(app, "HTTP 请求", "本地接口", { 网址: `${server.url}/items?a=1` });
    await app.getByRole("tab", { name: "响应" }).click();
    await expect(main(app).getByText(t("action.noOutput"))).toHaveCount(0);
    await app.getByRole("button", { name: "发送", exact: true }).click();
    await expect(main(app).getByText(t("action.success", { label: "发送" }))).toBeVisible();
    await expect(main(app).getByText(/200 OK/).first()).toBeVisible();
    await expect(main(app).getByText(/"path":"\/items\?a=1"/).first()).toBeVisible();
    // The stored response is shown in the response view.
    await expect(main(app).getByText("状态", { exact: true })).toBeVisible();
    await expect(main(app).getByRole("columnheader", { name: "名称" })).toBeVisible();
  });

  test("http: a non-2xx status is shown, not hidden", async ({ app, server }) => {
    await createResource(app, "HTTP 请求", "茶壶", { 网址: `${server.url}/teapot` });
    await app.getByRole("tab", { name: "响应" }).click();
    await app.getByRole("button", { name: "发送", exact: true }).click();
    await expect(main(app).getByText(/418/).first()).toBeVisible();
    await expect(main(app).getByText("服务器返回 418")).toBeVisible();
  });
});

test("action failure shows a red reason with a hint", async ({ app }) => {
  // Port 1 refuses connections: the plugin turns the network error into a failed result.
  await createResource(app, "HTTP 请求", "坏请求", { 网址: "http://127.0.0.1:1/never" });
  await app.getByRole("tab", { name: "响应" }).click();
  await app.getByRole("button", { name: "发送", exact: true }).click();
  const failed = main(app).getByText(t("action.error", { label: "发送" }));
  await expect(failed).toBeVisible();
  await expect(main(app).getByText(/请求失败/)).toBeVisible();
  await expect(main(app).getByText("处理方式：检查网址、网络连接或超时设置")).toBeVisible();
  await expect(failed).toHaveCSS("color", /rgb\(/);
  await openFromMenu(app, "坏请求");
});

test("edit view: invalid url shows a field error and focuses the field", async ({ app }) => {
  await openFromMenu(app, "OneDesk 项目主页");
  await app.getByRole("tab", { name: "编辑" }).click();
  const url = app.getByRole("textbox", { name: "网址" });
  await url.fill("ftp://bad");
  await app.getByRole("button", { name: t("common.save"), exact: true }).first().click();
  await expect(main(app).getByText(t("field.url", { label: "网址" }))).toBeVisible();
  await expect(url).toBeFocused();
});
