# MCP 0.2.0：游戏操作、固定预览与隔离试战

服务端和战斗插件都更新后可发现 **16 个工具**：原来的 8 个界面工具完整保留，新增 8 个游戏工具。游戏规则、视野、借机攻击、资源、冷却和存档流程仍由本体执行。

## 最短使用流程

先调用 `battle_state`。仅有一个已连接面板时，新游戏工具可省略 `sessionId`；连接多个时先 `battle_sessions` 选择。查看 `environment`：`live` 是正式游戏，`sandbox` 是隔离试战。

| 工具 | 用途 |
| --- | --- |
| `battle_state` | 游戏状态、单位 ID、合法行动、地图、保存与自动运行状态 |
| `battle_act` | 一次执行同一单位的 1—8 个动作 |
| `battle_plan` | 一次准备完整配置，返回固定开局预览 |
| `battle_start` | 一次配置并开战，或确认已有 `previewId` |
| `battle_orders` | 提交会战军令并结算；`resolve:false` 仅下令 |
| `battle_auto` | 立即启动/暂停全自动 |
| `battle_recover` | 战后收兵、恢复可恢复伤情，默认重新加入参战 |
| `battle_sandbox` | 一键隔离试战、满状态重开、独立战报与返回正式档案 |

游戏写操作使用最近返回的 `stateId` 和新 `requestId`。例如对 `battle_act` 提交：

```json
{"stateId":"最近返回的状态ID","requestId":"turn-3-player","actions":[{"type":"move","cell":"D8"},{"type":"attack","targetId":"目标单位ID"},{"type":"end_turn"}]}
```

省略 `actorId` 时使用当前行动单位，整个动作链固定这名单位。每一步经过引擎校验并保存；反应攻击若使行动者倒地，后续步骤停止，不会换成队友代执行。

`completedSteps` 表示确认完成的步数；`partial` / `failed` 请检查 `error` 和新状态，已保存的步骤不会撤销。`pending` 用 `battle_state({requestId})` 查询。同一 ID 和完全相同参数在当前面板最近 100 条记录内只执行一次；刷新面板会清空记录，不能用新 ID 盲目重发结果未知的动作。

`activeUnit` 直接给出当前可见行动者的 ID、格子索引和坐标。`map.cells` 每格提供 `unitIds`、`acting`、`selected`、`inspected`，只包含玩家可见的单位。`selected` 是选中的我方单位所在格，`inspected` 是正在查看的格子。原 `battle_observe` 也提供行动者位置及格子控件的占位/高亮信息。

## 一次准备和固定预览

向 `battle_plan` 提交完整配置：

```json
{
  "stateId":"最近返回的状态ID",
  "requestId":"plan-1",
  "deployment":[{"unitId":"档案ID-1","side":"ally"},{"unitId":"档案ID-2","side":"enemy"}],
  "setup":{"mode":"small","field":"forest","lighting":"day","objectiveMode":"control"},
  "commanders":{"ally":{"ability":"skilled","style":"flanking"},"enemy":{"ability":"regular","style":"cautious"}},
  "recovery":"none"
}
```

`deployment` 是完整参战名单，省略沿用当前名单；每项 `side` 省略沿用档案阵营。可指定参战我方 `protagonistId`、`commanderId`。`recovery` 默认 `none`；`recoverable` 在确认开战时恢复所选单位的可恢复生命/伤兵与士气。

普通随机地图省略 `battlefield` 或其中的 `intent` 即可，不需要空意图。也可提供 `{ "scene":"field" }` 或地标配置；复杂场景格式与单位代号见 `battle_state.preparation` / `battle_help`。错误会标出参数位置，例如 `battlefield.landmarks[0].anchor`、`commanders.ally.style`。

预览返回 `result.previewId`、实际模式、双方人数与卡数、地图尺寸、出生格/会战阵位、任务目标与指挥配置，不修改正式档案。确认时调用 `battle_start`：

```json
{"stateId":"预览后返回的stateId","requestId":"start-1","previewId":"result.previewId"}
```

确认直接使用已生成开局，不重新随机地图、部署或先手。若敌方先行动，开战后仍按本体规则推进到玩家回合。队伍、档案或任务改变后预览失效；确认 `previewId` 时不能附新配置。无需预览时，`battle_start` 接受与 `battle_plan` 相同的参数，一次配置并开战。

## 自动和战后恢复

`battle_auto({action:"start",stateId,requestId})` 启动后立即返回，不等待战斗结束。用 `battle_state` 读取回合、战况和 `automation`。

`battle_auto({action:"pause",requestId})` 不需要 `stateId`，忙碌时也能停止安排后续动作。正在结算的一步先完成保存，待 `busy:false` 后可手动接管。`battle_act` 中的 `auto` 只让当前单位自动行动一次。

`battle_recover({unitIds,stateId,requestId})` 在战斗结束后自动收兵、治疗指定档案，并默认重新加入参战；`deploy:false` 仅恢复。储存器也有“战后恢复”按钮。编辑濒死英雄到正生命时会解除濒死，恢复后可再次参战。

恢复只治疗可恢复生命或伤兵，不复活阵亡/解散档案，也不补回部队永久伤亡。进行中的战斗使用战内治疗/复苏规则。

## 隔离试战

向 `battle_sandbox` 提交一条调用即可生成测试队伍并开战：

```json
{"action":"start","requestId":"sandbox-1"}
```

默认生成双方各一名剑士和射手。可提供 `participants`（姓名、阵营、规模、等级、武器类型和部队人数）、`setup`、`commanders`、`battlefield`；默认非致命。

开启后游戏工具操作隔离试战，返回 `environment:"sandbox"`。原界面工具仍操作正式面板。试战模块没有正式档案/库存/经验/聊天的写入入口。

- `action:"restart"` 与新 `requestId`：恢复完整初始状态和同一地图、部署、先手，不带入上局战损或消耗。
- `action:"reports"`：列出独立保存的最近 20 场试战战报；加 `reportId` 返回逐轮事件。
- `action:"close"` 与新 `requestId`：保留战报并返回正式游戏。

战报和上次完整开局单独保存在当前浏览器中，正式存档不受影响。刷新面板后不会自动续战，可用 `restart` 再开；更换设备不会自动同步这些本地试战记录。

## 更新

更新战斗插件的 `test` 分支，同时在 VPS 更新 MCP 服务并重建容器：

```bash
git pull --ff-only
docker compose up -d --build
```

服务重启后重新连接手机面板，让 MCP 客户端重新发现工具。仍只有 8 个工具表示服务端尚未更新；提示面板不支持游戏接口表示战斗插件尚未更新。
