'use strict';
// 整组变更预演/确认 API 的端到端测试：自动以临时 SQLite 文件启动服务，
// 覆盖——预演不改正式数据、差异对比、整组合法（单条暂时冲突）、
// 未知事件/重复更正/设备不存在/清洗缺时间/时间线非法的明确拒绝、
// 业务版本过期拒绝、内容不一致拒绝、未知版本拒绝、重复应用拒绝。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 3199;
const BASE = `http://localhost:${PORT}`;
const tmpDb = path.join(os.tmpdir(), `changeset-test-${process.pid}.db`);

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); }
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function request(method, urlPath, body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${urlPath}`, {
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        : {}
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(proc, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await request('GET', '/api/state');
      if (r.status === 200) return r.json;
    } catch { /* 服务尚未起来 */ }
    if (proc.exitCode !== null) throw new Error('服务提前退出');
    await sleep(100);
  }
  throw new Error('服务启动超时');
}

(async () => {
  fs.rmSync(tmpDb, { force: true });
  const proc = spawn(process.execPath, ['server/server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: tmpDb, SEED_DEMO: 'true' },
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    const state0 = await waitReady(proc);
    const ev = {};
    state0.events.forEach((e) => { ev[`${e.type}@${e.event_time}`] = e.id; });

    // ---- 1. 预演：把 09:00 清洗提前到 07:30（BATCH-001 之前） ----
    console.log('1) 预演移动清洗事件，返回前后差异且不动正式数据');
    const moveClean = { corrections: [{ event_id: ev['CLEAN@2026-09-30T09:00'], event_time: '2026-09-30T07:30' }] };
    let r = await request('POST', '/api/change-sets/preview', moveClean);
    assert(r.status === 200 && r.json.valid === true, '预演 HTTP 200 valid=true');
    assert(typeof r.json.version_token === 'string' && r.json.version_token.length === 48,
      '返回预演版本 version_token');
    assert(r.json.revision === 0, '预演基于业务版本 0');
    const codes = Object.fromEntries(r.json.diff.batch_changes.map((b) => [b.batch_code, b]));
    assert(codes['BATCH-002'] && codes['BATCH-002'].added.includes('含麸质的谷物'),
      'BATCH-002 将新增“含麸质的谷物”（设备残留提前未清）');
    const inv = r.json.diff.will_invalidate;
    assert(inv.length === 1 && inv[0].batch_code === 'BATCH-003'
      && inv[0].added.includes('含麸质的谷物'), 'BATCH-003 的放行被预告失效并给原因');

    const stateAfterPreview = (await request('GET', '/api/state')).json;
    assert(stateAfterPreview.revision === 0, '预演后正式业务版本仍为 0');
    assert(stateAfterPreview.events.find((e) => e.id === ev['CLEAN@2026-09-30T09:00']).event_time
      === '2026-09-30T09:00', '正式事件时间未被预演改动');
    assert(stateAfterPreview.batches.find((b) => b.code === 'BATCH-003').releases[0].status
      === 'ACTIVE', '正式放行仍为 ACTIVE');

    // ---- 2. 单条更正暂时冲突，整组最终合法 ----
    console.log('2) 单条更正暂时冲突，整组合并后合法');
    const single = { corrections: [{ event_id: 3, event_time: '2026-09-30T11:00' }] };
    r = await request('POST', '/api/change-sets/preview', single);
    assert(r.status === 400, '仅移动事件3 到 11:00 单独看非法（与事件4冲突/引用同时刻）');
    assert((r.json.validation_errors || []).some((m) => m.includes('时间冲突')),
      '失败原因包含设备时间冲突');
    assert((r.json.validation_errors || r.json.details || []).some((m) => m.includes('未来或同时刻')),
      '失败原因包含引用未来/同时刻批次');

    const group = { corrections: [
      { event_id: 3, event_time: '2026-09-30T11:00' },
      { event_id: 4, event_time: '2026-09-30T12:00' }
    ] };
    r = await request('POST', '/api/change-sets/preview', group);
    assert(r.status === 200 && r.json.valid === true,
      '同一组里事件4 同时移到 12:00，整组时间线合法，预演成功');
    const tl = r.json.timeline_after;
    assert(tl.find((e) => e.id === 3).event_time === '2026-09-30T11:00'
      && tl.find((e) => e.id === 3).corrected === true, '时间线标注被更正事件');

    // ---- 3. 拟插入清洗事件 ----
    console.log('3) 更正 + 拟插入清洗事件混合提交');
    // 把 FRYER-B 的 13:00 清洗移到 16:00：BATCH-005 会经残留获得花生等；
    // 再在 12:30 插入一次清洗：BATCH-005 前残留已清空，结果不变。
    const withInsert = {
      corrections: [{ event_id: 6, event_time: '2026-09-30T16:00' }],
      insert_cleans: [{ event_time: '2026-09-30T12:30', equipment_id: 2,
        note: '预演插入的换线清洗', client_ref: 'clean-x' }]
    };
    r = await request('POST', '/api/change-sets/preview', withInsert);
    assert(r.status === 200 && r.json.valid, '含插入清洗的整组预演成功');
    assert(r.json.counts.insert_cleans === 1 && r.json.counts.corrections === 1,
      '计数含 1 条更正、1 条插入');
    const b5 = r.json.after.batches.find((b) => b.code === 'BATCH-005');
    assert(JSON.stringify(b5.allergens) === '[]',
      '插入的 12:30 清洗使 BATCH-005 保持无过敏原（否则会经残留获得花生等）');
    const fbRes = r.json.diff.residue_changes.find((x) => x.equipment_id === 2);
    assert(fbRes && fbRes.after_last_cleaned_at === '2026-09-30T16:00'
      && JSON.stringify(fbRes.after_allergens) === '[]',
      '设备残留差异反映最后清洗时间变化且残留为空');
    const ins = r.json.inserted_cleans[0];
    assert(ins.client_ref === 'clean-x' && ins.event_time === '2026-09-30T12:30',
      '插入清洗回传 client_ref');

    // 对照组：只移走清洗、不插入 -> BATCH-005 获得残留过敏原
    r = await request('POST', '/api/change-sets/preview',
      { corrections: [{ event_id: 6, event_time: '2026-09-30T16:00' }] });
    const b5dirty = r.json.after.batches.find((b) => b.code === 'BATCH-005');
    assert(b5dirty.allergens.includes('花生'),
      '对照组：不插入清洗时 BATCH-005 经残留获得花生（验证插入清洗确有作用）');

    // ---- 4. 明确拒绝：未知事件 / 重复更正 / 设备不存在 / 清洗缺时间 ----
    console.log('4) 非法请求的明确拒绝（预演失败显示原因）');
    r = await request('POST', '/api/change-sets/preview',
      { corrections: [{ event_id: 9999, event_time: '2026-09-30T07:00' }] });
    assert(r.status === 400 && (r.json.details || []).some((m) => m.includes('未知事件')),
      '未知事件被拒绝并说明 event_id');

    r = await request('POST', '/api/change-sets/preview', { corrections: [
      { event_id: 1, note: 'a' }, { event_id: 1, note: 'b' }
    ] });
    assert(r.status === 400 && (r.json.details || []).some((m) => m.includes('重复更正')),
      '重复更正同一事件被拒绝');

    r = await request('POST', '/api/change-sets/preview',
      { corrections: [{ event_id: 1, equipment_id: 999 }] });
    assert(r.status === 400 && (r.json.details || []).some((m) => m.includes('设备不存在')),
      '更正引用不存在设备被拒绝');

    r = await request('POST', '/api/change-sets/preview',
      { insert_cleans: [{ equipment_id: 1, note: '缺时间' }] });
    assert(r.status === 400 && (r.json.details || []).some((m) => m.includes('清洗事件缺少时间')),
      '插入清洗缺少时间被拒绝');

    r = await request('POST', '/api/change-sets/preview',
      { insert_cleans: [{ event_time: '2026-09-30T12:00', equipment_id: 88 }] });
    assert(r.status === 400 && (r.json.details || []).some((m) => m.includes('设备不存在')),
      '插入清洗引用不存在设备被拒绝');

    r = await request('POST', '/api/change-sets/preview',
      { corrections: [{ event_id: 6, batch_code: 'X' }] });
    assert(r.status === 400 && (r.json.details || []).some((m) => m.includes('清洗事件不能')),
      '清洗事件携带批次字段被拒绝');

    r = await request('POST', '/api/change-sets/preview', { corrections: [] });
    assert(r.status === 400 && /变更组为空/.test(r.json.error), '空变更组被拒绝');

    // 整组时间线非法：插入与既有事件同时刻同设备的清洗
    r = await request('POST', '/api/change-sets/preview',
      { insert_cleans: [{ event_time: '2026-09-30T08:00', equipment_id: 1 }] });
    assert(r.status === 400 && (r.json.validation_errors || []).some((m) => m.includes('时间冲突')),
      '整组时间线时间冲突：预演失败并给出校验原因');

    // 整组制造引用未来批次：让 BATCH-002 改到 13:00（晚于引用它的 BATCH-003 11:00）
    r = await request('POST', '/api/change-sets/preview',
      { corrections: [{ event_id: 3, event_time: '2026-09-30T13:00' }] });
    assert(r.status === 400 && (r.json.validation_errors || []).some((m) => m.includes('未来或同时刻')),
      '引用未来批次：预演失败并给出原因');

    // 整组制造批次重复产出：把 BATCH-005 改成编码 BATCH-004（与既有批次撞码属静态拒绝）
    r = await request('POST', '/api/change-sets/preview',
      { corrections: [{ event_id: 7, batch_code: 'BATCH-004' }] });
    assert(r.status === 400 && (r.json.details || []).some((m) => m.includes('BATCH-004')),
      '批次编码撞其他批次：静态校验拒绝');

    // 整组制造引用环：事件4 引用批次3（自身）的场景由整组校验拦截
    const b3 = state0.batches.find((b) => b.code === 'BATCH-003').id;
    r = await request('POST', '/api/change-sets/preview',
      { corrections: [{ event_id: 4, ref_batch_ids: [b3] }] });
    assert(r.status === 400 && (r.json.validation_errors || []).some((m) => m.includes('不能引用自身') || m.includes('循环')),
      '自引用/引用环：整组校验拒绝');

    // 预演失败不产生可用版本（返回中无 token）
    const bad = await request('POST', '/api/change-sets/preview',
      { insert_cleans: [{ equipment_id: 1 }] });
    assert(bad.status === 400 && !bad.json.version_token,
      '预演失败（清洗缺时间）不返回版本号');

    // ---- 5. 确认应用：版本/内容校验、过期、重复 ----
    console.log('5) 确认应用的并发与一致性约束');
    r = await request('POST', '/api/change-sets/preview', moveClean);
    const token = r.json.version_token;

    // 未知版本
    r = await request('POST', '/api/change-sets/apply',
      { version_token: 'deadbeef', corrections: moveClean.corrections });
    assert(r.status === 404 && r.json.error_code === 'VERSION_UNKNOWN', '未知预演版本 404');

    // 内容不一致
    r = await request('POST', '/api/change-sets/apply', {
      version_token: token,
      corrections: [{ event_id: ev['CLEAN@2026-09-30T09:00'], event_time: '2026-09-30T07:00' }]
    });
    assert(r.status === 400 && r.json.error_code === 'PAYLOAD_MISMATCH',
      '确认内容与预演不一致被拒绝（PAYLOAD_MISMATCH）');

    // 缺少 version_token
    r = await request('POST', '/api/change-sets/apply', { corrections: moveClean.corrections });
    assert(r.status === 404, '缺少 version_token 被拒绝');

    // 预演后发生正式写入 → 版本过期
    const newEvent = {
      event_time: '2026-09-30T17:00', type: 'CLEAN', equipment_id: 1, note: '正式插入'
    };
    r = await request('POST', '/api/events', newEvent);
    assert(r.status === 200 && r.json.revision === 1, '正式写入事件成功并推进业务版本到 1');

    r = await request('POST', '/api/change-sets/apply', {
      version_token: token, corrections: moveClean.corrections
    });
    assert(r.status === 409 && r.json.error_code === 'REVISION_STALE',
      '预演后有正式写入：应用被拒绝（409 REVISION_STALE）');
    const stateStale = (await request('GET', '/api/state')).json;
    assert(stateStale.revision === 1
      && stateStale.events.find((e) => e.id === ev['CLEAN@2026-09-30T09:00']).event_time
        === '2026-09-30T09:00'
      && stateStale.batches.find((b) => b.code === 'BATCH-003').releases[0].status === 'ACTIVE',
      '过期拒绝后原正式状态不变（时间未改、放行仍 ACTIVE）');

    // 重新预演（含新事件的正式状态）→ 相同业务语义 → 成功应用
    r = await request('POST', '/api/change-sets/preview', moveClean);
    assert(r.status === 200 && r.json.revision === 1, '重新预演基于当前业务版本 1');
    const token2 = r.json.version_token;
    r = await request('POST', '/api/change-sets/apply', {
      version_token: token2, corrections: moveClean.corrections
    });
    assert(r.status === 200 && r.json.applied === true && r.json.revision === 2,
      '携新版本与相同内容应用成功，业务版本推进到 2');
    assert(r.json.invalidated.some((x) => x.batch_code === 'BATCH-003'),
      '应用返回实际失效的放行记录');

    // 重复应用
    r = await request('POST', '/api/change-sets/apply', {
      version_token: token2, corrections: moveClean.corrections
    });
    assert(r.status === 409 && r.json.error_code === 'VERSION_APPLIED', '重复应用已用版本 409');

    // 正式状态核对
    const finalState = (await request('GET', '/api/state')).json;
    assert(finalState.revision === 2
      && finalState.events.find((e) => e.id === ev['CLEAN@2026-09-30T09:00']).event_time
        === '2026-09-30T07:30', '应用后正式事件已改到 07:30，版本为 2');
    assert(finalState.batches.find((b) => b.code === 'BATCH-003').releases[0].status
      === 'INVALIDATED', '应用后 BATCH-003 放行正式失效');

    // ---- 6. 加工事件整组更正：批次编码/原料/引用/设备/备注 ----
    console.log('6) 加工事件更正（原料/引用/批次编码/设备/备注）');
    r = await request('POST', '/api/change-sets/preview', { corrections: [{
      event_id: 7, batch_code: 'BATCH-005X', note: '更正备注'
    }] });
    // 仅改批次编码与备注
    assert(r.status === 200, '加工事件批次编码/备注更正可预演');
    // 应用一次加工更正（追加全蛋液原料到 BATCH-005）
    const matEgg = state0.materials.find((m) => m.code === 'EGG-01').id;
    const procChange = { corrections: [{ event_id: 7, material_ids: [matEgg] }] };
    r = await request('POST', '/api/change-sets/preview', procChange);
    const b5after = r.json.after.batches.find((b) => b.code === 'BATCH-005');
    assert(b5after.allergens.includes('蛋'), 'BATCH-005 加入全蛋液后将含“蛋”');
    r = await request('POST', '/api/change-sets/apply', {
      version_token: r.json.version_token, ...procChange
    });
    assert(r.status === 200, '加工事件更正应用成功');
    const st = (await request('GET', '/api/state')).json;
    assert(st.batches.find((b) => b.code === 'BATCH-005').allergens.includes('蛋'),
      '正式推导结果已含“蛋”');

    // ---- 7. 原料过敏原修正等既有写接口语义不变且推进版本 ----
    console.log('7) 既有单条接口语义保持');
    const wheat = state0.materials.find((m) => m.code === 'WHEAT-01');
    r = await request('PUT', `/api/materials/${wheat.id}`,
      { code: 'WHEAT-01', name: '小麦面粉', allergens: ['含麸质的谷物', '新增标签X'] });
    assert(r.status === 200 && Array.isArray(r.json.invalidated), '原料更正接口语义不变（返回 invalidated）');
    r = await request('POST', '/api/change-sets/preview', moveClean);
    assert(r.json.revision >= 3, '正式重算后新预演基于更新后的业务版本');

  } finally {
    proc.kill('SIGTERM');
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(`${tmpDb}-shm`, { force: true });
    fs.rmSync(`${tmpDb}-wal`, { force: true });
  }

  if (failures) {
    console.error(`\n${failures} 项断言失败`);
    process.exit(1);
  }
  console.log('\n全部通过');
})().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
