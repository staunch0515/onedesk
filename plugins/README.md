内置插件的包，每个一个文件夹 `<插件id>/`（见 docs/handoff/week1-protocol.md §6）。主进程启动时复制到数据目录的 `plugins/<id>/<version>/`。

## 插件里的错误：文字怎样到界面

- 插件里 `throw new Error("文字")`（不带 `code`）：界面显示这段文字。文字要自己翻译（用插件 `locales/` 里的键），不得带密码、令牌等密钥。
- 错误对象带了**宿主错误码**（`invalid`、`notFound`、`denied` 等，内核自己用的那批）：界面按码显示外壳的文字，插件写的文字不会出现。要让自己的文字到界面，错误不要带宿主码。
- 经 `host.actions.call` 调用别的插件：被调方出错时，调用方拿到 `code: "pluginError"`、`params.reason: "calleeFailed"`，`e.message` 与 `e.detail` 是被调方错误的第一行文字（已按这次运行读过的密钥值抹成 `***`）。调用方可以直接 `throw` 或改写后再抛；不要依赖被调方的 `params` 回传。
- 运行失败时，运行记录里保存的是已抹去密钥的文字。
