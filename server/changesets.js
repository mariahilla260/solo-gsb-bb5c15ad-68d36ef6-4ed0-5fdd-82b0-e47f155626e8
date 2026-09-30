'use strict';
// 整组变更（多条既有加工/清洗事件更正 + 拟插入的清洗事件）：
//   预演 POST /api/change-sets/preview  —— 在内存影子库上应用变更并全量校验/重算，
//                                          正式事件、推导结果、放行状态均不变，返回业务版本；
//   确认 POST /api/change-sets/apply    —— 携带预演版本与相同变更内容，在一次事务中
//                                          重新校验业务版本、变更内容，再校验/重算并落库。
//
// 整组最终合法即允许预演（不要求每条更正单独合法）；任何影响推导/放行结果的正式写入
// 都会推进业务版本（revision），使此前预演版本过期，确认时被拒绝且原状态不变。

const crypto = require('crypto');
const Database = require('better-sqlite3');
const { initSchema, getRevision } = require('./db');
const { validateAll } = require('./validation');
const { recompute } = require('./recompute');

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

class ChangeSetError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code; // VALIDATION_ERROR(400) / VERSION_UNKNOWN(404) /
                      // REVISION_STALE(409) / PAYLOAD_MISMATCH(400)
    if (Array.isArray(details)) this.details = details;
  }
}

// 影子库只复制业务表（应用版本表/元信息表不复制）；顺序须满足外键依赖（父表在前）
const COPY_TABLES = [
  'materials', 'equipment', 'batches', 'events', 'process_inputs',
  'batch_outputs', 'equipment_residue', 'releases'
];

// ---------------- 请求解析与基础校验（针对正式库的当前状态） ----------------

function idList(v) {
  return [...new Set(
    (Array.isArray(v) ? v : []).map((x) => parseInt(x, 10)).filter(Number.isInteger)
  )];
}

function parseChangeSet(db, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ChangeSetError('VALIDATION_ERROR', '请求体必须是 JSON 对象');
  }

  const correctionsRaw = Array.isArray(body.corrections) ? body.corrections : [];
  const insertsRaw = Array.isArray(body.insert_cleans) ? body.insert_cleans : [];
  if (!correctionsRaw.length && !insertsRaw.length) {
    throw new ChangeSetError('VALIDATION_ERROR',
      '变更组为空：corrections 与 insert_cleans 至少提供一项');
  }

  const errors = [];

  // ---- 更正既有事件 ----
  const seenEventIds = new Set();
  const corrections = correctionsRaw.map((c, i) => {
    const where = `corrections[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      errors.push(`${where}：必须是对象`);
      return null;
    }
    const event_id = parseInt(c.event_id, 10);
    if (!Number.isInteger(event_id)) {
      errors.push(`${where}：缺少 event_id`);
    } else if (seenEventIds.has(event_id)) {
      errors.push(`重复更正同一事件：event_id=${event_id}`);
    } else {
      seenEventIds.add(event_id);
    }
    const out = { event_id, event_time: null, equipment_id: null, note: null,
      batch_code: null, material_ids: null, ref_batch_ids: null };

    const ev = Number.isInteger(event_id)
      ? db.prepare('SELECT id, type, batch_id FROM events WHERE id=?').get(event_id)
      : null;
    if (Number.isInteger(event_id) && !ev) {
      errors.push(`未知事件：event_id=${event_id}`);
    }

    if (c.event_time !== undefined && c.event_time !== null) {
      const t = String(c.event_time).trim();
      if (!TIME_RE.test(t)) {
        errors.push(`${where}：event_time 格式应为 YYYY-MM-DDTHH:MM`);
      } else {
        out.event_time = t;
      }
    }

    if (c.equipment_id !== undefined && c.equipment_id !== null) {
      const qid = parseInt(c.equipment_id, 10);
      if (!Number.isInteger(qid)) {
        errors.push(`${where}：equipment_id 必须是整数`);
      } else {
        const eq = db.prepare('SELECT id FROM equipment WHERE id=?').get(qid);
        if (!eq) errors.push(`${where}：设备不存在（equipment_id=${qid}）`);
        out.equipment_id = qid;
      }
    }

    if (c.note !== undefined && c.note !== null) out.note = String(c.note).trim();

    if (ev && ev.type === 'PROCESS') {
      if (c.batch_code !== undefined && c.batch_code !== null) {
        const code = String(c.batch_code).trim();
        if (!code) {
          errors.push(`${where}：batch_code 不能为空（加工事件）`);
        } else {
          out.batch_code = code;
          const dup = db.prepare(
            'SELECT id FROM batches WHERE code=? AND id<>?'
          ).get(code, ev.batch_id);
          if (dup) errors.push(`${where}：批次编码 ${code} 已被其他批次使用`);
        }
      }
      if (c.material_ids !== undefined) out.material_ids = idList(c.material_ids);
      if (c.ref_batch_ids !== undefined) out.ref_batch_ids = idList(c.ref_batch_ids);

      for (const mid of out.material_ids || []) {
        if (!db.prepare('SELECT id FROM materials WHERE id=?').get(mid)) {
          errors.push(`${where}：原料不存在（material_id=${mid}）`);
        }
      }
      for (const bid of out.ref_batch_ids || []) {
        const prod = db.prepare(
          'SELECT b.id FROM batches b JOIN events e ON e.batch_id=b.id WHERE b.id=?'
        ).get(bid);
        if (!prod) {
          errors.push(`${where}：引用批次不存在或无加工记录（batch_id=${bid}）`);
        }
      }
    } else if (ev && ev.type === 'CLEAN') {
      if (c.batch_code !== undefined || c.material_ids !== undefined || c.ref_batch_ids !== undefined) {
        errors.push(`${where}：清洗事件不能携带批次/原料/引用字段`);
      }
    }
    return out;
  }).filter(Boolean);

  // ---- 拟插入的清洗事件 ----
  const usedRefs = new Set();
  const insertCleans = insertsRaw.map((c, i) => {
    const where = `insert_cleans[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      errors.push(`${where}：必须是对象`);
      return null;
    }
    const event_time = String(c.event_time || '').trim();
    if (!event_time) {
      errors.push(`清洗事件缺少时间：${where}`);
    } else if (!TIME_RE.test(event_time)) {
      errors.push(`${where}：event_time 格式应为 YYYY-MM-DDTHH:MM`);
    }
    const equipment_id = parseInt(c.equipment_id, 10);
    if (!Number.isInteger(equipment_id)) {
      errors.push(`${where}：缺少 equipment_id`);
    } else if (!db.prepare('SELECT id FROM equipment WHERE id=?').get(equipment_id)) {
      errors.push(`${where}：设备不存在（equipment_id=${equipment_id}）`);
    }
    const note = String(c.note || '').trim();

    // 可选客户端引用号，用于把确认后生成的正式事件 id 对应回调用方的条目
    let client_ref = c.client_ref;
    if (client_ref === undefined || client_ref === null) client_ref = `#${i + 1}`;
    client_ref = String(client_ref);
    if (usedRefs.has(client_ref)) {
      errors.push(`${where}：client_ref 重复（${client_ref}）`);
    }
    usedRefs.add(client_ref);

    return { event_time: TIME_RE.test(event_time) ? event_time : '',
      equipment_id: Number.isInteger(equipment_id) ? equipment_id : null,
      note, client_ref };
  }).filter(Boolean);

  if (errors.length) {
    throw new ChangeSetError('VALIDATION_ERROR', '变更组内容校验未通过', errors);
  }
  return { corrections, insert_cleans: insertCleans };
}

// 规范化变更内容（字段齐全、顺序固定），据此生成哈希并随确认重算
function canonical(changes) {
  return {
    corrections: changes.corrections.map((c) => ({
      event_id: c.event_id,
      event_time: c.event_time,
      equipment_id: c.equipment_id,
      note: c.note,
      batch_code: c.batch_code,
      material_ids: c.material_ids,
      ref_batch_ids: c.ref_batch_ids
    })),
    insert_cleans: changes.insert_cleans.map((c) => ({
      event_time: c.event_time,
      equipment_id: c.equipment_id,
      note: c.note,
      client_ref: c.client_ref
    }))
  };
}

function hashChanges(changes) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonical(changes))).digest('hex');
}

// ---------------- 内存影子库：复制正式库当前数据 ----------------

function openScratchDb(sourceDb) {
  const mem = new Database(':memory:');
  mem.pragma('foreign_keys = ON');
  initSchema(mem);

  const tx = mem.transaction(() => {
    for (const table of COPY_TABLES) {
      const cols = sourceDb.prepare(`PRAGMA table_info(${table})`).all()
        .map((c) => c.name).filter((n) => n !== 'id' || true); // 保留自增 id
      const rows = sourceDb.prepare(`SELECT * FROM ${table}`).all();
      if (!rows.length) continue;
      const names = Object.keys(rows[0]);
      const ins = mem.prepare(
        `INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`
      );
      for (const r of rows) ins.run(...names.map((n) => r[n]));
    }
    // 复制自增计数，保证影子库里新插入 id 不与既有 id 冲突（仅影响预演内部）
    const seq = sourceDb.prepare(
      "SELECT name, seq FROM sqlite_sequence WHERE name IN (" +
      COPY_TABLES.map(() => '?').join(',') + ')'
    ).all(...COPY_TABLES);
    for (const s of seq) {
      mem.prepare('INSERT OR REPLACE INTO sqlite_sequence(name,seq) VALUES (?,?)')
        .run(s.name, s.seq);
    }
  });
  tx();
  return mem;
}

// ---------------- 在（任意）连接的事务内应用整组变更 ----------------

function applyChangeSet(d, changes) {
  const inserted = []; // { scratch_id, client_ref, event_time, equipment_id }

  for (const c of changes.corrections) {
    const ev = d.prepare('SELECT id, type, batch_id FROM events WHERE id=?')
      .get(c.event_id);
    if (!ev) throw new ChangeSetError('VALIDATION_ERROR',
      '应用时发现事件不存在', [`未知事件：event_id=${c.event_id}`]);

    if (ev.type === 'PROCESS') {
      if (c.batch_code !== null) {
        d.prepare('UPDATE batches SET code=? WHERE id=?').run(c.batch_code, ev.batch_id);
      }
      if (c.material_ids !== null || c.ref_batch_ids !== null) {
        d.prepare('DELETE FROM process_inputs WHERE event_id=?').run(ev.id);
        for (const mid of c.material_ids || []) {
          d.prepare('INSERT INTO process_inputs (event_id, material_id) VALUES (?,?)')
            .run(ev.id, mid);
        }
        for (const bid of c.ref_batch_ids || []) {
          d.prepare('INSERT INTO process_inputs (event_id, batch_id) VALUES (?,?)')
            .run(ev.id, bid);
        }
      }
    }

    const cur = d.prepare('SELECT event_time, equipment_id, note FROM events WHERE id=?')
      .get(ev.id);
    d.prepare('UPDATE events SET event_time=?, equipment_id=?, note=? WHERE id=?')
      .run(c.event_time !== null ? c.event_time : cur.event_time,
           c.equipment_id !== null ? c.equipment_id : cur.equipment_id,
           c.note !== null ? c.note : cur.note,
           ev.id);
  }

  const insClean = d.prepare(
    'INSERT INTO events (event_time, type, equipment_id, batch_id, note) VALUES (?,?,?,?,?)'
  );
  for (const c of changes.insert_cleans) {
    const id = insClean.run(c.event_time, 'CLEAN', c.equipment_id, null, c.note)
      .lastInsertRowid;
    inserted.push({ scratch_id: id, client_ref: c.client_ref,
      event_time: c.event_time, equipment_id: c.equipment_id });
  }

  return inserted;
}

// ---------------- 前后快照与差异 ----------------

function snapshot(d) {
  const batches = new Map();
  d.prepare(
    `SELECT b.id, b.code, bo.allergens, ev.event_time AS produced_at,
            ev.equipment_id
       FROM batches b
       LEFT JOIN batch_outputs bo ON bo.batch_id = b.id
       LEFT JOIN events ev ON ev.batch_id = b.id`
  ).all().forEach((r) => batches.set(r.id, {
    id: r.id, code: r.code, produced_at: r.produced_at, equipment_id: r.equipment_id,
    allergens: r.allergens ? JSON.parse(r.allergens) : []
  }));

  const residues = new Map();
  d.prepare(
    `SELECT equipment_id, allergens, last_cleaned_at FROM equipment_residue`
  ).all().forEach((r) => residues.set(r.equipment_id, {
    allergens: JSON.parse(r.allergens || '[]'),
    last_cleaned_at: r.last_cleaned_at
  }));

  // 当前生效（ACTIVE）放行：以其快照集合作为对比口径
  const releases = new Map();
  d.prepare(
    `SELECT r.id, r.batch_id, r.snapshot_allergens, b.code AS batch_code
       FROM releases r JOIN batches b ON b.id = r.batch_id
      WHERE r.status = 'ACTIVE'`
  ).all().forEach((r) => releases.set(r.id, {
    id: r.id, batch_id: r.batch_id, batch_code: r.batch_code,
    snapshot: JSON.parse(r.snapshot_allergens)
  }));

  const timeline = d.prepare(
    `SELECT ev.id, ev.event_time, ev.type, ev.equipment_id,
            b.code AS batch_code
       FROM events ev LEFT JOIN batches b ON b.id = ev.batch_id
      ORDER BY ev.event_time, ev.id`
  ).all().map((e) => ({ ...e }));

  return { batches, residues, releases, timeline };
}

const zhSort = (a, b) => a.localeCompare(b, 'zh');

function diffSnapshots(before, after) {
  const batch_changes = [];
  const batchIds = new Set([...before.batches.keys(), ...after.batches.keys()]);
  for (const bid of batchIds) {
    const a = before.batches.get(bid);
    const b = after.batches.get(bid);
    const beforeA = a ? a.allergens : null;
    const afterA = b ? b.allergens : null;
    const same = JSON.stringify([...(beforeA || [])].sort(zhSort))
      === JSON.stringify([...(afterA || [])].sort(zhSort));
    if (!same) {
      const oldSet = beforeA || [];
      const newSet = afterA || [];
      batch_changes.push({
        batch_id: bid,
        batch_code: (b || a).code,
        produced_at: b ? b.produced_at : (a ? a.produced_at : null),
        before_allergens: oldSet,
        after_allergens: newSet,
        added: newSet.filter((x) => !oldSet.includes(x)),
        removed: oldSet.filter((x) => !newSet.includes(x))
      });
    }
  }
  batch_changes.sort((x, y) => (x.batch_code || '').localeCompare(y.batch_code || '', 'zh'));

  const residue_changes = [];
  const eqIds = new Set([...before.residues.keys(), ...after.residues.keys()]);
  for (const qid of eqIds) {
    const a = before.residues.get(qid);
    const b = after.residues.get(qid);
    const oldSet = a ? a.allergens : [];
    const newSet = b ? b.allergens : [];
    if (JSON.stringify([...oldSet].sort(zhSort)) !== JSON.stringify([...newSet].sort(zhSort))
        || (a ? a.last_cleaned_at : null) !== (b ? b.last_cleaned_at : null)) {
      residue_changes.push({
        equipment_id: qid,
        before_allergens: oldSet,
        after_allergens: newSet,
        added: newSet.filter((x) => !oldSet.includes(x)),
        removed: oldSet.filter((x) => !newSet.includes(x)),
        before_last_cleaned_at: a ? a.last_cleaned_at : null,
        after_last_cleaned_at: b ? b.last_cleaned_at : null
      });
    }
  }
  residue_changes.sort((x, y) => x.equipment_id - y.equipment_id);

  // 将失效的放行：预演前 ACTIVE，且重算后批次集合与其登记快照不同
  const will_invalidate = [];
  for (const [rid, rel] of before.releases.entries()) {
    const b = after.batches.get(rel.batch_id);
    const current = b ? b.allergens : [];
    if (JSON.stringify([...current].sort(zhSort))
        !== JSON.stringify([...rel.snapshot].sort(zhSort))) {
      const added = current.filter((x) => !rel.snapshot.includes(x));
      const removed = rel.snapshot.filter((x) => !current.includes(x));
      const parts = [];
      if (added.length) parts.push(`新增：${added.join('、')}`);
      if (removed.length) parts.push(`移除：${removed.join('、')}`);
      will_invalidate.push({
        release_id: rid,
        batch_id: rel.batch_id,
        batch_code: rel.batch_code,
        snapshot_allergens: rel.snapshot,
        after_allergens: current,
        added, removed,
        reason: b
          ? `预演重算后过敏原集合与放行登记时不同（${parts.join('；') || '集合不同'}）`
          : '该批次的加工事件在变更后不存在，无法重新推导过敏原'
      });
    }
  }
  will_invalidate.sort((x, y) => x.release_id - y.release_id);

  return { batch_changes, residue_changes, will_invalidate };
}

// ---------------- 预演（不触碰正式数据） ----------------

function previewChangeSet(db, body) {
  const changes = parseChangeSet(db, body);
  const payloadHash = hashChanges(changes);
  const before = snapshot(db);

  const scratch = openScratchDb(db);
  let inserted;
  let validationErrors = [];
  let recomputeOk = false;
  try {
    scratch.transaction(() => {
      inserted = applyChangeSet(scratch, changes);
      validationErrors = validateAll(scratch);
      if (validationErrors.length) {
        throw new Error('ROLLBACK_SCRATCH');
      }
      recompute(scratch);
      recomputeOk = true;
    })();
  } catch (err) {
    if (err.message !== 'ROLLBACK_SCRATCH') {
      scratch.close();
      throw err;
    }
  }

  if (!recomputeOk) {
    scratch.close();
    const e = new ChangeSetError('VALIDATION_ERROR',
      '整组变更后的时间线校验未通过，预演失败', validationErrors);
    e.validation_errors = validationErrors;
    throw e;
  }

  const after = snapshot(scratch);
  scratch.close();

  const diff = diffSnapshots(before, after);

  // 标记变更后的时间线中被更正/新插入的事件
  const correctedIds = new Set(changes.corrections.map((c) => c.event_id));
  const refByScratch = new Map(inserted.map((x) => [x.scratch_id, x.client_ref]));
  const timelineAfter = after.timeline.map((e) => ({
    ...e,
    corrected: correctedIds.has(e.id),
    inserted: refByScratch.has(e.id),
    client_ref: refByScratch.get(e.id) || null
  }));
  const insertedEvents = inserted.map((x) => ({
    client_ref: x.client_ref, event_time: x.event_time, equipment_id: x.equipment_id
  }));

  return {
    changes,
    payloadHash,
    before,
    after,
    diff,
    timelineAfter,
    insertedEvents,
    counts: {
      corrections: changes.corrections.length,
      insert_cleans: changes.insert_cleans.length,
      batch_changes: diff.batch_changes.length,
      residue_changes: diff.residue_changes.length,
      will_invalidate: diff.will_invalidate.length
    }
  };
}

module.exports = {
  ChangeSetError,
  parseChangeSet,
  hashChanges,
  applyChangeSet,
  previewChangeSet,
  diffSnapshots,
  snapshot
};
