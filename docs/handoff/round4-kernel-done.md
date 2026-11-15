# round4 / kernel（分支 `claude/week1-kernel-9a967c`）：安装、版本与升级、密钥、网络

> 进行中。先写出清单与插件代码一侧的写法，给插件会话用；完成后补全其余各节。

## 清单的新增部分（内核按此严格校验）

```json
{
  "upgradesFrom": ">=0.1.0",
  "requires": {
    "files": false,
    "network": { "hosts": ["api.example.com", "*.example.org", "localhost:8080"], "fromResources": true },
    "secrets": { "names": ["token"], "plaintext": false },
    "programs": [], "resources": false, "plugins": false
  },
  "contributes": {
    "kinds": [
      { "id": "request", "…": "…",
        "fields": {
          "url":   { "type": "text", "grants": "network" },
          "token": { "type": "secret" }
        } }
    ]
  }
}
```

- `upgradesFrom`：semver 范围（`semver` crate 语法）；不合法 → 拒绝（`badUpgradesFrom`）。新版本只接管 **低于自己** 且落在范围内的版本的资源。
- `requires.network.hosts`：`host`、`host:port`、`*.domain`（只匹配子域，不含 `domain` 本身）、IPv4；小写。不带端口 = 任何端口。不合法 → `badHost`。
- `requires.network.fromResources: true`：本插件自己类型的资源里，声明了 `"grants": "network"` 的字段的值是网址，它的主机（任何端口）即被授权。声明了 `grants` 而清单没有 `fromResources` → 拒绝（`grantsUndeclared`）；`grants` 只能是 `"network"`、只能用在 `"type": "text"` 上（`badGrants`）。
- `requires.secrets.names`：可用的密钥名字（字母、数字、`.`、`-`、`_`，≤128；否则 `badSecretName`）。`plaintext: true` 才能调 `ctx.host.secrets.get`（另一项权限 `secrets.plaintext`）。
- `kinds[].fields`：键是 body 的键（绑定路径 `body.<键>`），值 `{ "type": <FieldKind>, "grants"? }`。`"type": "secret"` 的字段是表单的密钥字段（D306）。
- `programs`、`resources`、`plugins` 本轮只用于在安装确认时列出，没有对应的能力。

## 插件代码一侧

```js
host.kinds.handle("request", {
  // D301：纯计算。body 是旧 body，fromVersion 是旧版本号，ctx 在最后（可以不要）。
  // 返回新 body（对象）；返回 null/undefined = 原样。期间写入类宿主调用被拒绝（denied/pureCall）。
  migrate(body, fromVersion, ctx) { return { ...body, note: "" }; },
});
// 只在 migrate 里可用：读旧版本的存储
await ctx.host.storage.readFrom("0.1.0", "key");
// 网络
const r = await ctx.host.network.request({ method: "GET", url, headers: { Authorization: "Bearer {{secret:token}}" }, body, timeoutMs });
// r = { status, headers: { 名: 值 }, body: "文字", truncated }
// 明文（须 requires.secrets.plaintext）
const v = await ctx.host.secrets.get("token");
```

- `{{secret:名字}}` 可以写在 `url`、请求头的值、`body` 里；名字不在本插件可用的名单里或不存在 → 整个调用 `denied`（`secretNotAllowed` / `unknownSecret`）。响应里出现该值的地方被换成 `***`。
- 本插件可用的密钥 = 清单 `requires.secrets.names` + 本插件类型的资源里 `secret` 字段指向的名字。
- 表单密钥字段：界面 `page.save` 时把用户填的值放在 `body.<键>`；内核写钥匙串，资源里存 `{ "secret": "<名字>" }`（默认名 `<资源id>.<键>`）；空字符串 = 不改。`page.resolve` 的 `values["body.<键>"]` 是 `true`（已保存）或 `false`。`ctx.resource.body.<键>` 是 `{ "secret": "<名字>" }`，插件拿不到值，要用时写 `{{secret:<名字>}}`。界面的 `draft`、运行的 `input` 里的密钥字段在交给插件前被去掉。

## 给外壳会话

- 主进程 `app.installPlugin` 成功后，若用户在确认框里确认了，请调用 `plugin.confirmPermissions(plugin, version)`：安装本身不等于确认（D299）；不需要任何权限、或权限是已确认版本子集的版本自动视为已确认。
- 工作区第一次见到某个插件时，文件夹里已有的版本都视为已确认（内置插件随应用发布；也包括第四轮之前就装着的）。
