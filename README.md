# Tavern Battle MCP · 通用战斗系统

**0.2.0 已提供 16 个工具。** 一条指令行动/开战、固定开局预览和隔离试战见 [游戏操作指南](GAMEPLAY.md)。

让 ChatGPT / Dots 和其他 MCP 客户端，以玩家视角操作手机或电脑上的 SillyTavern / TauriTavern 战阵插件。

本仓库是独立的 **MCP 服务端**，可放在 Linux VPS 上长期运行。手机 TT 的游戏本体继续运行在手机；个人电脑可以关闭。手机须保持战阵页面运行和连接，切到后台或锁屏后能否继续取决于手机系统。

```text
手机 TT 的战阵面板 ── HTTPS + 配对密钥 ── VPS 上的 MCP 服务
                                              ↑
                       Dot / ChatGPT ── MCP 或安全隧道
```

## 1. 更新手机 TT 插件

战斗插件仓库：[sillytavern-general-battle-system](https://github.com/smokycamera/sillytavern-general-battle-system)，使用 `test` 分支。更新后打开 **战阵 → 设置 → MCP 玩家操作**。

这里提供的服务端仓库不要填入 TT 的“安装扩展”地址。TT 安装的是战斗插件；这个仓库部署在 VPS。

另附 [可安装扩展测试包](client/tavern-battle-extension-preview.zip) 和 [客户端源文件及集成说明](client/README.md)。只启用一份战斗扩展。

## 2. 在 Linux VPS 部署

需要 Docker Engine 和 Compose v2，以及解析到 VPS 的域名。放行域名的 TCP 80、443。配置自动 HTTPS 的方式见 [Caddy 文档](https://caddyserver.com/docs/quick-starts/https)。

```bash
git clone https://github.com/smokycamera/tavern-battle-mcp.git
cd tavern-battle-mcp
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
nano .env
```

修改 `.env` 的三项：

| 项目 | 填写内容 |
| --- | --- |
| `MCP_DOMAIN` | 例如 `battle.your-domain.com`，不带 `https://` 或路径 |
| `TB_MCP_TOKEN` | 刚才生成的随机密钥；手机与 MCP 客户端使用同一密钥 |
| `TB_MCP_ORIGINS` | 手机 TT 设置中显示的“当前页面来源”；多个来源用逗号分隔 |

然后启动：

```bash
docker compose up -d --build
docker compose ps
curl --fail https://battle.your-domain.com/health
```

`/health` 返回服务名称即表明 HTTP 服务正常。Caddy 自动配置 HTTPS；Node 服务的 8766 端口只映射到 VPS 的本机回环地址。

如果 VPS 已经用 Nginx/Caddy/宝塔占用了 80/443，可只启动服务：

```bash
docker compose up -d --build mcp
```

用已有的 HTTPS 站点把请求反向代理到 `http://127.0.0.1:8766`，保留请求路径、Authorization、Origin 和请求体。无需把 8766 暴露到公网。

## 3. 手机 TT 连接 VPS

进入 **战阵 → 设置 → MCP 玩家操作**：

- 桥接地址填 `https://battle.your-domain.com`，不带 `/mcp`。
- 配对密钥填 VPS `.env` 中的 `TB_MCP_TOKEN`。
- 点击“连接 MCP”，保持面板运行。

手机不能填写 `127.0.0.1` 来连接 VPS。出现 403 时，将手机面板显示的实际页面来源加入 `TB_MCP_ORIGINS`，再运行 `docker compose up -d mcp` 使新环境配置生效。

## 4. Dot / ChatGPT 使用

### 支持 Bearer 的 MCP 客户端

- Streamable HTTP 地址：`https://battle.your-domain.com/mcp`
- 请求头：`Authorization: Bearer <TB_MCP_TOKEN>`
- 优先调用 `battle_state`；多个面板时先用 `battle_sessions` 选择。原界面流程仍可用 `battle_observe`。配对后能列出手机面板，就代表连接成立。

本地 stdio 客户端也可以连接同一台 VPS，而不创建另一份服务：

```bash
npm ci
export TB_MCP_URL=https://battle.your-domain.com/mcp
export TB_MCP_TOKEN='你的配对密钥'
node stdio-proxy.mjs
```

把这条进程命令配置到支持本地 stdio 的客户端即可。不要用 `server.mjs --stdio` 连接一个已运行的 VPS 实例：它会创建第二个独立服务。`stdio-proxy.mjs` 才会转发到手机已连接的服务。

### ChatGPT 个人插件与 Dots

Dots 可以使用账户已安装、启用且受支持的插件。[官方说明](https://learn.chatgpt.com/docs/dots/computers-and-apps)。**此仓库使用 Bearer 鉴权，不内置 OAuth。** 如果你的插件创建界面不能填写 Bearer 请求头，使用以下安全隧道路径；保持 HTTPS 服务的鉴权开启。

1. 按 [Secure MCP Tunnel 官方文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)，在 Platform 创建隧道并关联目标 ChatGPT 工作区，在 VPS 安装 `tunnel-client`。
2. 在 VPS 配置隧道所需的运行密钥。配置它的 **MCP command**，假设仓库位于 `/opt/tavern-battle-mcp`：

   ```text
   docker compose -f /opt/tavern-battle-mcp/compose.yaml exec -T mcp node stdio-proxy.mjs
   ```

   这条命令进入已经运行的容器，用相同密钥连接相同服务，不另占端口。隧道通过标准输入/输出调用它。
3. 按隧道文档运行 `tunnel-client doctor` 和 `tunnel-client run`，保持运行。
4. 在 ChatGPT 开发者模式的 **Plugins → ＋ → Connection → Tunnel** 中选择隧道，建立个人插件，检查能发现 16 个工具。然后让 Dot 使用这个已启用的插件。[官方连接步骤](https://developers.openai.com/plugins/deploy/connect-chatgpt)。

建议给 Dot 的第一条指令：

> 使用通用战斗系统插件，先列出已连接的战阵面板并读取当前玩家视图。暂时只检查连接和介绍可用操作。

本仓库测试了 MCP 协议和工具转发；具体账户的 Dots/插件/隧道权限，以及 VPS 域名和 TLS，需要在实际部署时验证。

## 工具

| 工具 | 用途 |
| --- | --- |
| `battle_sessions` | 列出主动配对的玩家面板 |
| `battle_observe` | 获取可见文字、控件、选项、禁用状态和保存反馈；可分页 |
| `battle_click` | 点击按钮、地图格、单位、标签页或展开项 |
| `battle_fill` | 填表、选择选项、开关或多选 |
| `battle_key` | Enter、空格、Escape、Tab、方向/Home/End 按键 |
| `battle_upload` | 向文件输入框放入用户提供的 JSON；继续走存档预览/确认 |
| `battle_help` | 获取指挥风格、能力、地图格式、战前公开单位代号和正文依据 |
| `battle_prepare` | 校验下一场指挥与地图，不直接开战 |
| `battle_state` | 玩家可见的游戏状态、坐标、每格单位 ID 与高亮标记 |
| `battle_act` | 一次执行同一单位的 1—8 个动作 |
| `battle_plan` | 完整准备、统一校验与固定开局预览 |
| `battle_start` | 一次配置并开战，或确认预览 ID |
| `battle_orders` | 下达会战军令并结算 |
| `battle_auto` | 立即启动或暂停全自动 |
| `battle_recover` | 战后恢复并可重新加入参战 |
| `battle_sandbox` | 隔离试战、满状态重开与独立战报 |

游戏状态、连续行动、军令、自动/暂停、完整准备/固定预览、一键开战、战后恢复与隔离试战可使用新游戏工具。原界面工具继续用于所有原有页面。默认不连接；不开放引擎后门，不读取隐藏敌人、原始快照、随机数或密钥。按键仍受回合、行动点、技能消耗、冷却、视野和存档规则约束。

原界面操作须使用最近 `battle_observe` 返回的 `viewId` / `controlId`。聊天、存档修订或界面改变后旧指令失效；超时写操作不会自动重放。`dispatched` 只代表已发出操作，是否成功以新界面、`feedback`、`saveStatus` 为准。

## 战前配置示例

先在手机任务设置中选好环境，再调用 `battle_prepare`：

```json
{
  "sessionId": "battle_sessions 返回的值",
  "viewId": "battle_observe 返回的值",
  "commanders": {
    "ally": { "ability": "skilled", "style": "flanking", "preferences": { "risk": 3, "reserve": 1 } },
    "enemy": { "ability": "regular", "style": "cautious" }
  },
  "battlefield": {
    "scene": "field",
    "layout": "lanes",
    "landmarks": [{ "kind": "hill", "anchor": "center_left", "label": "西侧高地" }]
  }
}
```

准备后仍需点击“开始交战”。只作用于下一场，复用本体地图生成和部署校验；不会额外调用副 API。详细格子地图用于小战，会战保留阵位规则。可用 `clear:true` 清除准备。

## 更新、日志与测试

```bash
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=100 mcp
```

服务重启后，手机需要重新配对。服务不持久保存玩家档案；存档仍在 TT 中。

不用 Docker 时可安装 Node.js 20+，运行 `npm ci && npm start`。Windows 有 `start.ps1`；本地开发默认监听 `127.0.0.1:8766`。

```bash
npm ci
npm test
```

GitHub Actions 在 Node 20/22/24 测试协议、鉴权、取消、stdio 和代理，并构建 Linux 容器、校验 HTTPS 配置。客户端的游戏集成及浏览器测试由[战斗插件仓库](https://github.com/smokycamera/sillytavern-general-battle-system)执行。

许可证：GPL-3.0-only，见 [LICENSE](LICENSE)。服务使用官方 `@modelcontextprotocol/sdk` 和 Zod，依赖遵循各自许可证。
