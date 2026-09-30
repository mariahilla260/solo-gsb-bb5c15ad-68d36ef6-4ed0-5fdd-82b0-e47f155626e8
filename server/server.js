'use strict';
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { getDb, getRevision } = require('./db');
const { validateAll } = require('./validation');
const { recompute, sortedJson } = require('./recompute');
const { seedIfEmpty } = require('./seed');
const {
  ChangeSetError, previewChangeSet, hashChanges, applyChangeSet,
  parseChangeSet, snapshot, diffSnapshots
} = require('./changesets');

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

  res.json({ revision: getRevision(db), materials, equipment, events, batches });
});

// ---------- 业务版本 ----------
// 任何影响推导/放行结果的正式写入都在其事务内 bumpRevision：
// 既让 /api/state 可暴露当前业务版本，也把此前所有预演版本置为 SUPERSEDED。
function bumpRevision(d) {
  const next = getRevision(d) + 1;
  d.prepare(
    `INSERT INTO app_meta(key,value) VALUES('revision',?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(String(next));
  // 此前预演版本全部过期
  d.prepare(
    `UPDATE change_set_versions SET status='SUPERSEDED' WHERE status='ACTIVE'`
  ).run();
  return next;
}

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
    const revision = bumpRevision(d);
    return { ret, invalidated: recomputeResult.invalidated, revision };
  })();
  return result;
}

function badRequest(res, err) {
  if (err instanceof ChangeSetError) {
    const status = {
      VALIDATION_ERROR: 400,
      PAYLOAD_MISMATCH: 400,
      VERSION_UNKNOWN: 404,
      REVISION_STALE: 409
    }[err.code] || 400;
    const body = {
      error: err.message,
      error_code: err.code,
      ...(err.details ? { details: err.details } : {}),
      ...(err.validation_errors ? { validation_errors: err.validation_errors } : {})
    };
    return res.status(status).json(body);
  }
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
    const { invalidated, revision } = mutateEvents(() => {});
    res.json({ ok: true, invalidated, revision });
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
    const existing = db.prepare('SELECT id FROM equipment WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: '设备不存在' });
    // 设备名称/编码会出现在推导来源路径中，视为影响结果
    const revision = db.transaction(() => {
      db.prepare('UPDATE equipment SET code=?, name=? WHERE id=?')
        .run(code, name, existing.id);
      return bumpRevision(db);
    })();
    res.json({ ok: true, revision });
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
    const { ret, invalidated, revision } = mutateEvents((d) => {
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
    res.json({ id: ret, invalidated, revision });
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
    const { invalidated, revision } = mutateEvents((d) => {
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
    res.json({ ok: true, invalidated, revision });
  } catch (err) { badRequest(res, err); }
});

app.delete('/api/events/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT id, type, batch_id FROM events WHERE id=?')
      .get(req.params.id);
    if (!existing) return res.status(404).json({ error: '事件不存在' });
    const { invalidated, revision } = mutateEvents((d) => {
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
    res.json({ ok: true, invalidated, revision });
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
    const info = db.transaction(() => {
      const r = db.prepare(
        `INSERT INTO releases (batch_id, released_at, released_by, snapshot_allergens, status, created_event_seq)
         VALUES (?,?,?,?,'ACTIVE',(SELECT COUNT(*) FROM events))`
      ).run(batch_id, released_at, released_by, snapshot);
      bumpRevision(db);
      return r;
    });
    res.json({ id: info.lastInsertRowid, revision: getRevision(db) });
  } catch (err) { badRequest(res, err); }
});

app.delete('/api/releases/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM releases WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '放行记录不存在' });
  db.transaction(() => {
    db.prepare('DELETE FROM releases WHERE id=?').run(existing.id);
    bumpRevision(db); // 放行集合变化会影响“将失效的放行记录”差异
  })();
  res.json({ ok: true, revision: getRevision(db) });
});

// ---------- 整组变更：预演 + 确认应用（乐观并发，业务版本） ----------
// 预演：一次提交多条既有加工/清洗事件的更正 + 拟插入的清洗事件，
//       在内存影子库上按整组最终时间线校验/重算，对比应用前后每批过敏原、
//       设备残留与将失效的放行记录。正式事件、推导结果、放行状态均不变。
function compactBatches(snap) {
  return [...snap.batches.values()]
    .sort((a, b) => (a.produced_at || '').localeCompare(b.produced_at || '')
      || (a.code || '').localeCompare(b.code || '', 'zh'))
    .map((b) => ({
      batch_id: b.id, code: b.code, produced_at: b.produced_at,
      equipment_id: b.equipment_id, allergens: b.allergens
    }));
}

function compactResidues(snap, equip) {
  return [...snap.residues.entries()]
    .map(([equipment_id, r]) => ({
      equipment_id,
      equipment_code: (equip.get(equipment_id) || {}).code,
      equipment_name: (equip.get(equipment_id) || {}).name,
      ...r
    }))
    .sort((a, b) => a.equipment_id - b.equipment_id);
}

function equipmentMap() {
  return new Map(db.prepare('SELECT id, code, name FROM equipment').all()
    .map((e) => [e.id, e]));
}

// 为只带 equipment_id 的差异/时间线条目补上设备编码与名称
function decorateEquip(list, equip) {
  return (list || []).map((x) => ({
    equipment_code: (equip.get(x.equipment_id) || {}).code,
    equipment_name: (equip.get(x.equipment_id) || {}).name,
    ...x
  }));
}

app.post('/api/change-sets/preview', (req, res) => {
  try {
    const p = previewChangeSet(db, req.body);
    const baseRevision = getRevision(db);
    const versionToken = crypto.randomBytes(24).toString('hex');
    const equip = equipmentMap();

    db.prepare(
      `INSERT INTO change_set_versions
         (version_token, base_revision, payload_hash, payload_json, result_summary_json, status)
       VALUES (?,?,?,?,?,  'ACTIVE')`
    ).run(
      versionToken,
      baseRevision,
      p.payloadHash,
      JSON.stringify({ changes: p.changes }),
      JSON.stringify(p.counts)
    );

    res.json({
      version_token: versionToken,
      revision: baseRevision,
      valid: true,
      counts: p.counts,
      diff: {
        ...p.diff,
        residue_changes: decorateEquip(p.diff.residue_changes, equip)
      },
      before: {
        batches: compactBatches(p.before),
        equipment_residue: compactResidues(p.before, equip)
      },
      after: {
        batches: compactBatches(p.after),
        equipment_residue: compactResidues(p.after, equip)
      },
      timeline_after: p.timelineAfter.map((e) => ({
        id: e.id,
        event_time: e.event_time,
        type: e.type,
        equipment_id: e.equipment_id,
        equipment_code: (equip.get(e.equipment_id) || {}).code,
        equipment_name: (equip.get(e.equipment_id) || {}).name,
        batch_code: e.batch_code,
        corrected: e.corrected,
        inserted: e.inserted,
        client_ref: e.client_ref
      })),
      inserted_cleans: p.insertedEvents.map((x) => ({
        ...x,
        equipment_code: (equip.get(x.equipment_id) || {}).code,
        equipment_name: (equip.get(x.equipment_id) || {}).name
      }))
    });
  } catch (err) {
    return badRequest(res, err);
  }
});

// 确认：须携带预演版本（version_token）及相同变更内容（corrections/insert_cleans）。
// 在一次事务中：校验版本存在且未使用/未过期 → 业务版本未推进 → 变更内容哈希一致
//              → 应用整组变更 → 整组时间线重新校验 → 全量重算（含放行核对）→ 落库。
app.post('/api/change-sets/apply', (req, res) => {
  try {
    const token = String((req.body && req.body.version_token) || '').trim();
    if (!token) throw new ChangeSetError('VERSION_UNKNOWN', '缺少 version_token（请先预演）');

    const ver = db.prepare(
      'SELECT * FROM change_set_versions WHERE version_token=?'
    ).get(token);
    if (!ver) {
      throw new ChangeSetError('VERSION_UNKNOWN',
        '预演版本不存在，请重新预演');
    }
    if (ver.status === 'APPLIED') {
      return res.status(409).json({
        error: '该预演版本已应用，请勿重复提交；如需再次变更请重新预演',
        error_code: 'VERSION_APPLIED'
      });
    }
    if (ver.status !== 'ACTIVE' || getRevision(db) !== ver.base_revision) {
      return res.status(409).json({
        error: `预演版本已过期（预演基于业务版本 ${ver.base_revision}，当前为 ${getRevision(db)}）。`
          + '预演后已有影响推导/放行结果的正式写入，请重新预演后再确认；原状态未改变。',
        error_code: 'REVISION_STALE',
        base_revision: ver.base_revision,
        current_revision: getRevision(db)
      });
    }

    // 用正式库当前状态重新解析（确保“未知事件/设备”等引用仍然有效）并重算哈希
    let changes;
    try {
      changes = parseChangeSet(db, {
        corrections: (req.body && req.body.corrections) || [],
        insert_cleans: (req.body && req.body.insert_cleans) || []
      });
    } catch (e) {
      if (e instanceof ChangeSetError) {
        throw new ChangeSetError('PAYLOAD_MISMATCH',
          '确认内容与预演时不一致或已不再合法', e.details);
      }
      throw e;
    }
    if (hashChanges(changes) !== ver.payload_hash) {
      throw new ChangeSetError('PAYLOAD_MISMATCH',
        '确认提交的变更内容与预演时不一致，请用相同内容确认或重新预演');
    }

    const beforeSnap = snapshot(db);
    const outcome = db.transaction(() => {
      const inserted = applyChangeSet(db, changes);
      const errors = validateAll(db);
      if (errors.length) {
        const err = new Error('VALIDATION_FAILED');
        err.errors = errors;
        throw err; // 回滚，正式状态不变
      }
      const { invalidated } = recompute(db);
      const revision = bumpRevision(db);
      db.prepare(
        `UPDATE change_set_versions SET status='APPLIED', applied_at=datetime('now')
          WHERE version_token=?`
      ).run(token);
      return { inserted, invalidated, revision };
    })();

    const afterSnap = snapshot(db);
    const equip = equipmentMap();
    const applyDiff = diffSnapshots(beforeSnap, afterSnap);
    res.json({
      ok: true,
      applied: true,
      revision: outcome.revision,
      inserted_cleans: outcome.inserted.map((x) => ({
        event_id: x.scratch_id, // 此刻已是正式事件 id
        client_ref: x.client_ref,
        event_time: x.event_time,
        equipment_id: x.equipment_id,
        equipment_code: (equip.get(x.equipment_id) || {}).code,
        equipment_name: (equip.get(x.equipment_id) || {}).name
      })),
      invalidated: outcome.invalidated,
      diff: { ...applyDiff, residue_changes: decorateEquip(applyDiff.residue_changes, equip) }
    });
  } catch (err) {
    if (err.message === 'VALIDATION_FAILED') {
      return res.status(400).json({
        error: '整组最终时间线校验未通过，应用已拒绝（事务回滚，原状态不变）',
        error_code: 'VALIDATION_ERROR',
        validation_errors: err.errors
      });
    }
    return badRequest(res, err);
  }
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
