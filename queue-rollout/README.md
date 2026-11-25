# queue-rollout — 队列处理服务的分波配置发布/回退控制器

对一组本地队列处理服务做**分批（波次）配置更新**。每台服务的配置决定它为各条队列提供的处理容量、以及它占用的共享额度。控制器在发布前判断是否存在满足预算的切换路线；发布期间保证每条队列的保底容量和共享额度上限在**每一个实际生效的组合**下都成立；支持暂停/继续/回退；控制端或服务进程重启后能接手同一次发布；回执丢失的切换会被标记并对账。

纯 Node.js 内置模块实现（零运行时依赖），状态持久化到本地 JSONL 日志文件。

## 目录

- [构建与启动](#构建与启动)
- [操作说明（CLI / HTTP API）](#操作说明)
- [测试](#测试)
- [语义与设计](#语义与设计)
- [文件结构](#文件结构)

## 构建与启动

```bash
npm install        # 仅 dev 依赖（typescript + @types/node）
npm run build      # 编译到 dist/
```

**1. 启动服务夹具**（模拟 4 台队列处理服务，端口 7101–7104，各自持久化自己的配置）：

```bash
node dist/src/fixture.js --config examples/services.json --state-dir /tmp/qr-fx
```

**2. 启动控制器**（端口 8300，状态写入数据目录）：

```bash
node dist/src/server.js --port 8300 --data-dir /tmp/qr-ctrl
```

可用环境变量调整超时：`SWITCH_TIMEOUT_MS`（默认 1500，切换回执超时）、`RECONCILE_DELAY_MS`（默认 300，对账重试间隔）、`RECONCILE_ATTEMPTS`（默认 5）。

**3. 创建发布并做可行性检查**：

```bash
node dist/src/cli.js create examples/rollout-spec.json
```

输出示例：

```
created rollout rmwwm5sg3: FEASIBLE (rollback to current config verified within rollback budget)
  wave 1: ingest-1 -> v2t
  wave 2: worker-1 -> v2,  ingest-2 -> v2
  wave 3: worker-2 -> v2,  ingest-1 -> v2
```

若无解，会输出受阻原因（哪台服务、违反哪条队列保底/额度上限、差多少），并保持当前配置不下发任何切换：

```
created rollout rmwwlfo4y: INFEASIBLE — rollout infeasible: no feasible route within 3 waves.
closest reachable combination [...] blocked by: service ingest-1 -> 'v2' violates: queue 'orders'
capacity 11 < minimum 12 | ...
current config kept; nothing will be dispatched.
```

（可以试 `node dist/src/cli.js create examples/rollout-spec-infeasible.json`，该示例把共享额度上限调到 16，任何过渡切换都会超额。）

## 操作说明

```bash
node dist/src/cli.js create <spec.json>   # 创建发布 + 可行性检查（不会自动开始）
node dist/src/cli.js start                # 开始按波执行
node dist/src/cli.js pause                # 暂停：收尾已发出的切换，停止下发新切换
node dist/src/cli.js resume               # 继续（先对账，再从断点继续）
node dist/src/cli.js rollback             # 在回退预算内恢复到本次发布前的配置
node dist/src/cli.js status               # 各服务已核实配置、结果未明的切换、波次进度
node dist/src/cli.js watch                # 轮询直到终态
```

`status` 输出示例：

```
rollout rmwwlf03b  phase=running
  plan: rollout, 3 wave(s), cursor at wave 1 switch 0
  constraints ok: true
    ingest-1     verified=v1       target=v2
  ✓ worker-1     verified=v2t      target=v2
  UNKNOWN-OUTCOME SWITCHES (receipt lost, being resolved):
    ? ingest-2 -> v2  (rmwwlf03b:rollout:w1:s1:a1)
```

控制器地址用 `--controller http://host:port` 或环境变量 `CONTROLLER` 指定（默认 `http://127.0.0.1:8300`）。

### HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活检查 |
| POST | `/rollouts` | 创建发布（body 为发布规格），同步返回可行性、计划或受阻原因 |
| GET | `/rollouts/:id` | 状态：阶段、各服务已核实配置、结果未明的切换、游标、最近事件 |
| POST | `/rollouts/:id/start` | 开始执行（`blocked` 状态返回 409 并给出原因） |
| POST | `/rollouts/:id/pause` | 暂停 |
| POST | `/rollouts/:id/resume` | 继续（含 error 状态恢复） |
| POST | `/rollouts/:id/rollback` | 回退到发布前配置 |
| GET | `/status` | 当前发布的快捷状态 |

### 发布规格（spec）字段

```jsonc
{
  "queues": [{ "name": "orders", "minCapacity": 12 }],   // 各队列保底容量
  "quotaLimit": 18,                                       // 共享额度上限
  "services": [{
    "name": "ingest-1",
    "endpoint": "http://127.0.0.1:7101",
    "target": "v2",                                       // 目标配置
    "configs": [                                          // 配置目录：当前/目标/获准的过渡配置
      { "name": "v1",  "capacities": { "orders": 8, "payments": 1 }, "quota": 4 },
      { "name": "v2t", "capacities": { "orders": 4, "payments": 4 }, "quota": 5 },
      { "name": "v2",  "capacities": { "orders": 1, "payments": 8 }, "quota": 4 }
    ]
  }],
  "budgets": {
    "rollout":  { "waves": 3, "maxPerWave": 2 },   // 发布：最多 3 波、每波最多 2 台
    "rollback": { "waves": 4, "maxPerWave": 2 }    // 回退：独立预算
  }
}
```

## 测试

```bash
npm test
```

一条命令完成编译并运行端到端测试（约 3–10 秒，远低于 80 秒；依赖安装时间另计）。测试启动真实的控制器进程和夹具进程，覆盖：

1. **正常发布**：可行性检查 → 暂停/继续 → 在波数预算内到达目标，每波不超过每波台数上限、每台服务每波最多切一次；
2. **无解受阻**：额度收紧后无可行路线，给出受阻原因，当前配置保持不变，`start` 被拒绝；
3. **波数不足**：报告"至少需要 N 波"；
4. **部分生效后的接手与回退**：第二台服务已生效但回执丢失（结果未明）→ SIGKILL 控制器和服务进程 → 服务重启（配置因持久化而保留）→ 控制器用同一数据目录重启后对账接手、解决未明切换并继续到达目标 → 在回退预算内恢复到发布前配置。

## 语义与设计

### 约束模型

每个**实际生效的组合**（包括一波之内每台服务先后独立生效产生的所有中间组合）必须满足：每条队列 `Σ 各服务提供容量 ≥ 保底容量`，且 `Σ 各服务占用额度 ≤ 额度上限`。规划器只生成满足约束的路线；执行器在每次下发前对已核实状态再做一次约束校验（纵深防御），违反则停发并进入 `error`。

### 波次语义

- 一波是一个**有序**切换序列：每台服务在一波中最多切换一次，波内台数 ≤ 每波上限；波内切换逐个下发、各自独立生效，每个前缀组合都必须合法。
- 发布与回退使用**各自独立**的波数上限和每波台数上限。

### 可行性检查（创建时同步完成）

1. 当前组合、目标组合自身必须合法；
2. 必须存在 `当前 → 目标` 的发布路线，波数 ≤ 发布预算（BFS 求最少波数）；
3. **回退保障**：对路线上的每一个实际生效组合（含波内中间态），都必须存在回到发布前组合的回退路线，且波数 ≤ 回退预算。

任一不满足则 `blocked`，输出受阻原因（最接近目标的可达组合、每台未就位服务切换时违反的具体约束及数值；或"至少需要 N 波"），不下发任何切换。有可行路线时，无故障运行严格按计划执行，必在预算内抵达目标。

### 回退预算的起算点

发起回退后，控制器先**收尾在途切换并对账**（向各服务查询实际配置，解决结果未明的切换），等服务全部可达后才规划回退路线——回退预算从这一刻起算，以后续无故障为前提。

### 崩溃恢复与对账

- 所有决策先写 JSONL 日志（`journal.jsonl`，追加 + fsync）再产生副作用；重启后重放日志重建状态。
- 服务可能**已生效但回执丢失**：切换超时/连接中断后记为"结果未明"（`unknownSwitches`，可在 status 中查到），控制器随后向服务查询实际配置进行对账（`switch_reconciled`），已生效则确认跳过、未生效则有界重试。
- 控制器重启：重放日志 → 对账所有服务 → 按崩溃时阶段接手（`running` 继续执行、`paused` 保持暂停、回退中继续回退）；服务暂时不可达则进入 `error`，恢复后 `resume` 即可。
- 服务进程重启：夹具把配置原子写入各自的 state 文件，重启后保持。

### 服务夹具

`fixture.js` 按 `services.json` 在一台进程内模拟多台服务（每台一个端口）。接口：`GET /config`（上报实际配置）、`POST /config`（幂等切换，先持久化再回执）、`POST /admin/flaky`（注入"生效但丢回执"/丢查询响应）、`POST /admin/delay`（注入时延）、`GET /admin/state`。

## 文件结构

```
src/model.ts        领域模型与约束检查
src/planner.ts      波次路线规划（BFS）+ 回退保障验证 + 受阻原因诊断
src/journal.ts      JSONL 持久化日志（追加 + fsync + 重放）
src/controller.ts   发布状态机、波次执行器、对账与崩溃接手
src/server.ts       控制器 HTTP API
src/cli.ts          运维命令行
src/fixture.ts      本地服务夹具
test/e2e.test.ts    端到端测试（node:test）
examples/           示例夹具定义与发布规格（含一个无解示例）
```
