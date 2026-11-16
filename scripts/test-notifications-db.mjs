import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(
  process.env.PRODUCT_DB_TEST_MODULE || '@electric-sql/pglite'
);
const db = new PGlite();
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let passed = 0;
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
};
const user = async (n) => {
  await q(
    "SELECT set_config('test.user',$1,false),set_config('test.session',$2,false)",
    [id(n), id(100 + n)],
  );
};
try {
  await db.exec(
    `CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.user',true),'')::uuid $$;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object('session_id',current_setting('test.session',true),'role','authenticated') $$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
 CREATE TABLE alumni(id uuid PRIMARY KEY,user_id uuid,batch text,batch_status text,graduation_year integer,name text,full_name text,avatar text,consents jsonb);
 CREATE TABLE alumni_private(LIKE alumni INCLUDING ALL);
 CREATE TABLE scoreboard(alumni_id uuid,user_id uuid,coin numeric,energy numeric);
 CREATE TABLE users(user_id uuid,deactivated boolean);
 CREATE TABLE admin_roles(user_id uuid);
 CREATE TABLE alumni_verification(id bigint GENERATED ALWAYS AS IDENTITY,alumni_id uuid);
 CREATE TABLE support_tickets(id uuid PRIMARY KEY,user_id uuid);
 CREATE TABLE ticket_replies(id uuid PRIMARY KEY,ticket_id uuid,user_id uuid,is_admin_reply boolean);
 CREATE TABLE berita(id uuid PRIMARY KEY,publication_date date,title text);
 CREATE TABLE komunitas_member(komunitas_id uuid,alumni_id uuid);
 CREATE TABLE kegiatan(id uuid PRIMARY KEY,komunitas_id uuid);
 CREATE TABLE kegiatan_verification(id bigint GENERATED ALWAYS AS IDENTITY,kegiatan_id uuid);
 `,
  );
  await db.exec(
    await readFile(
      new URL('../supabase/migrations/006_notifications.sql', import.meta.url),
      'utf8',
    ),
  );
  await db.exec(await readFile(new URL('../supabase/migrations/007_profile_identity.sql', import.meta.url), 'utf8'));
  for (const n of [1, 2, 3, 4]) {
    await q('INSERT INTO auth.users VALUES($1)', [id(n)]);
    await q('INSERT INTO auth.sessions VALUES($1,$2)', [id(100 + n), id(n)]);
    await q("INSERT INTO alumni(id,user_id,batch_status,graduation_year) VALUES($1,$2,'alumni',2006)", [id(200 + n), id(n)]);
  }
  await q('INSERT INTO admin_roles VALUES($1)', [id(4)]);
  await user(1);
  const secret = 'a'.repeat(64), token = 'ExpoPushToken[fixture_a]';
  const register = () =>
    q('SELECT register_push_device($1,$2,$3,$4,$5,$6)', [
      id(301),
      secret,
      token,
      'android',
      'development',
      id(900),
    ]);
  await test('device registration and preferences are account scoped', async () => {
    await register();
    await q('SELECT set_notification_preferences($1)', [{
      push_enabled: true,
      news: true,
    }]);
    const [d] = await q('SELECT user_id,secret_hash FROM push_devices');
    assert.equal(d.user_id, id(1));
    assert.notEqual(d.secret_hash, secret);
  });
  await test('another installation cannot steal a token', async () => {
    await user(2);
    await assert.rejects(
      q('SELECT register_push_device($1,$2,$3,$4,$5,$6)', [
        id(302),
        'b'.repeat(64),
        token,
        'android',
        'development',
        id(900),
      ]),
      /proof/,
    );
    await user(1);
  });
  await test('verification creates inbox and queued push once', async () => {
    await user(4);
    await q('INSERT INTO alumni_verification(alumni_id) VALUES($1)', [id(201)]);
    await q('INSERT INTO alumni_verification(alumni_id) VALUES($1)', [id(201)]);
    assert.equal((await q('SELECT * FROM notification_recipients')).length, 1);
    assert.equal((await q('SELECT * FROM push_deliveries')).length, 1);
  });
  await test('inbox and event RLS isolate accounts; clients cannot forge events', async () => {
    await user(2);
    await db.exec('SET ROLE authenticated');
    assert.equal((await q('SELECT * FROM notification_events')).length, 0);
    assert.equal((await q('SELECT * FROM notification_recipients')).length, 0);
    await assert.rejects(q('SELECT * FROM push_devices'), /permission denied/);
    await assert.rejects(
      q(
        "INSERT INTO notification_events(event_key,category,entity_id,title,body) VALUES('bad','news',$1,'x','x')",
        [id(9)],
      ),
      /permission denied/,
    );
    await user(1);
    assert.equal((await q('SELECT * FROM notification_events')).length, 1);
    await db.exec('RESET ROLE');
  });
  await test('mark read cannot mutate another account inbox', async () => {
    const [r] = await q('SELECT id FROM notification_recipients');
    await user(2);
    await q('SELECT mark_notification_read($1)', [r.id]);
    assert.equal(
      (await q('SELECT read_at FROM notification_recipients'))[0].read_at,
      null,
    );
    await user(1);
    await q('SELECT mark_notification_read($1)', [r.id]);
    assert.ok(
      (await q('SELECT read_at FROM notification_recipients'))[0].read_at,
    );
  });
  await test('claim isolates environment and project, leases avoid a second claim', async () => {
    assert.equal(
      (await q('SELECT * FROM claim_push_jobs($1,$2,false)', [
        'production',
        id(900),
      ])).length,
      0,
    );
    assert.equal(
      (await q('SELECT * FROM claim_push_jobs($1,$2,false)', [
        'development',
        id(901),
      ])).length,
      0,
    );
    assert.equal(
      (await q('SELECT * FROM claim_push_jobs($1,$2,false)', [
        'development',
        id(900),
      ])).length,
      1,
    );
    assert.equal(
      (await q('SELECT * FROM claim_push_jobs($1,$2,false)', [
        'development',
        id(900),
      ])).length,
      0,
    );
  });
  await test('expired send lease becomes unknown instead of duplicate send', async () => {
    await q("UPDATE push_deliveries SET leased_at=now()-interval '10 minutes'");
    await q('SELECT * FROM claim_push_jobs($1,$2,false)', [
      'development',
      id(900),
    ]);
    assert.equal(
      (await q('SELECT status FROM push_deliveries'))[0].status,
      'unknown',
    );
  });
  await test('only authenticated admin reply generates support notification', async () => {
    await q('INSERT INTO support_tickets VALUES($1,$2)', [id(401), id(1)]);
    await user(2);
    await q('INSERT INTO ticket_replies VALUES($1,$2,$3,true)', [
      id(501),
      id(401),
      id(4),
    ]);
    assert.equal(
      (await q("SELECT * FROM notification_events WHERE category='support'"))
        .length,
      0,
    );
    await user(4);
    await q('INSERT INTO ticket_replies VALUES($1,$2,$3,true)', [
      id(502),
      id(401),
      id(4),
    ]);
    assert.equal(
      (await q("SELECT * FROM notification_events WHERE category='support'"))
        .length,
      1,
    );
  });
  await test('publishing sends news; draft and edit do not send', async () => {
    await q('INSERT INTO berita VALUES($1,NULL,$2)', [id(601), 'draft']);
    assert.equal(
      (await q("SELECT * FROM notification_events WHERE category='news'"))
        .length,
      0,
    );
    await q('UPDATE berita SET publication_date=CURRENT_DATE WHERE id=$1', [
      id(601),
    ]);
    await q('UPDATE berita SET title=$1 WHERE id=$2', ['edited', id(601)]);
    assert.equal(
      (await q("SELECT * FROM notification_events WHERE category='news'"))
        .length,
      1,
    );
  });
  await test('community activity targets persisted followers only', async () => {
    await q('INSERT INTO komunitas_member VALUES($1,$2)', [id(701), id(201)]);
    await q('INSERT INTO kegiatan VALUES($1,$2)', [id(702), id(701)]);
    await q('INSERT INTO kegiatan_verification(kegiatan_id) VALUES($1)', [
      id(702),
    ]);
    assert.equal(
      (await q(
        "SELECT r.* FROM notification_recipients r JOIN notification_events e ON e.id=r.event_id WHERE category='community'",
      ))[0].user_id,
      id(1),
    );
  });
  await test('quiet hours defer pending deliveries', async () => {
    await user(1);
    const [clock] = await q(
      "SELECT extract(hour FROM now() AT TIME ZONE 'Asia/Jakarta')::integer AS hour",
    );
    await q('SELECT set_notification_preferences($1)', [{
      quiet_start: clock.hour,
      quiet_end: (clock.hour + 1) % 24,
    }]);
    assert.equal(
      (await q('SELECT * FROM claim_push_jobs($1,$2,false)', [
        'development',
        id(900),
      ])).length,
      0,
    );
    await q('SELECT set_notification_preferences($1)', [{
      quiet_start: null,
      quiet_end: null,
    }]);
  });
  await test('revoked push preference cancels pending deliveries', async () => {
    await q('SELECT set_notification_preferences($1)', [{
      push_enabled: false,
    }]);
    await q('SELECT * FROM claim_push_jobs($1,$2,false)', [
      'development',
      id(900),
    ]);
    assert.equal(
      (await q("SELECT * FROM push_deliveries WHERE status='queued'")).length,
      0,
    );
  });
  await test('account switch requires installation proof; stale logout cannot remove new owner', async () => {
    await user(2);
    await register();
    await q('SELECT release_push_device($1,$2,$3)', [id(301), secret, id(1)]);
    const [d] = await q('SELECT * FROM push_devices');
    assert.equal(d.user_id, id(2));
    assert.equal(d.active, true);
    await db.exec('SET ROLE anon');
    await q('SELECT release_push_device($1,$2,$3)', [id(301), 'wrong', id(2)]);
    await db.exec('RESET ROLE');
    assert.equal((await q('SELECT active FROM push_devices'))[0].active, true);
    await q('SELECT release_push_device($1,$2,$3)', [id(301), secret, id(2)]);
    assert.equal((await q('SELECT active FROM push_devices'))[0].active, false);
  });
  await user(1);
  await register();
  await q('SELECT set_notification_preferences($1)', [{ push_enabled: true }]);
  const enqueue = async (key) => {
    await q('SELECT emit_notification($1,$2,$3,$4,$5,$6)', [
      key,
      'support',
      id(401),
      'Balasan bantuan',
      'Ada balasan baru',
      [id(1)],
    ]);
    return (await q(
      'SELECT j.id FROM push_deliveries j JOIN notification_recipients r ON r.id=j.recipient_id JOIN notification_events e ON e.id=r.event_id WHERE e.event_key=$1',
      [key],
    ))[0].id;
  };
  await test('revoked session prevents sending even when token remains active', async () => {
    const job = await enqueue('session-test');
    await q('DELETE FROM auth.sessions WHERE id=$1', [id(101)]);
    await q('SELECT * FROM claim_push_jobs($1,$2,false)', [
      'development',
      id(900),
    ]);
    assert.equal(
      (await q('SELECT status FROM push_deliveries WHERE id=$1', [job]))[0]
        .status,
      'cancelled',
    );
    await q('INSERT INTO auth.sessions VALUES($1,$2)', [id(101), id(1)]);
  });
  await test('deactivated user and expired events are cancelled', async () => {
    const job = await enqueue('deactivation-test');
    await q('INSERT INTO users VALUES($1,true)', [id(1)]);
    await q('SELECT * FROM claim_push_jobs($1,$2,false)', [
      'development',
      id(900),
    ]);
    assert.equal(
      (await q('SELECT status FROM push_deliveries WHERE id=$1', [job]))[0]
        .status,
      'cancelled',
    );
    await q('DELETE FROM users');
    const expired = await enqueue('expiry-test');
    await q(
      "UPDATE notification_events SET expires_at=now()-interval '1 minute' WHERE event_key='expiry-test'",
    );
    await q('SELECT * FROM claim_push_jobs($1,$2,false)', [
      'development',
      id(900),
    ]);
    assert.equal(
      (await q('SELECT status FROM push_deliveries WHERE id=$1', [expired]))[0]
        .status,
      'cancelled',
    );
  });
  await test('queued jobs cannot follow an installation into another account', async () => {
    const job = await enqueue('switch-test');
    await user(2);
    await register();
    await q('SELECT * FROM claim_push_jobs($1,$2,false)', [
      'development',
      id(900),
    ]);
    assert.equal(
      (await q('SELECT status FROM push_deliveries WHERE id=$1', [job]))[0]
        .status,
      'cancelled',
    );
  });
  await test('clients cannot claim worker jobs or emit targeted pushes', async () => {
    await db.exec('SET ROLE authenticated');
    await assert.rejects(
      q('SELECT * FROM claim_push_jobs($1,$2,false)', ['development', id(900)]),
      /permission denied/,
    );
    await assert.rejects(
      q('SELECT emit_notification($1,$2,$3,$4,$5,$6)', [
        'forged',
        'support',
        id(401),
        'x',
        'x',
        [id(1)],
      ]),
      /permission denied/,
    );
    await db.exec('RESET ROLE');
  });
  await test('broadcasts are capped to one job per device per 15 minutes',async()=>{
    await user(1);await register();
    await q('SELECT set_notification_preferences($1)',[{push_enabled:true,news:true}]);
    await q("UPDATE push_deliveries SET status='cancelled'");
    for(const key of ['cap-one','cap-two'])await q('SELECT emit_notification($1,$2,$3,$4,$5,$6)',[key,'news',id(601),'Berita','Ada berita',[id(1)]]);
    const jobs=await q('SELECT * FROM claim_push_jobs($1,$2,false)',['development',id(900)]);
    assert.equal(jobs.length,1);
    assert.equal((await q('SELECT * FROM claim_push_jobs($1,$2,false)',['development',id(900)])).length,0);
    await q("UPDATE push_deliveries SET status='receipt',receipt_id='receipt',sent_at=now()-interval '16 minutes',leased_at=now() WHERE id=$1",[jobs[0].id]);
    assert.equal((await q('SELECT * FROM claim_push_jobs($1,$2,false)',['development',id(900)])).length,1);
  });
  await test('same-account reinstall retires old device without losing inbox',async()=>{
    const before=(await q('SELECT * FROM notification_recipients')).length;
    await q('SELECT register_push_device($1,$2,$3,$4,$5,$6)',[id(303),'c'.repeat(64),token,'android','development',id(900)]);
    const [old]=await q('SELECT * FROM push_devices WHERE id=$1',[id(301)]);
    assert.equal(old.active,false);assert.equal(old.token,null);
    assert.equal((await q('SELECT * FROM notification_recipients')).length,before);
  });
  await test('authenticated admin business writes still execute protected triggers',async()=>{
    await user(4);
    await db.exec('GRANT INSERT ON alumni_verification TO authenticated; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated; SET ROLE authenticated');
    await q('INSERT INTO alumni_verification(alumni_id) VALUES($1)',[id(203)]);
    await user(3);assert.equal((await q('SELECT * FROM notification_recipients')).length,1);
    await db.exec('RESET ROLE');
  });
  console.log(
    `${passed} notification database checks passed; fixture only, no live Supabase.`,
  );
} finally {
  await db.close();
}
