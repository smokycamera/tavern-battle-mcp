# 手机 / 桌面酒馆客户端

推荐从 [战斗插件仓库的 test 分支](https://github.com/smokycamera/sillytavern-general-battle-system/tree/test) 安装或更新。这个 MCP 仓库本身不是酒馆前端扩展。

`tavern-battle-extension-preview.zip` 是包含 MCP 桥接入口的原生扩展测试包。它同时包含完整 `manifest.json`、静态面板和运行文件。解压后由酒馆加载该扩展目录，或使用原仓库的安装方式；不要重复启用两份。

## 对应源代码

来源：[sillytavern-general-battle-system](https://github.com/smokycamera/sillytavern-general-battle-system)，GPL-3.0-only。

- 集成补丁的基础提交：`085027735f3a1b4d4d0c2f0ea556de1ae1a8101e`。
- `integration.patch`：原生宿主、主面板、档案恢复和战场占位信息改动。
- `panel/src/`：桥接、游戏 API、固定开局、隔离试战、恢复、准备与相关测试源文件。
- 服务端源文件在本仓库根目录。

开发者可在上述基础提交上应用补丁并复制新增文件：

```bash
git apply /path/to/tavern-battle-mcp/client/integration.patch
cp /path/to/tavern-battle-mcp/client/panel/src/*.ts panel/src/
npm ci
npm run typecheck
npm run build:extension
```

已合并桥接的 `test` 分支无需重复应用此补丁。压缩包包含的说明和附属服务文件与构建时版本一致；正式部署服务使用本仓库根目录维护的版本。
