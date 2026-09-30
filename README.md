# 食品加工换线 · 过敏原追踪与放行系统

本地运行的食品加工过敏原追溯网页：录入**原料过敏原、设备、按时间排序的加工事件与已核实清洗事件**，
系统按时间顺序推导每个产出批次的过敏原集合及来源路径，管理设备残留，并支持按**当时推导结果**登记批次放行。

- 后端：Node.js + Express
- 数据库：SQLite（[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)，数据文件本地保存）
- 前端：浏览器单页应用（原生 HTML/CSS/JS，无需构建）

## 功能与规则

### 推导规则

- **批次产出过敏原** = 全部原料输入过敏原 ∪ 引用的此前批次产出 ∪ **设备当前残留**，并集计算。
- **设备残留更新**：每次加工后，该设备残留更新为本次产出的过敏原集合；新鲜来源路径会追加“设备残留”标记，
  已在残留中的路径原样保留（可追溯残留自哪次加工带入）。
- **已核实清洗**（CLEAN 事件）才会清空对应设备的残留；普通加工不会清空。
- 每个批次的每个过敏原都展示**来源路径链**，例如：
  `原料:全脂奶粉(MILK-01) → 批次引用:BATCH-002 → 设备残留:LINE-A`
- 更正/删除早期事件后，系统**全量重算**所有受影响的后续批次与设备残留。

### 放行

- 放行以登记时刻的过敏原集合作为**快照**保存。
- 早期事件更正后重算：某条放行登记时的集合与新结果**不同**，该放行自动置为**已失效**，
  页面红色标注并给出具体原因（新增了哪些过敏原 / 移除了哪些过敏原）；失效为终态，需重新登记放行。
- 集合相同则放行保持有效。

### 提交约束（整次提交事务化，违反任意一条则整单回滚拒绝）

- 加工只能引用**产出时间严格更早**的批次——引用未来批次被拒绝。
- 批次引用关系**形成循环**被拒绝。
- **同一设备同一时刻**存在多条事件（时间冲突）被拒绝。
- 同一批次不能被两次加工产出。

### 换线整组预演与确认应用（本轮新增）

车间调整加工顺序时，可**一次提交多条既有事件的更正（PROCESS/CLEAN）与拟插入的清洗事件**：

- `POST /api/replan/preview` 在**内存影子库**上应用整组变更，按整组变更后的时间线
  全量校验（引用先后、引用环、设备时间冲突、批次唯一产出）并重算，返回应用前后
  **每批过敏原、设备残留、将失效的放行记录**差异；**不修改正式事件、推导结果或放行状态**。
- **单条更正单独看暂时冲突、但整组最终合法时仍可预演**（例如交换两个事件的时间）。
- 预演返回业务版本 `version`（签名令牌，30 分钟有效；服务重启后旧版本作废）。
- `POST /api/replan/apply` 确认应用：**必须携带预演版本及与预演完全相同的 changes**，
  在**一次事务**中重新校验版本、重新做全量校验并重算落库。
- **预演后任何会影响这些结果的正式写入**（新增/更正/删除事件、改原料过敏原、登记/删除放行等）
  **均使该版本过期**：应用返回 `409 VERSION_EXPIRED` 且**原状态不变**，需重新预演。
- 以下情况在预演阶段即明确拒绝（HTTP 400，`details` 给出逐条中文原因，预演失败可见原因）：
  未知事件、同一事件被重复更正、设备不存在、拟插入的清洗事件缺少时间、
  整组后时间线非法（未来引用 / 引用环 / 时间冲突 / 批次重复产出）等。

> 既有单条事件接口（`POST/PUT/DELETE /api/events/...`）与放行接口（`/api/releases`）
> 的语义完全保持不变；新接口只做“整组预演 + 确认应用”。

#### 变更项格式（`changes` 数组，顺序无关）

更正既有事件（字段与单条 `PUT /api/events/:id` 相同，必须带 `type`；加工事件为全量覆盖输入/引用）：

```json
{
  "op": "update",
  "event_id": 1,
  "type": "PROCESS",
  "event_time": "2026-09-30T09:00",
  "equipment_id": 1,
  "note": "早班面团（改到清洗后）",
  "batch_code": "BATCH-001",
  "material_ids": [1, 7],
  "ref_batch_ids": []
}
```

拟插入的清洗事件（`client_key` 可选，便于多条时对应预演返回的新事件 id）：

```json
{ "op": "insert_clean", "client_key": "mid-wash", "event_time": "2026-09-30T09:30",
  "equipment_id": 1, "note": "换线中间追加一次已核实清洗" }
```

#### 调用示例（curl，基于演示数据）

```bash
# 1) 预演：交换 LINE-A 上 BATCH-001(08:00) 与清洗(09:00) 的时间
curl -s -X POST http://localhost:3000/api/replan/preview \
  -H 'Content-Type: application/json' -d '{
    "changes": [
      {"op":"update","event_id":1,"type":"PROCESS","event_time":"2026-09-30T09:00",
       "equipment_id":1,"note":"早班面团","batch_code":"BATCH-001",
       "material_ids":[1,7],"ref_batch_ids":[]},
      {"op":"update","event_id":2,"type":"CLEAN","event_time":"2026-09-30T08:00",
       "equipment_id":1,"note":"换线前已核实清洗"}
    ]
  }'
# -> { ok:true, phase:"PREVIEW", version:"<业务版本令牌>", business_version:"...",
#      changes:[...规范化回显...], inserted_clean_events:[],
#      diff:{ summary:{ batches_changed, equipment_residue_changed,
#                       releases_will_invalidate, releases_changed },
#             batches:[{batch_id,code,produced_at,
#                       before_allergens,after_allergens,added,removed}],
#             equipment_residue:[{equipment_id,equipment_code,
#                       before_allergens,after_allergens,added,removed,
#                       before_last_cleaned_at,after_last_cleaned_at}],
#             releases:[{release_id,batch_code,before_status,after_status:"INVALIDATED",
#                       after_invalid_reason,...}] } }

# 2) 确认应用：原样回传 version 与同一份 changes（事务内重新校验+重算）
curl -s -X POST http://localhost:3000/api/replan/apply \
  -H 'Content-Type: application/json' -d '{
    "version": "<上一步返回的 version>",
    "changes": [ ...与预演完全相同的内容... ]
  }'
# -> { ok:true, phase:"APPLIED", applied_version, business_version,
#      inserted_clean_events:[{client_key,event_id}], invalidated:[...],
#      diff:{ ...与预演同结构的实际落库差异... } }
```

预演失败示例（整组后时间线非法，HTTP 400）：

```json
{ "error": "整组变更应用后的时间线校验未通过",
  "code": "REPLAN_REJECTED",
  "details": ["事件 #3（2026-09-30T11:30）引用了未来或同时刻批次 #4（产出时间 2026-09-30T11:00），不允许引用未来批次"] }
```

| 场景 | HTTP | `code` |
| --- | --- | --- |
| 请求体/变更内容问题（非数组、缺时间、未知事件、重复更正、设备不存在…） | 400 | `INVALID_REQUEST` / `REPLAN_REJECTED` |
| 整组后时间线校验失败（未来引用/环/时间冲突/批次重复产出） | 400 | `REPLAN_REJECTED` |
| 版本签名损坏或格式非法 | 400 | `VERSION_INVALID` |
| apply 的 changes 与预演不一致 | 409 | `CHANGES_MISMATCH` |
| 预演后正式数据已变更导致版本过期（含重复应用同一版本、版本过期） | 409 | `VERSION_EXPIRED` |

## 一键启动（Docker，从空环境开始）

要求安装 Docker 与 Docker Compose（v2）。在项目目录执行：

```bash
docker compose up --build -d
```

该命令会依次完成：构建镜像 → 安装 npm 依赖 → 初始化 SQLite 库与表结构 →
首次启动写入演示数据 → 启动 Web 服务。

查看日志 / 停止：

```bash
docker compose logs -f
docker compose down            # 停止（保留数据卷）
docker compose down -v         # 停止并删除本地数据（恢复空白/演示初始状态）
```

## 本地直接运行（无 Docker）

要求 Node.js 20+：

```bash
npm install
npm start                      # 自动创建 data/allergen.db、建表并写入演示数据
```

可选单独初始化数据库：`npm run init-db`。

测试（不依赖外部框架，直接在临时库上跑）：

```bash
npm test            # 校验引擎：无环/成环用例
npm run test:replan # 启动临时端口的真实服务，端到端验证整组预演/确认应用全部语义
```

## 访问地址与端口

启动后浏览器打开：

- **http://localhost:3000**

端口可通过环境变量 `PORT` 修改；使用 Compose 时可在宿主机设置
`PORT=8080 docker compose up --build`（容器内仍监听 3000，宿主机映射变为 8080，
届时访问 http://localhost:8080 ）。

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Web 服务监听端口（容器内） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `data/allergen.db`（本地）/ `/app/data/allergen.db`（容器） | SQLite 数据文件路径 |
| `SEED_DEMO` | `true` | 首次启动（库为空）时是否写入演示数据；`false` 则得到空白库 |

数据保存在 SQLite 文件中：本地运行位于项目 `data/` 目录；Docker 运行位于
名为 `allergen-data` 的数据卷（容器内 `/app/data`），重启与重建镜像均不丢失。

## 页面说明

- **批次与放行**：设备当前残留（含来源路径）、每个批次的推导过敏原与逐条来源路径、
  放行记录（绿色“放行有效”/红色“已失效”及失效原因），可在此登记放行。
- **事件时间线**：按时间排列全部加工/清洗事件，展示输入、引用批次与推导结果；
  “更正”可修改早期事件，保存时整单校验并触发重算。
- **原料与设备**：维护原料档案（编码、名称、过敏原标签）与设备档案。

## 快速体验失效场景

1. 打开“批次与放行”，可以看到演示数据中 `BATCH-003` 已登记放行（放行有效）。
2. 到“事件时间线”，找到最早的 `BATCH-001`（08:00 面团），点击“更正”并加入原料 **全蛋液(EGG-01)**，提交。
3. 由于设备残留沿时间线传播并经 `BATCH-002` 被 `BATCH-003` 引用，重算后 `BATCH-003`
   新增过敏原“蛋”，原放行记录自动变为**已失效**并标明原因，可重新登记放行。

## 目录结构

```
server/
  db.js          # SQLite 连接与表结构（导出 initSchema 供内存影子库复用）
  validation.js  # 全量校验（未来批次/循环/时间冲突/重复产出）
  recompute.js   # 推导引擎：回放事件、批次并集、设备残留、放行核对
  replan.js      # 整组换线：影子库预演、业务版本签名令牌、事务确认应用
  seed.js        # 首次启动演示数据
  server.js      # Express API 与静态页面（含 /api/replan/preview|apply）
public/
  index.html  styles.css  app.js
scripts/
  test-cycle.js    # 校验引擎单测
  test-replan.js   # 整组预演/确认应用端到端测试
Dockerfile  docker-compose.yml
```
