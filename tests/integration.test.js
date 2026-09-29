const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { route, pool, passwordHash } = require('../lib/marketplace');

async function main() {
  const database = new PGlite();
  await database.exec(fs.readFileSync(require('node:path').join(__dirname,'../schema.sql'),'utf8'));
  pool.query = (sql, values) => database.query(sql, values);
  pool.connect = async () => ({ query: (sql, values) => database.query(sql, values), release() {} });
  const call = (resource, method, token, body = {}, extra = '') =>
    route({method,url:`/marketplace?resource=${resource}${extra}`,headers:{authorization: token ? `Bearer ${token}` : ''}},body);
  async function account(role, suffix = '') {
    const email = `${role.toLowerCase()}${suffix}@example.test`;
    const result = await call('auth','POST',null,{email,password:'Strong password 123',
      name:role,role,language:'en',location:'Pune'},'&action=register');
    assert.equal(result.user.role, role);
    assert.equal((await call('me','GET',result.token)).email, email);
    return result.token;
  }
  const collector = await account('COLLECTOR');
  const otherCollector = await account('COLLECTOR','other');
  const aggregator = await account('AGGREGATOR');
  const middleman = await account('MIDDLEMAN');
  const recycler = await account('RECYCLER');
  const pendingRecycler = await account('RECYCLER','pending');
  await assert.rejects(call('auth','POST',null,{email:'collector@example.test',
    password:'Strong password 123',name:'Duplicate',role:'COLLECTOR',language:'en',location:'Pune'},
    '&action=register'),{code:'23505'});
  await assert.rejects(call('auth','POST',null,{email:'bad',password:'short',
    name:'Bad',role:'COLLECTOR',language:'en',location:'Pune'},'&action=register'),{status:400});
  const adminId = crypto.randomUUID();
  await database.query(`INSERT INTO users(id,email,password_hash,role,name) VALUES($1,$2,$3,'ADMIN','Admin')`,
    [adminId,'admin@example.test',passwordHash('Strong password 123')]);
  const admin = (await call('auth','POST',null,{email:'admin@example.test',password:'Strong password 123'},'&action=login')).token;
  const collectorId = (await call('me','GET',collector)).id;
  const aggregatorId = (await call('me','GET',aggregator)).id;
  const middlemanId = (await call('me','GET',middleman)).id;
  const recyclerId = (await call('me','GET',recycler)).id;
  await call('me','PATCH',recycler,{facilityName:'North Plant',authorizationNumber:'AUTH-001',
    materialsAccepted:['copper','steel','aluminium']});
  await call('admin','PATCH',admin,{id:recyclerId,status:'VERIFIED'},'&action=verify-recycler');
  await call('admin','POST',admin,{id:'metals',name:'Metals'},'&action=category');
  await call('admin','POST',admin,{id:'copper',category:'metals',description:'Copper scrap'},'&action=material');
  await call('admin','POST',admin,{materialId:'copper',location:'Pune',rate:100},'&action=price');
  assert.equal(Number((await call('price-board','GET',collector))[0].rate),100);
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9l8h8AAAAASUVORK5CYII=';
  const lot = await call('lots','POST',collector,{clientRef:'phone-a-001',material:'copper',weightKg:5,estimatedValue:500,location:'Pune',imageBase64});
  assert.equal((await call('lots','GET',pendingRecycler)).length,0);
  await assert.rejects(call('image','GET',pendingRecycler,{},`&lotId=${lot.id}`),{status:403});
  assert.equal((await call('image','GET',aggregator,{},`&lotId=${lot.id}`)).base64,imageBase64);
  await assert.rejects(call('image','GET',otherCollector,{},`&lotId=${lot.id}`),{status:403});
  assert.equal((await call('lots','POST',collector,{clientRef:'phone-a-001',material:'copper',weightKg:5})).id,lot.id);
  assert.ok((await call('lots','GET',aggregator)).some((record)=>record.id===lot.id));
  assert.ok((await call('lots','GET',middleman)).some((record)=>record.id===lot.id));
  await assert.rejects(call('lots','GET',collector,{},`&id=${crypto.randomUUID()}`),{status:404});
  await assert.rejects(call('offers','POST',collector,{lotId:lot.id,rate:100,validUntil:new Date(Date.now()+86400000).toISOString()}),{status:403});
  const offer = await call('offers','POST',aggregator,{lotId:lot.id,rate:100,validUntil:new Date(Date.now()+86400000).toISOString()});
  assert.equal(offer.buyer_id,aggregatorId);
  assert.equal((await call('offers','GET',collector))[0].id,offer.id);
  assert.equal((await call('offers','GET',middleman)).length,0);
  await assert.rejects(call('offers','PATCH',middleman,{id:offer.id,status:'ACCEPTED'}),{status:403});
  const handover = await call('offers','PATCH',collector,{id:offer.id,status:'ACCEPTED'});
  await assert.rejects(call('handovers','PATCH',aggregator,{id:handover.id,action:'measure',weightKg:4}),{status:403});
  await call('handovers','PATCH',collector,{id:handover.id,action:'submit',weightKg:5,location:'Pune'});
  const measured = await call('handovers','PATCH',aggregator,{id:handover.id,action:'measure',weightKg:4.5});
  assert.equal(Number(measured.final_amount),450);
  assert.equal(measured.status,'AWAITING_SELLER_APPROVAL');
  assert.equal((await call('lots','GET',collector,{},`&id=${lot.id}`)).owner_id,collectorId);
  await assert.rejects(call('handovers','PATCH',aggregator,{id:handover.id,action:'accept'}),{status:403});
  await call('handovers','PATCH',collector,{id:handover.id,action:'accept'});
  assert.equal((await call('lots','GET',aggregator,{},`&id=${lot.id}`)).owner_id,aggregatorId);
  let payments = await call('payments','GET',aggregator);
  assert.equal(payments.length,1);
  assert.equal(payments[0].status,'PENDING');
  await call('payments','PATCH',aggregator,{id:payments[0].id,status:'PAID'});
  assert.equal(Number((await call('ledger','GET',collector)).sales_received),450);
  assert.equal(Number((await call('ledger','GET',aggregator)).purchase_cost),450);

  const another = await call('lots','POST',collector,{material:'copper',weightKg:8});
  const secondOffer = await call('offers','POST',aggregator,{lotId:another.id,rate:100,validUntil:new Date(Date.now()+86400000).toISOString()});
  const secondHandover = await call('offers','PATCH',collector,{id:secondOffer.id,status:'ACCEPTED'});
  await call('handovers','PATCH',collector,{id:secondHandover.id,action:'submit',weightKg:8});
  await call('handovers','PATCH',aggregator,{id:secondHandover.id,action:'measure',weightKg:8});
  await call('handovers','PATCH',collector,{id:secondHandover.id,action:'accept'});
  const batch = await call('batches','POST',aggregator,{sourceLotIds:[lot.id,another.id]});
  assert.equal(Number(batch.weight_kg),12.5);
  assert.deepEqual(new Set(batch.source_lot_ids),new Set([lot.id,another.id]));
  const batchOffer = await call('offers','POST',middleman,{batchId:batch.id,rate:120,validUntil:new Date(Date.now()+86400000).toISOString()});
  const batchHandover = await call('offers','PATCH',aggregator,{id:batchOffer.id,status:'ACCEPTED'});
  await call('handovers','PATCH',aggregator,{id:batchHandover.id,action:'submit',weightKg:12.5});
  await call('handovers','PATCH',middleman,{id:batchHandover.id,action:'measure',weightKg:12.5});
  await call('handovers','PATCH',aggregator,{id:batchHandover.id,action:'accept'});
  const ledger = await call('ledger','GET',aggregator);
  assert.equal(Number(ledger.sales_revenue),1500);
  assert.equal(Number(ledger.purchase_cost),1250);
  assert.equal(Number(ledger.grossMargin),250);
  assert.equal(Number(ledger.inventoryCost),0);
  assert.equal(Number((await call('ledger','GET',middleman)).inventoryCost),1500);
  assert.equal((await call('inventory','GET',middleman)).batches.length,1);
  const trace = await call('traceability','GET',middleman,{},`&batchId=${batch.id}`);
  assert.ok(trace.some((row)=>row.event_type==='CONSOLIDATED' && row.lot_id===lot.id));
  assert.ok(trace.some((row)=>row.event_type==='OWNERSHIP_TRANSFERRED' && row.batch_id===batch.id));

  const recyclerOffer = await call('offers','POST',recycler,{batchId:batch.id,rate:130,validUntil:new Date(Date.now()+86400000).toISOString()});
  const recyclerHandover = await call('offers','PATCH',middleman,{id:recyclerOffer.id,status:'ACCEPTED'});
  await call('handovers','PATCH',middleman,{id:recyclerHandover.id,action:'submit',weightKg:12.5});
  await call('handovers','PATCH',recycler,{id:recyclerHandover.id,action:'measure',weightKg:12.5});
  await call('handovers','PATCH',middleman,{id:recyclerHandover.id,action:'accept'});
  await call('recycling','PATCH',recycler,{batchId:batch.id,status:'RECEIVED'});
  await call('recycling','PATCH',recycler,{batchId:batch.id,status:'SORTED'});
  await call('recycling','PATCH',recycler,{batchId:batch.id,status:'PROCESSING'});
  const recycled = await call('recycling','PATCH',recycler,{batchId:batch.id,status:'RECYCLED'});
  assert.ok(recycled.certificate_id);

  const directLot = await call('lots','POST',collector,{material:'steel',weightKg:6});
  const directPurchase = await call('offers','POST',aggregator,{lotId:directLot.id,rate:20,validUntil:new Date(Date.now()+86400000).toISOString()});
  const directPurchaseHandover = await call('offers','PATCH',collector,{id:directPurchase.id,status:'ACCEPTED'});
  await call('handovers','PATCH',collector,{id:directPurchaseHandover.id,action:'submit',weightKg:6});
  await call('handovers','PATCH',aggregator,{id:directPurchaseHandover.id,action:'measure',weightKg:6});
  await call('handovers','PATCH',collector,{id:directPurchaseHandover.id,action:'accept'});
  const directSale = await call('offers','POST',recycler,{lotId:directLot.id,rate:30,validUntil:new Date(Date.now()+86400000).toISOString()});
  const directSaleHandover = await call('offers','PATCH',aggregator,{id:directSale.id,status:'ACCEPTED'});
  await call('handovers','PATCH',aggregator,{id:directSaleHandover.id,action:'submit',weightKg:6});
  await call('handovers','PATCH',recycler,{id:directSaleHandover.id,action:'measure',weightKg:6});
  await call('handovers','PATCH',aggregator,{id:directSaleHandover.id,action:'accept'});
  assert.equal((await call('lots','GET',recycler,{},`&id=${directLot.id}`)).owner_id,recyclerId);
  const paymentDispute = await call('disputes','POST',aggregator,
    {handoverId:directSaleHandover.id,reason:'Payment differs'});
  await call('disputes','PATCH',admin,{id:paymentDispute.id,status:'RESOLVED',adminResolution:'Payment record reviewed'});
  assert.equal((await call('handovers','GET',aggregator)).find((row)=>row.id===directSaleHandover.id).status,'COMPLETED');
  await call('me','PATCH',recycler,{authorizationNumber:'AUTH-002'});
  assert.equal((await call('me','GET',recycler)).authorizationStatus,'UNVERIFIED');

  const disputedLot = await call('lots','POST',collector,{material:'aluminium',predictedMaterial:'steel',confidence:.72,weightKg:3});
  const disputedOffer = await call('offers','POST',aggregator,{lotId:disputedLot.id,rate:50,validUntil:new Date(Date.now()+86400000).toISOString()});
  const disputedHandover = await call('offers','PATCH',collector,{id:disputedOffer.id,status:'ACCEPTED'});
  await call('handovers','PATCH',collector,{id:disputedHandover.id,action:'submit',weightKg:3});
  await call('handovers','PATCH',aggregator,{id:disputedHandover.id,action:'measure',weightKg:2});
  const dispute = await call('handovers','PATCH',collector,{id:disputedHandover.id,action:'dispute',reason:'Weight differs'});
  assert.equal(dispute.status,'OPEN');
  await call('disputes','PATCH',aggregator,{id:dispute.id,action:'respond',buyerResponse:'Scale calibrated'});
  await assert.rejects(call('disputes','PATCH',aggregator,{id:dispute.id,status:'RESOLVED'}),{status:403});
  await call('disputes','PATCH',admin,{id:dispute.id,status:'RESOLVED',adminResolution:'Reweigh agreed',finalWeightKg:2.5});
  assert.equal((await call('lots','GET',collector,{},`&id=${disputedLot.id}`)).owner_id,collectorId);
  await call('handovers','PATCH',collector,{id:disputedHandover.id,action:'accept'});
  assert.equal((await call('lots','GET',aggregator,{},`&id=${disputedLot.id}`)).owner_id,aggregatorId);
  await assert.rejects(call('export','GET',collector,{},'&kind=materials'),{status:403});
  assert.ok((await call('export','GET',admin,{},'&kind=materials')).rows.length >= 3);
  assert.ok((await call('export','GET',admin,{},'&kind=transfers')).rows.length >= 3);
  assert.equal((await call('export','GET',admin,{},'&kind=feedback')).rows[0].confirmed_material,'aluminium');
  assert.equal((await call('admin','GET',admin,{},'&kind=dashboard')).roles.MIDDLEMAN,1);
  await database.close();
  await pool.end();
  console.log('Cross-account marketplace integration passed');
}
main().catch((error)=>{console.error(error);process.exitCode=1;pool.end();});
