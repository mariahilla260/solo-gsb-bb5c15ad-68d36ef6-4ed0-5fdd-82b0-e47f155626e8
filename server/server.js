'use strict';
const path = require('path');
const express = require('express');
const { getDb } = require('./db');
const { validateAll } = require('./validation');
const { recompute, sortedJson } = require('./recompute');
const { seedIfEmpty } = require('./seed');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const db = getDb();
if (process.env.SEED_DEMO !== 'false') {
  try {
    if (seedIfEmpty()) console.log('已初始化演示数据（设置 SEED_DEMO=false 可关闭）');
  } catch (err) {
    console.error('演示数据初始化失败：', err.message);
  }
}

// ---------- 读取：整页状态 ----------
app.get('/api/state', (req, res) => {
  const materials = db.prepare(
    'SELECT id, code, name, allergens FROM materials ORDER BY code'
  ).all().map((m) => ({ ...m, allergens: JSON.parse(m.allergens) }));

  const equipment = db.prepare(
    `SELECT e.id, e.code, e.name,
            COALESCE(r.allergens, '[]') AS allergens,
            COALESCE(r.paths_json, '{}') AS paths_json,
            r.last_cleaned_at
       FROM equipment e
       LEFT JOIN equipment_residue r ON r.equipment_id = e.id
      ORDER BY e.code`
  ).all().map((e) => ({
    id: e.id, code: e.code, name: e.name,
    allergens: JSON.parse(e.allergens),
    paths: JSON.parse(e.paths_json),
    last_cleaned_at: e.last_cleaned_at
  }));

  const events = db.prepare(
    `SELECT ev.id, ev.event_time, ev.type, ev.equipment_id, ev.note,
            ev.batch_id, b.code AS batch_code,
            bo.allergens AS out_allergens,
            bo.paths_json AS out_paths
       FROM events ev
       LEFT JOIN batches b ON b.id = ev.batch_id
       LEFT JOIN batch_outputs bo ON bo.batch_id = ev.batch_id
      ORDER BY ev.event_time, ev.id`
  ).all().map((ev) => ({
    id: ev.id,
    event_time: ev.event_time,
    type: ev.type,
    equipment_id: ev.equipment_id,
    note: ev.note,
    batch_id: ev.batch_id,
    batch_code: ev.batch_code,
    out_allergens: ev.out_allergens ? JSON.parse(ev.out_allergens) : [],
    out_paths: ev.out_paths ? JSON.parse(ev.out_paths) : {},
    inputs: db.prepare(
      `SELECT pi.material_id, pi.batch_id AS ref_batch_id,
              m.name AS material_name, m.code AS material_code,
              m.allergens AS material_allergens,
              rb.code AS ref_batch_code
         FROM process_inputs pi
         LEFT JOIN materials m ON m.id = pi.material_id
         LEFT JOIN batches rb ON rb.id = pi.batch_id
        WHERE pi.event_id = ?`
    ).all(ev.id).map((r) => ({
      material_id: r.material_id,
      ref_batch_id: r.ref_batch_id,
      material_code: r.material_code,
      material_name: r.material_name,
      material_allergens: r.material_allergens ? JSON.parse(r.material_allergens) : null,
      ref_batch_code: r.ref_batch_code
    }))
  }));

  const batches = db.prepare(
    `SELECT b.id, b.code, bo.allergens, bo.paths_json,
            ev.event_time AS produced_at, ev.equipment_id, eq.code AS equipment_code, eq.name AS equipment_name
       FROM batches b
       LEFT JOIN batch_outputs bo ON bo.batch_id = b.id
       LEFT JOIN events ev ON ev.batch_id = b.id
       LEFT JOIN equipment eq ON eq.id = ev.equipment_id
      ORDER BY ev.event_time, b.code`
  ).all().map((b) => ({
    id: b.id,
    code: b.code,
    produced_at: b.produced_at,
    equipment_id: b.equipment_id,
    equipment_code: b.equipment_code,
    equipment_name: b.equipment_name,
    allergens: b.allergens ? JSON.parse(b.allergens) : [],
    paths: b.paths_json ? JSON.parse(b.paths_json) : {},
    releases: db.prepare(
      `SELECT id, released_at, released_by, snapshot_allergens, status, invalid_reason
         FROM releases WHERE batch_id = ? ORDER BY released_at DESC, id DESC`
    ).all(b.id).map((r) => ({
      ...r,
      snapshot_allergens: JSON.parse(r.snapshot_allergens)
    }))
  }));

  res.json({ materials, equipment, events, batches });
});

// ---------- 通用：在事务中写事件集 -> 校验 -> 重算 ----------
function mutateEvents(fn) {
  const d = db;
  const result = d.transaction(() => {
    const ret = fn(d);
    const errors = validateAll(d);
    if (errors.length) {
      const err = new Error('VALIDATION_FAILED');
      err.errors = errors;
      throw err; // 回滚整次提交
    }
    const recomputeResult = recompute(d);
    return { ret, invalidated: recomputeResult.invalidated };
  })();
  return result;
}

function badRequest(res, err) {
  if (err && err.message === 'VALIDATION_FAILED') {
    return res.status(400).json({ error: '提交被拒绝（整次提交已回滚）', details: err.errors });
  }
  return res.status(400).json({ error: err && err.message ? err.message : String(err) });
}

// ---------- 原料 ----------
app.post('/api/materials', (req, res) => {
  try {
    const { code, name, allergens } = normalizeMaterial(req.body);
    const info = db.prepare(
      'INSERT INTO materials (code, name, allergens) VALUES (?,?,?)'
    ).run(code, name, JSON.stringify(allergens));
    res.json({ id: info.lastInsertRowid });
  } catch (err) { badRequest(res, err); }
});

app.put('/api/materials/:id', (req, res) => {
  try {
    const { code, name, allergens } = normalizeMaterial(req.body);
    const info = db.prepare(
      'UPDATE materials SET code=?, name=?, allergens=? WHERE id=?'
    ).run(code, name, JSON.stringify(allergens), req.params.id);
    if (!info.changes) return res.status(404).json({ error: '原料不存在' });
    // 过敏原被修改会改变批次推导结果，需要全量重算
    const { invalidated } = mutateEvents(() => {});
    res.json({ ok: true, invalidated });
  } catch (err) { badRequest(res, err); }
});

app.delete('/api/materials/:id', (req, res) => {
  try {
    const used = db.prepare(
      'SELECT COUNT(*) AS c FROM process_inputs WHERE material_id=?'
    ).get(req.params.id).c;
    if (used > 0) return res.status(400).json({ error: '该原料已被加工事件引用，请先更正相关事件' });
    const info = db.prepare('DELETE FROM materials WHERE id=?').run(req.params.id);
    if (!info.changes) return res.status(404).json({ error: '原料不存在' });
    res.json({ ok: true });
  } catch (err) { badRequest(res, err); }
});

function normalizeMaterial(body) {
  const code = String(body.code || '').trim();
  const name = String(body.name || '').trim();
  if (!code) throw new Error('原料编码不能为空');
  if (!name) throw new Error('原料名称不能为空');
  const allergens = [...new Set(
    (Array.isArray(body.allergens) ? body.allergens : [])
      .map((a) => String(a).trim()).filter(Boolean)
  )];
  return { code, name, allergens };
}

// ---------- 设备 ----------
app.post('/api/equipment', (req, res) => {
  try {
    const { code, name } = normalizeEquipment(req.body);
    const info = db.prepare('INSERT INTO equipment (code, name) VALUES (?,?)').run(code, name);
    db.prepare(
      `INSERT INTO equipment_residue (equipment_id, allergens, paths_json, last_cleaned_at)
       VALUES (?,'[]','{}',NULL)`
    ).run(info.lastInsertRowid);
    res.json({ id: info.lastInsertRowid });
  } catch (err) { badRequest(res, err); }
});

app.put('/api/equipment/:id', (req, res) => {
  try {
    const { code, name } = normalizeEquipment(req.body);
    const info = db.prepare('UPDATE equipment SET code=?, name=? WHERE id=?')
      .run(code, name, req.params.id);
    if (!info.changes) return res.status(404).json({ error: '设备不存在' });
    res.json({ ok: true });
  } catch (err) { badRequest(res, err); }
});

app.delete('/api/equipment/:id', (req, res) => {
  try {
    const used = db.prepare('SELECT COUNT(*) AS c FROM events WHERE equipment_id=?')
      .get(req.params.id).c;
    if (used > 0) return res.status(400).json({ error: '该设备下仍有事件，无法删除' });
    db.prepare('DELETE FROM equipment WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) { badRequest(res, err); }
});

function normalizeEquipment(body) {
  const code = String(body.code || '').trim();
  const name = String(body.name || '').trim();
  if (!code) throw new Error('设备编码不能为空');
  if (!name) throw new Error('设备名称不能为空');
  return { code, name };
}

// ---------- 事件 ----------
// body: { event_time, type, equipment_id, batch_code, note, material_ids:[], ref_batch_ids:[] }
app.post('/api/events', (req, res) => {
  try {
    const body = normalizeEventBody(req.body);
    const { ret, invalidated } = mutateEvents((d) => {
      let batchId = null;
      if (body.type === 'PROCESS') {
        batchId = d.prepare('INSERT INTO batches (code) VALUES (?)')
          .run(body.batch_code).lastInsertRowid;
      }
      const eid = d.prepare(
        'INSERT INTO events (event_time, type, equipment_id, batch_id, note) VALUES (?,?,?,?,?)'
      ).run(body.event_time, body.type, body.equipment_id, batchId, body.note).lastInsertRowid;
      if (body.type === 'PROCESS') {
        for (const mid of body.material_ids) {
          d.prepare('INSERT INTO process_inputs (event_id, material_id) VALUES (?,?)')
            .run(eid, mid);
        }
        for (const bid of body.ref_batch_ids) {
          d.prepare('INSERT INTO process_inputs (event_id, batch_id) VALUES (?,?)')
            .run(eid, bid);
        }
      }
      return eid;
    });
    res.json({ id: ret, invalidated });
  } catch (err) { badRequest(res, err); }
});

app.put('/api/events/:id', (req, res) => {
  try {
    const body = normalizeEventBody(req.body, true);
    const existing = db.prepare('SELECT id, type, batch_id FROM events WHERE id=?')
      .get(req.params.id);
    if (!existing) return res.status(404).json({ error: '事件不存在' });
    if (body.type !== existing.type) {
      return res.status(400).json({ error: '事件类型（加工/清洗）不可变更，请删除后新建' });
    }
    const { invalidated } = mutateEvents((d) => {
      if (body.type === 'PROCESS') {
        d.prepare('UPDATE batches SET code=? WHERE id=?')
          .run(body.batch_code, existing.batch_id);
        d.prepare('DELETE FROM process_inputs WHERE event_id=?').run(existing.id);
        for (const mid of body.material_ids) {
          d.prepare('INSERT INTO process_inputs (event_id, material_id) VALUES (?,?)')
            .run(existing.id, mid);
        }
        for (const bid of body.ref_batch_ids) {
          d.prepare('INSERT INTO process_inputs (event_id, batch_id) VALUES (?,?)')
            .run(existing.id, bid);
        }
      }
      d.prepare(
        'UPDATE events SET event_time=?, equipment_id=?, note=? WHERE id=?'
      ).run(body.event_time, body.equipment_id, body.note, existing.id);
    });
    res.json({ ok: true, invalidated });
  } catch (err) { badRequest(res, err); }
});

app.delete('/api/events/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT id, type, batch_id FROM events WHERE id=?')
      .get(req.params.id);
    if (!existing) return res.status(404).json({ error: '事件不存在' });
    const { invalidated } = mutateEvents((d) => {
      if (existing.type === 'PROCESS' && existing.batch_id) {
        const referenced = d.prepare(
          'SELECT COUNT(*) AS c FROM process_inputs WHERE batch_id=?'
        ).get(existing.batch_id).c;
        if (referenced > 0) {
          throw new Error('该批次仍被后续加工引用，请先更正引用它的事件');
        }
        const hasRelease = d.prepare(
          'SELECT COUNT(*) AS c FROM releases WHERE batch_id=?'
        ).get(existing.batch_id).c;
        if (hasRelease) {
          throw new Error('该批次已有放行记录，请先删除相关放行记录后再删除加工事件');
        }
        d.prepare('DELETE FROM batch_outputs WHERE batch_id=?').run(existing.batch_id);
        d.prepare('DELETE FROM batches WHERE id=?').run(existing.batch_id);
      }
      d.prepare('DELETE FROM events WHERE id=?').run(existing.id);
    });
    res.json({ ok: true, invalidated });
  } catch (err) { badRequest(res, err); }
});

function normalizeEventBody(body, isUpdate = false) {
  const type = String(body.type || '').toUpperCase();
  if (type !== 'PROCESS' && type !== 'CLEAN') throw new Error('事件类型必须为 PROCESS 或 CLEAN');
  const event_time = String(body.event_time || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(event_time)) {
    throw new Error('事件时间格式应为 YYYY-MM-DDTHH:MM，例如 2026-09-30T08:00');
  }
  const equipment_id = parseInt(body.equipment_id, 10);
  if (!Number.isInteger(equipment_id)) throw new Error('请选择设备');
  const note = String(body.note || '').trim();

  const out = { type, event_time, equipment_id, note, material_ids: [], ref_batch_ids: [] };
  if (type === 'PROCESS') {
    const batch_code = String(body.batch_code || '').trim();
    if (!batch_code) throw new Error('产出批次编码不能为空');
    out.batch_code = batch_code;
    out.material_ids = idList(body.material_ids);
    out.ref_batch_ids = idList(body.ref_batch_ids);
  }
  return out;
}

function idList(v) {
  return [...new Set((Array.isArray(v) ? v : []).map((x) => parseInt(x, 10)).filter(Number.isInteger))];
}

// ---------- 放行 ----------
// body: { batch_id, released_at, released_by } —— 以“当时推导结果”登记
app.post('/api/releases', (req, res) => {
  try {
    const batch_id = parseInt(req.body.batch_id, 10);
    if (!Number.isInteger(batch_id)) throw new Error('请选择批次');
    const released_at = String(req.body.released_at || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(released_at)) {
      throw new Error('放行时间格式应为 YYYY-MM-DDTHH:MM');
    }
    const released_by = String(req.body.released_by || '').trim() || '未署名';

    const out = db.prepare('SELECT allergens FROM batch_outputs WHERE batch_id=?').get(batch_id);
    const ev = db.prepare('SELECT id FROM events WHERE batch_id=?').get(batch_id);
    if (!out || !ev) return res.status(400).json({ error: '该批次尚无加工记录，无法放行' });

    const snapshot = sortedJson(JSON.parse(out.allergens));
    const info = db.prepare(
      `INSERT INTO releases (batch_id, released_at, released_by, snapshot_allergens, status, created_event_seq)
       VALUES (?,?,?,?,'ACTIVE',(SELECT COUNT(*) FROM events))`
    ).run(batch_id, released_at, released_by, snapshot);
    res.json({ id: info.lastInsertRowid });
  } catch (err) { badRequest(res, err); }
});

app.delete('/api/releases/:id', (req, res) => {
  const info = db.prepare('DELETE FROM releases WHERE id=?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: '放行记录不存在' });
  res.json({ ok: true });
});

// 兼容前端对未知路由回退到首页
app.get(/^(?!\/api\/).*/, (req, res, next) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, HOST, () => {
  console.log(`过敏原追踪系统已启动: http://localhost:${PORT}`);
});
