import crypto from 'node:crypto';
// Reuse the existing notification inbox. Deterministic IDs make transactional replay quiet.
export async function notifySaas(c,userId,key,title,body='',href='/app?view=settings') {
  const hex=crypto.createHash('sha256').update(`${userId}:${key}`).digest('hex').slice(0,32);
  const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  await c.query("INSERT INTO ysong_notifications(id,user_id,kind,entity_type,entity_id,title,body,href) VALUES($1,$2,'saas','saas',$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING",[id,userId,key,title,body,href]);
}
