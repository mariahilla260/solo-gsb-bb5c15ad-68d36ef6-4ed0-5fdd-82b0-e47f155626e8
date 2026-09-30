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

### 整组变更：预演 → 确认（业务版本乐观锁）

车间调整加工顺序时，可在一次请求中提交：

- `corrections`：对**多条既有加工或清洗事件**的更正（只传需要改的字段，未传字段保持原值）；
- `insert_cleans`：**拟插入的清洗事件**（必须带时间与设备）。

接口按**整组变更后的时间线**统一校验批次引用先后、引用环、设备时间冲突与批次唯一产出——
因此“单条更正单独看暂时冲突、与同组其他更正合并后最终合法”的情形仍可预演。

1. `POST /api/change-sets/preview`：在**内存影子库**上应用整组变更并全量校验/重算，
   返回应用前后差异——
   - `diff.batch_changes`：每个批次过敏原的前后集合（`added`/`removed`）；
   - `diff.residue_changes`：每台设备残留及“最后已核实清洗时间”的前后差异；
   - `diff.will_invalidate`：**将失效的放行记录**（附新增/移除过敏原与失效原因）；
   - `before`/`after`：变更前后每批过敏原与设备残留完整快照；
   - `timeline_after`：变更后整组时间线（`corrected`/`inserted` 标记）。

   预演**不改动**正式事件、推导结果与放行状态，响应携带业务版本号 `revision`
   与一次性预演版本 `version_token`。
2. `POST /api/change-sets/apply`：确认应用，**必须**携带同一 `version_token`
   及与预演**完全相同**的 `corrections` / `insert_cleans`。服务端在**一次事务**中
   重新校验并整体落库，返回实际失效的放行记录与新业务版本。

业务版本（revision，单调递增，也在 `GET /api/state` 中返回）规则：

- 任何**影响推导/放行结果的正式写入**（新增/更正/删除事件、原料过敏原修改、
  设备更名、放行登记/删除、整组应用）都会在其事务内推进 revision；
- 预演**不**推进 revision；预演后一旦发生上述正式写入，此前所有预演版本立即过期，
  确认返回 `409 REVISION_STALE` 并保持原状态不变，需重新预演；
- 同一预演版本只能应用一次（重复应用返回 `409 VERSION_APPLIED`）；
- 确认内容与预演不一致返回 `400 PAYLOAD_MISMATCH`；未知版本返回 `404 VERSION_UNKNOWN`。

明确拒绝的非法输入（HTTP 400，`details` 给出逐条原因）：未知事件、重复更正同一事件、
设备不存在、插入的清洗事件缺少时间；整组时间线不合法时返回 `validation_errors`
（引用未来批次/引用环/设备时间冲突/批次唯一产出），预演失败不落任何版本。

#### 调用示例（curl）

预演：把 09:00 的已核实清洗提前到 07:30，并在 FRYER-B 的 12:30 插入一次清洗：

```bash
curl -s -X POST http://localhost:3000/api/change-sets/preview \
  -H 'Content-Type: application/json' -d '{
    "corrections": [
      { "event_id": 2, "event_time": "2026-09-30T07:30" },
      { "event_id": 4, "note": "整组更正：备注调整，字段未传则保持原值" }
    ],
    "insert_cleans": [
      { "event_time": "2026-09-30T12:30", "equipment_id": 2,
        "note": "换线前已核实清洗", "client_ref": "clean-12-30" }
    ]
  }'
```

响应（节选）：

```json
{
  "version_token": "35a45a23…", "revision": 3, "valid": true,
  "counts": { "corrections": 2, "insert_cleans": 1,
              "batch_changes": 2, "residue_changes": 1, "will_invalidate": 1 },
  "diff": {
    "batch_changes": [
      { "batch_code": "BATCH-002", "added": ["含麸质的谷物"], "removed": [], "...": "…" }
    ],
    "residue_changes": [
      { "equipment_code": "FRYER-B",
        "before_last_cleaned_at": "2026-09-30T13:00",
        "after_last_cleaned_at": "2026-09-30T16:00" }
    ],
    "will_invalidate": [
      { "batch_code": "BATCH-003", "added": ["含麸质的谷物"],
        "reason": "预演重算后过敏原集合与放行登记时不同（新增：含麸质的谷物）" }
    ]
  },
  "inserted_cleans": [
    { "client_ref": "clean-12-30", "event_time": "2026-09-30T12:30",
      "equipment_code": "FRYER-B", "equipment_id": 2 }
  ]
}
```

确认（内容与预演逐字段一致）：

```bash
curl -s -X POST http://localhost:3000/api/change-sets/apply \
  -H 'Content-Type: application/json' -d '{
    "version_token": "35a45a23…",
    "corrections": [
      { "event_id": 2, "event_time": "2026-09-30T07:30" },
      { "event_id": 4, "note": "整组更正：备注调整，字段未传则保持原值" }
    ],
    "insert_cleans": [
      { "event_time": "2026-09-30T12:30", "equipment_id": 2,
        "note": "换线前已核实清洗", "client_ref": "clean-12-30" }
    ]
  }'
```

字段说明：加工事件的更正可选 `event_time` / `equipment_id` / `note` / `batch_code` /
`material_ids`（**全量替换**原料列表）/ `ref_batch_ids`（全量替换引用批次列表）；
清洗事件的更正只能改 `event_time` / `equipment_id` / `note`。`client_ref` 是调用方
给拟插入清洗起的可选引用号，确认响应会带回其正式 `event_id`（不传时按提交顺序编号）。

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
  db.js          # SQLite 连接、表结构与业务版本（revision）
  validation.js  # 全量校验（未来批次/循环/时间冲突/重复产出）
  recompute.js   # 推导引擎：回放事件、批次并集、设备残留、放行核对
  changesets.js  # 整组变更：解析/规范化哈希、内存影子库、前后快照差异
  seed.js        # 首次启动演示数据
  server.js      # Express API 与静态页面（含 /api/change-sets 预演/确认）
public/
  index.html  styles.css  app.js
scripts/
  test-cycle.js       # 引用链/引用环校验单测
  test-changesets.js  # 整组变更预演/确认 HTTP API 端到端测试
Dockerfile  docker-compose.yml
```

## 自动化测试

```bash
npm test   # 先跑引用校验单测，再起临时服务跑整组变更 API 的端到端测试
```
