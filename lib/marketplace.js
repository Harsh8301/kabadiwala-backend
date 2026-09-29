const crypto = require('node:crypto');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const id = () => crypto.randomUUID();
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const requireRole = (user, roles) => { if (!roles.includes(user.role)) fail(403, 'Role is not permitted'); };
const positive = (value, name) => { const number = Number(value); if (!Number.isFinite(number) || number <= 0) fail(400, `Invalid ${name}`); return number; };
const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);
function imageFromBody(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2800000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail(400,'Invalid image');
  const bytes = Buffer.from(value,'base64');
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) fail(400,'Image too large');
  const mimeType = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg'
    : bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' ? 'image/webp' : null;
  if (!mimeType) fail(400,'Unsupported image');
  return {bytes,mimeType};
}
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const passwordHash = (password, salt = crypto.randomBytes(16).toString('hex')) =>
  `${salt}:${crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex')}`;
const verifyPassword = (password, stored) => {
  const [salt, expected] = stored.split(':');
  const actual = passwordHash(password, salt).split(':')[1];
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
};
const query = (db, sql, values = []) => db.query(sql, values);
async function transaction(work) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const value = await work(db); await db.query('COMMIT'); return value; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
async function actor(request) {
  const token = /^Bearer (.+)$/i.exec(request.headers.authorization || '')?.[1];
  if (!token) fail(401, 'Sign in required');
  const result = await pool.query(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now()`, [hash(token)]);
  if (!result.rows[0]) fail(401, 'Session expired');
  return result.rows[0];
}
async function event(db, record, user, type, previous = null, next = null, weight = null, location = '') {
  await query(db, `INSERT INTO trace_events(id,lot_id,batch_id,actor_id,actor_role,event_type,weight_kg,location,previous_owner,new_owner)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id(), record.lot_id || null, record.batch_id || null, user.id, user.role, type, weight, location, previous, next]);
}
async function audit(db, user, action, targetType, targetId, details = {}) {
  await query(db,`INSERT INTO audit_logs(id,actor_id,action,target_type,target_id,details)
    VALUES($1,$2,$3,$4,$5,$6)`,[id(),user.id,action,targetType,String(targetId),JSON.stringify(details)]);
}
async function asset(db, body, lock = false) {
  const lotId = text(body.lotId || body.lot_id, 80);
  const batchId = text(body.batchId || body.batch_id, 80);
  if (!!lotId === !!batchId) fail(400, 'Supply one lotId or batchId');
  const table = lotId ? 'lots' : 'batches';
  const result = await query(db, `SELECT * FROM ${table} WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [lotId || batchId]);
  if (!result.rows[0]) fail(404, 'Record not found');
  return { ...result.rows[0], lot_id: lotId || null, batch_id: batchId || null, table };
}
const canBuy = (seller, buyer) => ({
  COLLECTOR: ['AGGREGATOR','MIDDLEMAN','RECYCLER'],
  AGGREGATOR: ['MIDDLEMAN','RECYCLER'],
  MIDDLEMAN: ['AGGREGATOR','RECYCLER'],
  RECYCLER: []
}[seller] || []).includes(buyer);
async function route(request, body = {}) {
  const url = new URL(request.url, 'https://local.invalid');
  const resource = url.searchParams.get('resource');
  const action = url.searchParams.get('action');
  const method = request.method;
  if (resource === 'auth' && method === 'POST') {
    if (action === 'register') {
      const role = text(body.role, 20).toUpperCase();
      if (!['COLLECTOR','AGGREGATOR','MIDDLEMAN','RECYCLER'].includes(role)) fail(400, 'Invalid role');
      const email = text(body.email, 254).toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) fail(400, 'Valid email required');
      if (typeof body.password !== 'string' || body.password.length < 12) fail(400, 'Password must contain at least 12 characters');
      if (!text(body.name, 100)) fail(400, 'Name required');
      if (!text(body.location, 200)) fail(400, 'Operating area required');
      if (!['en','hi','mr','kn','te','bn'].includes(body.language)) fail(400, 'Invalid language');
      return transaction(async db => {
        const user = (await query(db, `INSERT INTO users(id,email,password_hash,role,name,language,location)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,email,role,name,language,location`,
          [id(), email, passwordHash(body.password), role, text(body.name, 100), body.language, text(body.location, 200)])).rows[0];
        const token = crypto.randomBytes(32).toString('base64url');
        await query(db, `INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')`, [hash(token), user.id]);
        return { token, user };
      });
    }
    if (action === 'login') {
      const result = await pool.query('SELECT * FROM users WHERE email=$1', [text(body.email, 254).toLowerCase()]);
      const user = result.rows[0];
      if (!user || !verifyPassword(String(body.password || ''), user.password_hash)) fail(401, 'Invalid credentials');
      const token = crypto.randomBytes(32).toString('base64url');
      await pool.query(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')`, [hash(token), user.id]);
      return { token, user: { id: user.id, email: user.email, role: user.role, name: user.name, language: user.language, location: user.location } };
    }
  }
  const user = await actor(request);
  if (resource === 'auth' && action === 'logout' && method === 'POST') {
    await pool.query('DELETE FROM sessions WHERE token_hash=$1', [hash(request.headers.authorization.slice(7))]);
    return { ok: true };
  }
  if (resource === 'me' && method === 'GET') return { id: user.id, email: user.email, role: user.role, name: user.name,
    language: user.language, location: user.location, facilityName: user.facility_name,
    authorizationNumber: user.authorization_number, authorizationStatus: user.authorization_status,
    materialsAccepted: user.materials_accepted, offeredRates: user.offered_rates,
    pickupAvailable: user.pickup_available, serviceArea: user.service_area };
  if (resource === 'me' && method === 'PATCH') {
    const changedAuthorization = user.role === 'RECYCLER' &&
      ((body.authorizationNumber != null && text(body.authorizationNumber,100) !== user.authorization_number) ||
       (body.facilityName != null && text(body.facilityName,100) !== user.facility_name));
    const result = await pool.query(`UPDATE users SET name=$2,language=$3,location=$4,facility_name=$5,
      authorization_number=$6,materials_accepted=$7,offered_rates=$8,pickup_available=$9,service_area=$10,
      authorization_status=CASE WHEN $11 THEN 'UNVERIFIED' ELSE authorization_status END
      WHERE id=$1 RETURNING id,role,name,language,location,facility_name,authorization_status,materials_accepted,offered_rates,pickup_available,service_area`,
      [user.id, text(body.name ?? user.name, 100), text(body.language ?? user.language, 5), text(body.location ?? user.location, 200),
        text(body.facilityName ?? user.facility_name, 100), text(body.authorizationNumber ?? user.authorization_number, 100),
        JSON.stringify(body.materialsAccepted ?? user.materials_accepted), JSON.stringify(body.offeredRates ?? user.offered_rates),
        Boolean(body.pickupAvailable ?? user.pickup_available), text(body.serviceArea ?? user.service_area, 200),changedAuthorization]);
    return result.rows[0];
  }
  if (resource === 'buyers' && method === 'GET') {
    const result = await pool.query(`SELECT id,role,name,location,facility_name,authorization_status,materials_accepted,offered_rates,pickup_available,service_area
      FROM users WHERE id<>$1 AND role IN ('AGGREGATOR','MIDDLEMAN','RECYCLER') AND (role<>'RECYCLER' OR authorization_status='VERIFIED')`, [user.id]);
    return result.rows.filter((buyer) => canBuy(user.role, buyer.role));
  }
  if (resource === 'lots' && method === 'POST') {
    requireRole(user, ['COLLECTOR','AGGREGATOR','MIDDLEMAN']);
    const lotId = id();
    const image = imageFromBody(body.imageBase64);
    const result = await transaction(async (db) => {
      const inserted = await query(db, `INSERT INTO lots(id,creator_id,owner_id,material,category,weight_kg,condition,source_type,location,estimated_value,image_ref,client_ref)
        VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(creator_id,client_ref) WHERE client_ref IS NOT NULL DO UPDATE SET client_ref=EXCLUDED.client_ref RETURNING *`,
        [lotId,user.id,text(body.material,100),text(body.category,100),positive(body.weightKg,'weight'),text(body.condition,100),
          text(body.sourceType,100),text(body.location ?? user.location,200),Number(body.estimatedValue)||0,image?`lot:${lotId}`:null,text(body.clientRef,100)||null]);
      if (image) {
        await query(db,`INSERT INTO lot_images(lot_id,mime_type,image_data) VALUES($1,$2,$3)
          ON CONFLICT(lot_id) DO NOTHING`,[inserted.rows[0].id,image.mimeType,image.bytes]);
        await query(db,`UPDATE lots SET image_ref=$2 WHERE id=$1 AND image_ref IS NULL`,
          [inserted.rows[0].id,`lot:${inserted.rows[0].id}`]);
      }
      if (inserted.rows[0].id === lotId) await event(db, {lot_id: lotId}, user, 'CREATED', null, user.id, Number(body.weightKg), text(body.location ?? user.location,200));
      if (inserted.rows[0].id === lotId && body.predictedMaterial) {
        await query(db,`INSERT INTO ai_feedback(id,lot_id,actor_id,predicted_material,confirmed_material,confidence)
          VALUES($1,$2,$3,$4,$5,$6)`,[id(),lotId,user.id,text(body.predictedMaterial,100),text(body.material,100),
            body.confidence == null ? null : Number(body.confidence)]);
      }
      return inserted.rows[0];
    });
    return result;
  }
  if (resource === 'lots' && method === 'GET') {
    const lotId = url.searchParams.get('id');
    const viewerRole = user.role === 'RECYCLER' && user.authorization_status !== 'VERIFIED' ? 'UNVERIFIED' : user.role;
    const result = await pool.query(`SELECT l.*,owner.role owner_role FROM lots l JOIN users owner ON owner.id=l.owner_id
      WHERE ($1::uuid IS NULL OR l.id=$1)
      AND (l.owner_id=$2 OR ($3 IN ('AGGREGATOR','MIDDLEMAN','RECYCLER') AND l.status='AVAILABLE' AND
      EXISTS (SELECT 1 FROM users s WHERE s.id=l.owner_id AND
      ((s.role='COLLECTOR' AND $3 IN ('AGGREGATOR','MIDDLEMAN','RECYCLER')) OR
       (s.role='AGGREGATOR' AND $3 IN ('MIDDLEMAN','RECYCLER')) OR
       (s.role='MIDDLEMAN' AND $3 IN ('AGGREGATOR','RECYCLER')))))
      OR EXISTS(SELECT 1 FROM offers o WHERE o.lot_id=l.id AND o.buyer_id=$2)) ORDER BY l.created_at DESC`, [lotId,user.id,viewerRole]);
    return lotId ? result.rows[0] || fail(404,'Record not found') : result.rows;
  }
  if (resource === 'image' && method === 'GET') {
    const lotId = url.searchParams.get('lotId');
    const record = (await pool.query(`SELECT l.*,owner.role owner_role FROM lots l JOIN users owner ON owner.id=l.owner_id WHERE l.id=$1`,[lotId])).rows[0];
    if (!record) fail(404,'Image not found');
    const participant = (await pool.query(`SELECT 1 FROM offers WHERE lot_id=$1 AND (buyer_id=$2 OR seller_id=$2) LIMIT 1`,[lotId,user.id])).rowCount > 0;
    const permittedBuyer = user.role !== 'RECYCLER' || user.authorization_status === 'VERIFIED';
    const visible = record.owner_id===user.id || user.role==='ADMIN' || participant ||
      (permittedBuyer && record.status==='AVAILABLE' && canBuy(record.owner_role,user.role));
    if (!visible) fail(403,'Image access denied');
    const stored = (await pool.query(`SELECT mime_type,image_data FROM lot_images WHERE lot_id=$1`,[lotId])).rows[0];
    if (!stored) fail(404,'Image not found');
    return {mimeType:stored.mime_type,base64:Buffer.from(stored.image_data).toString('base64')};
  }
  if (resource === 'batches' && method === 'POST') {
    requireRole(user, ['AGGREGATOR','MIDDLEMAN']);
    const sourceIds = [...new Set((body.sourceLotIds || []).map(String))];
    if (sourceIds.length < 2) fail(400, 'At least two lots required');
    return transaction(async (db) => {
      const source = await query(db, 'SELECT * FROM lots WHERE id=ANY($1::uuid[]) FOR UPDATE', [sourceIds]);
      if (source.rows.length !== sourceIds.length || source.rows.some((lot) => lot.owner_id !== user.id || lot.status !== 'AVAILABLE')) fail(403, 'Lots must be owned and available');
      if (new Set(source.rows.map((lot) => lot.material)).size !== 1) fail(400, 'Materials must match');
      const batchId = id();
      const weight = source.rows.reduce((sum, lot) => sum + Number(lot.weight_kg), 0);
      const batch = await query(db, `INSERT INTO batches(id,owner_id,material,weight_kg,source_lot_ids)
        VALUES($1,$2,$3,$4,$5) RETURNING *`, [batchId,user.id,source.rows[0].material,weight,JSON.stringify(sourceIds)]);
      await query(db, `UPDATE lots SET status='CONSOLIDATED',batch_id=$1 WHERE id=ANY($2::uuid[])`, [batchId,sourceIds]);
      for (const lot of source.rows) await event(db, {lot_id: lot.id}, user, 'CONSOLIDATED', user.id, user.id, lot.weight_kg);
      await event(db, {batch_id: batchId}, user, 'BATCH_CREATED', null, user.id, weight);
      return batch.rows[0];
    });
  }
  if (resource === 'batches' && method === 'GET') {
    const batchId = url.searchParams.get('id');
    const viewerRole = user.role === 'RECYCLER' && user.authorization_status !== 'VERIFIED' ? 'UNVERIFIED' : user.role;
    const result = await pool.query(`SELECT b.*,owner.role owner_role FROM batches b JOIN users owner ON owner.id=b.owner_id
      WHERE ($3::uuid IS NULL OR b.id=$3) AND (b.owner_id=$1 OR (b.status='AVAILABLE' AND
      EXISTS(SELECT 1 FROM users s WHERE s.id=b.owner_id AND
      ((s.role='AGGREGATOR' AND $2 IN ('MIDDLEMAN','RECYCLER')) OR
       (s.role='MIDDLEMAN' AND $2 IN ('AGGREGATOR','RECYCLER')))))
      OR EXISTS(SELECT 1 FROM offers o WHERE o.batch_id=b.id AND o.buyer_id=$1))`, [user.id,viewerRole,batchId]);
    return batchId ? result.rows[0] || fail(404,'Record not found') : result.rows;
  }
  if (resource === 'offers' && method === 'POST') {
    requireRole(user, ['AGGREGATOR','MIDDLEMAN','RECYCLER']);
    if (user.role === 'RECYCLER' && user.authorization_status !== 'VERIFIED') fail(403, 'Recycler verification required');
    return transaction(async (db) => {
      const item = await asset(db, body, true);
      const seller = (await query(db, 'SELECT role FROM users WHERE id=$1', [item.owner_id])).rows[0];
      if (item.status !== 'AVAILABLE' || item.owner_id === user.id || !canBuy(seller.role,user.role)) fail(403, 'Cannot offer for this record');
      if (user.role === 'RECYCLER' && !user.materials_accepted.includes(item.material)) fail(403,'Material is not accepted by recycler');
      const rate = positive(body.rate,'rate');
      const weight = Number(item.weight_kg);
      const until = new Date(body.validUntil);
      if (!Number.isFinite(until.getTime()) || until <= new Date()) fail(400,'Future validUntil required');
      const result = await query(db, `INSERT INTO offers(id,lot_id,batch_id,buyer_id,seller_id,buyer_role,rate,original_rate,unit,expected_weight,quoted_amount,valid_until,pickup_available,pickup_terms,payment_terms,notes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7,'kg',$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [id(),item.lot_id,item.batch_id,user.id,item.owner_id,user.role,rate,weight,rate*weight,until,
          Boolean(body.pickupAvailable),text(body.pickupTerms),text(body.paymentTerms),text(body.notes)]);
      return result.rows[0];
    });
  }
  if (resource === 'offers' && method === 'GET') {
    await pool.query(`UPDATE offers SET status='EXPIRED',updated_at=now() WHERE status IN ('PENDING','COUNTERED') AND valid_until<now()`);
    const result = await pool.query('SELECT * FROM offers WHERE seller_id=$1 OR buyer_id=$1 ORDER BY created_at DESC', [user.id]);
    return result.rows;
  }
  if (resource === 'offers' && method === 'PATCH') {
    return transaction(async (db) => {
      const offer = (await query(db,'SELECT * FROM offers WHERE id=$1 FOR UPDATE',[body.id])).rows[0];
      if (!offer) fail(404,'Offer not found');
      const status = text(body.status,20).toUpperCase();
      if (offer.status === 'COUNTERED' && status === 'PENDING' && offer.buyer_id === user.id && new Date(offer.valid_until) >= new Date()) {
        return (await query(db,`UPDATE offers SET rate=counter_rate,quoted_amount=counter_rate*expected_weight,
          counter_rate=NULL,status='PENDING',updated_at=now() WHERE id=$1 RETURNING *`,[offer.id])).rows[0];
      }
      if (offer.status !== 'PENDING' || new Date(offer.valid_until) < new Date()) fail(409,'Offer unavailable');
      if (status === 'COUNTERED' && offer.seller_id === user.id) {
        const rate = positive(body.counterRate,'counter rate');
        return (await query(db,`UPDATE offers SET counter_rate=$2,status='COUNTERED',updated_at=now()
          WHERE id=$1 RETURNING *`,[offer.id,rate])).rows[0];
      }
      if (status === 'ACCEPTED' && offer.seller_id === user.id) {
        const item = await asset(db, {lotId:offer.lot_id,batchId:offer.batch_id}, true);
        if (item.owner_id !== user.id || item.status !== 'AVAILABLE') fail(409,'Record unavailable');
        await query(db,`UPDATE offers SET status='REJECTED',updated_at=now() WHERE id<>$1 AND status='PENDING' AND ${offer.lot_id ? 'lot_id' : 'batch_id'}=$2`,[offer.id,offer.lot_id || offer.batch_id]);
        await query(db,`UPDATE ${item.table} SET status='IN_HANDOVER' WHERE id=$1`,[item.id]);
        const handover = await query(db,`INSERT INTO handovers(id,offer_id,lot_id,batch_id,seller_id,buyer_id,quoted_rate,quoted_amount)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[id(),offer.id,offer.lot_id,offer.batch_id,user.id,offer.buyer_id,offer.rate,offer.quoted_amount]);
        await query(db,`UPDATE offers SET status='ACCEPTED',updated_at=now() WHERE id=$1`,[offer.id]);
        await event(db,item,user,'OFFER_ACCEPTED',user.id,user.id,item.weight_kg);
        return handover.rows[0];
      }
      if ((status === 'REJECTED' && offer.seller_id === user.id) || (status === 'CANCELLED' && offer.buyer_id === user.id)) {
        return (await query(db,'UPDATE offers SET status=$2,updated_at=now() WHERE id=$1 RETURNING *',[offer.id,status])).rows[0];
      }
      fail(403,'Offer action denied');
    });
  }
  if (resource === 'handovers' && method === 'GET') {
    return (await pool.query('SELECT * FROM handovers WHERE seller_id=$1 OR buyer_id=$1 ORDER BY created_at DESC',[user.id])).rows;
  }
  if (resource === 'handovers' && method === 'PATCH') {
    return transaction(async (db) => {
      const handover = (await query(db,'SELECT * FROM handovers WHERE id=$1 FOR UPDATE',[body.id])).rows[0];
      if (!handover) fail(404,'Handover not found');
      const actionName = text(body.action,30);
      const item = await asset(db,{lotId:handover.lot_id,batchId:handover.batch_id},true);
      if (actionName === 'submit' && handover.seller_id === user.id && handover.status === 'PENDING_HANDOVER') {
        const weight = positive(body.weightKg,'weight');
        const result = await query(db,`UPDATE handovers SET seller_submitted_weight=$2,handover_location=$3,seller_submitted_at=now(),status='SUBMITTED_BY_SELLER' WHERE id=$1 RETURNING *`,[handover.id,weight,text(body.location,200)]);
        await event(db,item,user,'SELLER_SUBMITTED',user.id,user.id,weight,text(body.location,200));
        return result.rows[0];
      }
      if (actionName === 'measure' && handover.buyer_id === user.id && handover.status === 'SUBMITTED_BY_SELLER') {
        const weight = positive(body.weightKg,'weight');
        const rate = body.finalRate == null ? Number(handover.quoted_rate) : positive(body.finalRate,'rate');
        const result = await query(db,`UPDATE handovers SET buyer_measured_weight=$2,final_rate=$3,final_amount=$4,buyer_confirmed_at=now(),status='AWAITING_SELLER_APPROVAL' WHERE id=$1 RETURNING *`,[handover.id,weight,rate,weight*rate]);
        await event(db,item,user,'BUYER_MEASURED',handover.seller_id,handover.seller_id,weight);
        return result.rows[0];
      }
      if (actionName === 'accept' && handover.seller_id === user.id &&
          ['AWAITING_SELLER_APPROVAL','RESOLVED'].includes(handover.status)) {
        await query(db,`UPDATE ${item.table} SET owner_id=$2,weight_kg=$3,status='AVAILABLE' WHERE id=$1`,
          [item.id,handover.buyer_id,handover.buyer_measured_weight]);
        const result = await query(db,`UPDATE handovers SET seller_accepted_at=now(),status='COMPLETED' WHERE id=$1 RETURNING *`,[handover.id]);
        await query(db,`INSERT INTO payments(id,handover_id,payer_id,payee_id,amount) VALUES($1,$2,$3,$4,$5)`,[id(),handover.id,handover.buyer_id,user.id,handover.final_amount]);
        await event(db,item,user,'OWNERSHIP_TRANSFERRED',user.id,handover.buyer_id,handover.buyer_measured_weight);
        return result.rows[0];
      }
      if (actionName === 'dispute' && handover.seller_id === user.id && handover.status === 'AWAITING_SELLER_APPROVAL') {
        const reason = text(body.reason,200);
        if (!reason) fail(400,'Reason required');
        const dispute = await query(db,`INSERT INTO disputes(id,handover_id,raised_by,reason,seller_claim,evidence_ref)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[id(),handover.id,user.id,reason,text(body.sellerClaim),text(body.evidenceRef,500)]);
        await query(db,`UPDATE handovers SET status='DISPUTED' WHERE id=$1`,[handover.id]);
        await event(db,item,user,'DISPUTED',user.id,user.id,handover.buyer_measured_weight);
        return dispute.rows[0];
      }
      fail(403,'Handover action denied');
    });
  }
  if (resource === 'payments' && method === 'GET') return (await pool.query('SELECT * FROM payments WHERE payer_id=$1 OR payee_id=$1',[user.id])).rows;
  if (resource === 'recycling' && method === 'GET') {
    requireRole(user,['RECYCLER','ADMIN']);
    return (await pool.query(`SELECT r.*,u.facility_name,u.authorization_status,
      COALESCE(l.material,b.material) material,COALESCE(l.weight_kg,b.weight_kg) weight_kg
      FROM recycling r JOIN users u ON u.id=r.recycler_id LEFT JOIN lots l ON l.id=r.lot_id
      LEFT JOIN batches b ON b.id=r.batch_id WHERE r.recycler_id=$1 OR $2='ADMIN'`,[user.id,user.role])).rows;
  }
  if (resource === 'recycling' && method === 'PATCH') {
    requireRole(user,['RECYCLER']);
    if (user.authorization_status !== 'VERIFIED') fail(403,'Recycler verification required');
    return transaction(async (db) => {
      const item = await asset(db,body,true);
      if (item.owner_id !== user.id) fail(403,'Recycler must own record');
      const last = (await query(db,`SELECT * FROM recycling WHERE ${item.lot_id ? 'lot_id' : 'batch_id'}=$1 FOR UPDATE`,[item.id])).rows[0];
      const status = text(body.status,20).toUpperCase();
      const next = {RECEIVED:'SORTED',SORTED:'PROCESSING',PROCESSING:'RECYCLED'};
      if (last && next[last.status] !== status) fail(409,'Invalid processing transition');
      if (!last && status !== 'RECEIVED') fail(409,'Receive record first');
      if (!last) {
        const result = await query(db,`INSERT INTO recycling(id,lot_id,batch_id,recycler_id) VALUES($1,$2,$3,$4) RETURNING *`,
          [id(),item.lot_id,item.batch_id,user.id]);
        await event(db,item,user,'RECEIVED',user.id,user.id,item.weight_kg);
        return result.rows[0];
      }
      const certificate = status === 'RECYCLED' ? id() : null;
      const result = await query(db,`UPDATE recycling SET status=$2,processed_at=CASE WHEN $2='RECYCLED' THEN now() ELSE processed_at END,
        certificate_id=COALESCE($3,certificate_id) WHERE id=$1 RETURNING *`,[last.id,status,certificate]);
      await event(db,item,user,status,user.id,user.id,item.weight_kg);
      return result.rows[0];
    });
  }
  if (resource === 'payments' && method === 'PATCH') {
    return transaction(async (db) => {
      const payment = (await query(db,'SELECT * FROM payments WHERE id=$1 FOR UPDATE',[body.id])).rows[0];
      if (!payment || payment.payer_id !== user.id) fail(403,'Payment action denied');
      if (payment.status === 'PAID') fail(409,'Already paid');
      const status = text(body.status,20).toUpperCase();
      if (!['PROCESSING','PAID','FAILED'].includes(status)) fail(400,'Invalid payment status');
      return (await query(db,'UPDATE payments SET status=$2,updated_at=now() WHERE id=$1 RETURNING *',[payment.id,status])).rows[0];
    });
  }
  if (resource === 'disputes' && method === 'GET') {
    const result = await pool.query(`SELECT d.* FROM disputes d JOIN handovers h ON h.id=d.handover_id
      WHERE $2='ADMIN' OR h.seller_id=$1 OR h.buyer_id=$1 ORDER BY d.created_at DESC`,[user.id,user.role]);
    return result.rows;
  }
  if (resource === 'disputes' && method === 'POST') {
    return transaction(async (db) => {
      const handover = (await query(db,'SELECT * FROM handovers WHERE id=$1 FOR UPDATE',[body.handoverId])).rows[0];
      if (!handover || handover.seller_id !== user.id || handover.status !== 'COMPLETED') fail(403,'Dispute action denied');
      const reason = text(body.reason,200);
      if (!reason) fail(400,'Reason required');
      const existing = await query(db,`SELECT 1 FROM disputes WHERE handover_id=$1 AND status IN ('OPEN','UNDER_REVIEW') LIMIT 1`,[handover.id]);
      if (existing.rowCount) fail(409,'Dispute already open');
      const dispute = (await query(db,`INSERT INTO disputes(id,handover_id,raised_by,reason,seller_claim,evidence_ref)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[id(),handover.id,user.id,reason,text(body.sellerClaim),text(body.evidenceRef,500)])).rows[0];
      await audit(db,user,'PAYMENT_DISPUTED','handover',handover.id);
      return dispute;
    });
  }
  if (resource === 'disputes' && method === 'PATCH') {
    return transaction(async (db) => {
      const dispute = (await query(db,'SELECT * FROM disputes WHERE id=$1 FOR UPDATE',[body.id])).rows[0];
      if (!dispute) fail(404,'Dispute not found');
      const handover = (await query(db,'SELECT * FROM handovers WHERE id=$1 FOR UPDATE',[dispute.handover_id])).rows[0];
      if (body.action === 'respond' && handover.buyer_id === user.id && dispute.status === 'OPEN') {
        return (await query(db,`UPDATE disputes SET buyer_response=$2,status='UNDER_REVIEW' WHERE id=$1 RETURNING *`,
          [dispute.id,text(body.buyerResponse,1000)])).rows[0];
      }
      requireRole(user,['ADMIN']);
      const status = text(body.status,20).toUpperCase();
      if (!['UNDER_REVIEW','RESOLVED','REJECTED'].includes(status) || !['OPEN','UNDER_REVIEW'].includes(dispute.status)) fail(409,'Invalid dispute transition');
      const result = await query(db,`UPDATE disputes SET status=$2,admin_resolution=$3 WHERE id=$1 RETURNING *`,
        [dispute.id,status,text(body.adminResolution,1000)]);
      if (status === 'RESOLVED' && handover.status === 'DISPUTED') {
        const weight = body.finalWeightKg == null ? Number(handover.buyer_measured_weight) : positive(body.finalWeightKg,'weight');
        const rate = body.finalRate == null ? Number(handover.final_rate) : positive(body.finalRate,'rate');
        await query(db,`UPDATE handovers SET buyer_measured_weight=$2,final_rate=$3,final_amount=$4,status='RESOLVED' WHERE id=$1`,
          [handover.id,weight,rate,weight*rate]);
      }
      if (status === 'REJECTED' && handover.status === 'DISPUTED')
        await query(db,`UPDATE handovers SET status='AWAITING_SELLER_APPROVAL' WHERE id=$1`,[handover.id]);
      await audit(db,user,'DISPUTE_REVIEWED','dispute',dispute.id,{status});
      return result.rows[0];
    });
  }
  if (resource === 'traceability' && method === 'GET') {
    const item = await asset(pool,{lotId:url.searchParams.get('lotId'),batchId:url.searchParams.get('batchId')});
    const participant = item.owner_id === user.id || user.role === 'ADMIN' ||
      (await pool.query(`SELECT 1 FROM offers WHERE (lot_id=$1 OR batch_id=$2) AND (buyer_id=$3 OR seller_id=$3) LIMIT 1`,[item.lot_id,item.batch_id,user.id])).rowCount > 0;
    if (!participant) fail(403,'Traceability access denied');
    const sourceIds = item.batch_id ? item.source_lot_ids : [];
    return (await pool.query(`SELECT * FROM trace_events WHERE lot_id=ANY($1::uuid[]) OR lot_id=$2 OR batch_id=$3 ORDER BY created_at,id`,[sourceIds,item.lot_id,item.batch_id])).rows;
  }
  if (resource === 'ledger' && method === 'GET') {
    const result = await pool.query(`SELECT
      COALESCE(SUM(CASE WHEN h.seller_id=$1 THEN h.final_amount END),0) sales_revenue,
      COALESCE(SUM(CASE WHEN h.buyer_id=$1 THEN h.final_amount END),0) purchase_cost,
      COALESCE(SUM(CASE WHEN p.payee_id=$1 AND p.status='PAID' THEN p.amount END),0) sales_received,
      COALESCE(SUM(CASE WHEN p.payee_id=$1 AND p.status<>'PAID' THEN p.amount END),0) pending_receivables,
      COALESCE(SUM(CASE WHEN p.payer_id=$1 AND p.status<>'PAID' THEN p.amount END),0) pending_payables
      FROM handovers h LEFT JOIN payments p ON p.handover_id=h.id
      WHERE h.status='COMPLETED' AND (h.seller_id=$1 OR h.buyer_id=$1)`,[user.id]);
    const values = result.rows[0];
    const inventory = await pool.query(`SELECT COALESCE(SUM(h.final_amount),0) cost FROM handovers h
      WHERE h.buyer_id=$1 AND h.status='COMPLETED' AND
      ((h.lot_id IS NOT NULL AND EXISTS(SELECT 1 FROM lots l WHERE l.id=h.lot_id AND l.owner_id=$1 AND l.status='AVAILABLE')) OR
       (h.batch_id IS NOT NULL AND EXISTS(SELECT 1 FROM batches b WHERE b.id=h.batch_id AND b.owner_id=$1 AND b.status='AVAILABLE')) OR
       (h.lot_id IS NOT NULL AND EXISTS(SELECT 1 FROM batches b WHERE b.owner_id=$1 AND b.status='AVAILABLE' AND b.source_lot_ids ? h.lot_id::text)))`,[user.id]);
    return {...values, inventoryCost:inventory.rows[0].cost,
      grossMargin: Number(values.sales_revenue)-Number(values.purchase_cost)};
  }
  if (resource === 'inventory' && method === 'GET') {
    requireRole(user,['AGGREGATOR','MIDDLEMAN','RECYCLER']);
    const [lots,batches] = await Promise.all([
      pool.query(`SELECT * FROM lots WHERE owner_id=$1 AND status='AVAILABLE'`,[user.id]),
      pool.query(`SELECT * FROM batches WHERE owner_id=$1 AND status='AVAILABLE'`,[user.id])
    ]);
    return {lots:lots.rows,batches:batches.rows};
  }
  if (resource === 'price-board' && method === 'GET') {
    return (await pool.query(`SELECT DISTINCT ON (material_id,location) material_id,location,rate,unit,created_at
      FROM price_records ORDER BY material_id,location,created_at DESC`)).rows;
  }
  if (resource === 'catalog' && method === 'GET') {
    return (await pool.query(`SELECT * FROM material_catalog ORDER BY category,subcategory,id`)).rows;
  }
  if (resource === 'admin' && method === 'GET') {
    requireRole(user,['ADMIN']);
    const kind = url.searchParams.get('kind') || 'dashboard';
    const tables = {users:'users',lots:'lots',batches:'batches',offers:'offers',handovers:'handovers',payments:'payments',disputes:'disputes',traceability:'trace_events',recycling:'recycling',materials:'material_catalog',categories:'categories',prices:'price_records',feedback:'ai_feedback',knowledge:'dismantling_knowledge',audit:'audit_logs'};
    if (kind === 'dashboard') {
      const counts = await pool.query(`SELECT role,count(*)::int FROM users GROUP BY role`);
      const summary = await pool.query(`SELECT
        (SELECT count(*)::int FROM lots WHERE status='AVAILABLE') active_lots,
        (SELECT count(*)::int FROM batches WHERE status='AVAILABLE') active_batches,
        (SELECT count(*)::int FROM disputes WHERE status IN ('OPEN','UNDER_REVIEW')) open_disputes,
        (SELECT count(*)::int FROM users WHERE role='RECYCLER' AND authorization_status='VERIFIED') verified_recyclers,
        (SELECT COALESCE(sum(amount),0) FROM payments WHERE status='PAID') transaction_volume,
        (SELECT COALESCE(sum(amount),0) FROM payments WHERE status<>'PAID') pending_payments,
        (SELECT COALESCE(sum(COALESCE(l.weight_kg,b.weight_kg)),0) FROM recycling r
          LEFT JOIN lots l ON l.id=r.lot_id LEFT JOIN batches b ON b.id=r.batch_id
          WHERE r.status='RECYCLED') completed_recycling_weight`);
      return {roles:Object.fromEntries(counts.rows.map((row)=>[row.role,row.count])),...summary.rows[0]};
    }
    if (kind === 'roles') return (await pool.query(`SELECT role,count(*)::int users FROM users GROUP BY role ORDER BY role`)).rows;
    if (kind === 'recyclers') return (await pool.query(`SELECT id,name,facility_name,authorization_number,
      authorization_status,materials_accepted,offered_rates,pickup_available,service_area,created_at
      FROM users WHERE role='RECYCLER' ORDER BY created_at DESC`)).rows;
    if (kind === 'transactions') return (await pool.query(`SELECT h.*,p.status payment_status
      FROM handovers h LEFT JOIN payments p ON p.handover_id=h.id ORDER BY h.created_at DESC LIMIT 500`)).rows;
    if (kind === 'datasets') return ['materials','prices','buyers','transactions','transfers','traceability','feedback','recyclers','recycling'];
    if (!tables[kind]) fail(400,'Unknown admin module');
    const columns = kind === 'users' ? 'id,email,role,name,language,location,facility_name,authorization_number,authorization_status,materials_accepted,offered_rates,pickup_available,service_area,created_at' : '*';
    return (await pool.query(`SELECT ${columns} FROM ${tables[kind]} ORDER BY created_at DESC LIMIT 500`)).rows;
  }
  if (resource === 'admin' && method === 'POST') {
    requireRole(user,['ADMIN']);
    if (action === 'category') return transaction(async (db) => {
      const record = (await query(db,'INSERT INTO categories(id,name) VALUES($1,$2) RETURNING *',
        [text(body.id,100),text(body.name,100)])).rows[0];
      await audit(db,user,'CATEGORY_CREATED','category',record.id);
      return record;
    });
    if (action === 'material') return transaction(async (db) => {
      const record = (await query(db,`INSERT INTO material_catalog(id,category,subcategory,description)
        VALUES($1,$2,$3,$4) RETURNING *`,[text(body.id,100),text(body.category,100),text(body.subcategory,100),text(body.description,1000)])).rows[0];
      await audit(db,user,'MATERIAL_CREATED','material',record.id);
      return record;
    });
    if (action === 'price') return transaction(async (db) => {
      const record = (await query(db,`INSERT INTO price_records(id,material_id,location,rate,recorded_by)
        VALUES($1,$2,$3,$4,$5) RETURNING *`,[id(),text(body.materialId,100),text(body.location,200),positive(body.rate,'rate'),user.id])).rows[0];
      await audit(db,user,'PRICE_RECORDED','price',record.id);
      return record;
    });
    if (action === 'knowledge') return transaction(async (db) => {
      const record = (await query(db,`INSERT INTO dismantling_knowledge(id,material_id,guidance,updated_by)
        VALUES($1,$2,$3,$4) RETURNING *`,[id(),text(body.materialId,100),text(body.guidance,2000),user.id])).rows[0];
      await audit(db,user,'KNOWLEDGE_CREATED','knowledge',record.id);
      return record;
    });
    fail(400,'Unknown admin action');
  }
  if (resource === 'admin' && method === 'PATCH') {
    requireRole(user,['ADMIN']);
    if (action === 'set-role') {
      const role = text(body.role,20).toUpperCase();
      if (!['COLLECTOR','AGGREGATOR','MIDDLEMAN','RECYCLER'].includes(role)) fail(400,'Invalid role');
      return transaction(async (db) => {
        const record = (await query(db,`UPDATE users SET role=$2,authorization_status='UNVERIFIED' WHERE id=$1 AND role<>'ADMIN'
          RETURNING id,role,authorization_status`,[body.id,role])).rows[0] || fail(404,'User not found');
        await audit(db,user,'ROLE_CHANGED','user',record.id,{role});return record;
      });
    }
    if (action === 'verify-recycler') {
      const status = text(body.status,20).toUpperCase();
      if (!['VERIFIED','REJECTED','UNVERIFIED'].includes(status)) fail(400,'Invalid status');
      return transaction(async (db) => {
        if (status === 'VERIFIED') {
          const recycler = (await query(db,`SELECT facility_name,authorization_number FROM users WHERE id=$1 AND role='RECYCLER'`,[body.id])).rows[0];
          if (!recycler || !recycler.facility_name || !recycler.authorization_number) fail(400,'Facility and authorization number required');
        }
        const record = (await query(db,`UPDATE users SET authorization_status=$2 WHERE id=$1 AND role='RECYCLER'
          RETURNING id,role,authorization_status`,[body.id,status])).rows[0] || fail(404,'Recycler not found');
        await audit(db,user,'RECYCLER_VERIFIED','user',record.id,{status});return record;
      });
    }
    fail(400,'Unknown admin action');
  }
  if (resource === 'export' && method === 'GET') {
    requireRole(user,['ADMIN']);
    const kind = url.searchParams.get('kind');
    const datasets = {
      materials: `SELECT l.id,l.material,l.category,m.subcategory,m.description,l.weight_kg,l.condition,l.source_type,
        l.estimated_value,l.image_ref,l.created_at FROM lots l LEFT JOIN material_catalog m ON m.id=l.material`,
      prices: `SELECT o.id,o.lot_id,o.batch_id,o.buyer_id,o.seller_id,COALESCE(l.location,'') location,
        o.original_rate quoted_rate,o.rate accepted_rate,o.unit,o.quoted_amount,h.final_rate,h.final_amount,o.created_at
        FROM offers o LEFT JOIN handovers h ON h.offer_id=o.id LEFT JOIN lots l ON l.id=o.lot_id`,
      transactions: `SELECT h.id,h.lot_id,h.batch_id,h.seller_id,s.role seller_role,h.buyer_id,b.role buyer_role,
        h.buyer_measured_weight,h.final_amount,h.status,p.status payment_status,h.created_at
        FROM handovers h JOIN users s ON s.id=h.seller_id JOIN users b ON b.id=h.buyer_id
        LEFT JOIN payments p ON p.handover_id=h.id`,
      transfers: `SELECT h.id transfer_id,h.lot_id,h.batch_id,h.seller_id from_user,s.role from_role,
        h.buyer_id to_user,b.role to_role,h.buyer_measured_weight weight_kg,h.final_amount amount,
        h.seller_accepted_at transferred_at,h.status FROM handovers h
        JOIN users s ON s.id=h.seller_id JOIN users b ON b.id=h.buyer_id WHERE h.status='COMPLETED'`,
      traceability: `SELECT * FROM trace_events`,
      recyclers: `SELECT id,role,facility_name,authorization_status,materials_accepted,offered_rates,pickup_available,service_area FROM users WHERE role='RECYCLER'`,
      buyers: `SELECT id,role,materials_accepted,location,service_area,offered_rates,authorization_status
        FROM users WHERE role IN ('AGGREGATOR','MIDDLEMAN','RECYCLER')`,
      feedback: `SELECT id,lot_id,predicted_material,confirmed_material,confidence,created_at FROM ai_feedback`,
      recycling: `SELECT r.certificate_id,r.recycler_id,r.lot_id,r.batch_id,COALESCE(l.material,b.material) material,
        COALESCE(l.weight_kg,b.weight_kg) weight_kg,r.received_at,r.processed_at,r.status
        FROM recycling r LEFT JOIN lots l ON l.id=r.lot_id LEFT JOIN batches b ON b.id=r.batch_id`
    };
    if (!datasets[kind]) fail(400,'Unknown dataset');
    const rows = (await pool.query(datasets[kind])).rows;
    await audit(pool,user,'DATASET_EXPORTED','dataset',kind,{rows:rows.length});
    return { dataset: kind, rows };
  }
  fail(404,'Endpoint not found');
}
module.exports = { route, pool, canBuy, passwordHash, verifyPassword };
