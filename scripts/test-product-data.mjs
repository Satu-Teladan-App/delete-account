import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const { PGlite } = await import(process.env.PRODUCT_DB_TEST_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const migration = await readFile(new URL('../supabase/migrations/004_product_data_contract.sql', import.meta.url), 'utf8');
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let passed = 0;
const test = async (label, fn) => { await fn(); passed++; console.log(`PASS ${label}`); };
const asUser = async (n) => db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [n ? id(n) : '']);
const query = async (sql, values = []) => (await db.query(sql, values)).rows;

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon;
    CREATE TABLE public.alumni(id uuid PRIMARY KEY, user_id uuid UNIQUE NOT NULL, name text NOT NULL,
      full_name text, avatar text, batch text, consents jsonb);
    CREATE TABLE public.users(user_id uuid UNIQUE, deactivated boolean);
    CREATE TABLE public.admin_roles(user_id uuid, role_id bigint);
    CREATE TABLE public.alumni_verification(alumni_id uuid UNIQUE);
    CREATE TABLE public.kegiatan(id uuid PRIMARY KEY, kegiatan_date date);
    CREATE TABLE public.komunitas(id uuid PRIMARY KEY);
    CREATE TABLE public.komunitas_member(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, komunitas_id uuid, alumni_id uuid);
    CREATE TABLE public.komunitas_verification(komunitas_id uuid);
    CREATE TABLE public.donasi(id uuid PRIMARY KEY, target_amount numeric);
    CREATE TABLE public.berita(id uuid PRIMARY KEY, created_at timestamptz DEFAULT now());
    CREATE TABLE public.tantangan(id uuid PRIMARY KEY, name text, type text, kegiatan_id uuid,
      unit_limit integer CHECK(unit_limit > 0), start_date timestamptz, end_date timestamptz, is_active boolean);
    CREATE TABLE public.user_feature_blacklist(user_id uuid, alumni_id uuid, feature text,
      is_active boolean, blacklisted_until timestamptz);
    CREATE TABLE public.contribution(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
      alumni_id uuid NOT NULL, tantangan_id uuid, donasi_id uuid, coin_earned numeric NOT NULL DEFAULT 0,
      energy_earned numeric NOT NULL DEFAULT 0, remaining_energy_to_be_claimed numeric,
      created_at timestamptz DEFAULT now());
    CREATE TABLE public.scoreboard(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE NOT NULL,
      alumni_id uuid UNIQUE NOT NULL, coin numeric NOT NULL DEFAULT 0 CHECK(coin >= 0),
      energy numeric NOT NULL DEFAULT 0 CHECK(energy >= 0), updated_at timestamptz DEFAULT now());
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, anon;
    CREATE POLICY fixture_read_score ON public.scoreboard FOR SELECT TO authenticated USING (true);
  `);
  await test('migration refuses unreviewed reward triggers', async () => {
    await db.exec(`CREATE FUNCTION fixture_reward_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
      CREATE TRIGGER fixture_reward BEFORE INSERT ON scoreboard FOR EACH ROW EXECUTE FUNCTION fixture_reward_trigger();`);
    await assert.rejects(db.exec(migration), /Review contribution\/scoreboard triggers/);
    await db.exec('ROLLBACK; DROP TRIGGER fixture_reward ON scoreboard; DROP FUNCTION fixture_reward_trigger();');
  });
  await db.exec(migration);
  for (const n of [1, 2, 3, 4]) {
    await query('INSERT INTO alumni(id,user_id,name,consents) VALUES ($1,$2,$3,$4)', [id(100+n), id(n), `Fixture ${n}`, { ranking: n !== 3 }]);
    await query('INSERT INTO alumni_verification(alumni_id) VALUES ($1)', [id(100+n)]);
  }
  await query('INSERT INTO admin_roles(user_id,role_id) VALUES ($1,1)', [id(4)]);
  await query('INSERT INTO scoreboard(user_id,alumni_id,coin,energy) VALUES ($1,$2,1,0),($3,$4,0,1000),($5,$6,999,9999)', [id(1),id(101),id(2),id(102),id(3),id(103)]);
  await asUser(1);
  await test('ranking categories are separate and opt-out is excluded', async () => {
    const energy = await query("SELECT * FROM get_contribution_rankings('energy',100,false)");
    const coins = await query("SELECT * FROM get_contribution_rankings('coin',100,false)");
    assert.equal(energy[0].alumni_id,id(102)); assert.equal(coins[0].alumni_id,id(101));
    assert.equal(energy.length,2);
  });
  await test('own ranking uses the full ranked population', async () => {
    const [mine] = await query("SELECT * FROM get_contribution_rankings('energy',1,true)");
    assert.equal(Number(mine.rank),2); assert.equal(mine.alumni_id,id(101));
  });
  await test('ties receive the same rank and deterministic ordering', async () => {
    await query('UPDATE scoreboard SET energy=1000 WHERE user_id=$1',[id(1)]);
    const rows = await query("SELECT * FROM get_contribution_rankings('energy',100,false)");
    assert.deepEqual(rows.map(r=>Number(r.rank)),[1,1]);
    assert.deepEqual(rows.map(r=>r.alumni_id),[id(101),id(102)]);
  });
  await test('identity mismatch is excluded from leaderboard', async () => {
    await query('UPDATE scoreboard SET user_id=$1 WHERE alumni_id=$2',[id(4),id(102)]);
    assert.equal((await query("SELECT * FROM get_contribution_rankings('energy',100,false)")).length,1);
    await query('UPDATE scoreboard SET user_id=$1 WHERE alumni_id=$2',[id(2),id(102)]);
  });
  await test('deactivated profile is excluded', async () => {
    await query('INSERT INTO users(user_id,deactivated) VALUES ($1,true)',[id(2)]);
    assert.equal((await query("SELECT * FROM get_contribution_rankings('energy',100,false)")).length,1);
    await query('DELETE FROM users');
  });
  await test('server consent update preserves other preferences and removes opt-outs', async () => {
    await query('UPDATE alumni SET consents=$1 WHERE user_id=$2',[{ ranking: true, telephone: false },id(1)]);
    await query('SELECT set_my_ranking_consent(false)');
    const [profile] = await query('SELECT consents FROM alumni WHERE user_id=$1',[id(1)]);
    assert.equal(profile.consents.ranking,false); assert.equal(profile.consents.telephone,false);
    assert.equal((await query("SELECT * FROM get_contribution_rankings('energy',100,true)")).length,0);
    await query('SELECT set_my_ranking_consent(true)');
  });
  await test('ordinary users cannot read admin totals', async () => {
    await assert.rejects(query('SELECT get_admin_product_overview()'), /Admin access required/);
    await asUser(4);
    await query('INSERT INTO donasi(id,target_amount) VALUES ($1,100),($2,200)',[id(201),id(202)]);
    const [row] = await query('SELECT get_admin_product_overview() AS stats');
    assert.equal(row.stats.donasi.totalAmount,300);
    await asUser(1);
  });
  await query('UPDATE scoreboard SET energy=0 WHERE user_id=$1',[id(1)]);
  await query("INSERT INTO tantangan(id,name,type,kegiatan_id,unit_limit,is_active,start_date,end_date) VALUES ($1,'Original','langkah',$2,10,true,now()-interval '1 day',now()+interval '1 day')",[id(301),id(401)]);
  const claim = (quantity,request,expected=quantity/100,type='langkah') => query('SELECT claim_challenge_energy($1,$2,$3,$4,$5) AS result',[id(301),type,quantity,id(request),expected]);
  await test('claim stores raw quantity, rule version and snapshot', async () => {
    const [row] = await claim(300,501);
    assert.equal(row.result.energyAwarded,3);
    const [saved] = await query('SELECT * FROM contribution WHERE request_id=$1',[id(501)]);
    assert.equal(Number(saved.raw_quantity),300); assert.equal(saved.raw_unit,'langkah');
    assert.equal(saved.conversion_rule.version,'energy-v1'); assert.equal(saved.activity_snapshot.name,'Original');
    assert.equal(saved.verification_status,'self_reported');
  });
  await test('retry is idempotent and mismatched retry is rejected', async () => {
    await claim(300,501);
    assert.equal((await query('SELECT * FROM contribution')).length,1);
    await assert.rejects(claim(400,501),/Request ID/);
  });
  await test('snapshot does not change when a challenge is renamed', async () => {
    await query("UPDATE tantangan SET name='Renamed'");
    const [saved] = await query('SELECT activity_snapshot FROM contribution');
    assert.equal(saved.activity_snapshot.name,'Original');
  });
  await test('scoreboard failure rolls back contribution', async () => {
    await db.exec('ALTER TABLE scoreboard ADD CONSTRAINT fixture_ceiling CHECK(energy<=3) NOT VALID');
    await assert.rejects(claim(100,502),/fixture_ceiling/);
    assert.equal((await query('SELECT * FROM contribution')).length,1);
    await db.exec('ALTER TABLE scoreboard DROP CONSTRAINT fixture_ceiling');
  });
  await test('invalid quantity, activity, expected reward and challenge limit are rejected', async () => {
    await assert.rejects(claim(-100,503),/bilangan bulat/);
    await assert.rejects(claim(100,503,1,'sampah'),/Jenis aktivitas/);
    await assert.rejects(claim(100,503,10),/pratinjau/);
    await assert.rejects(claim(800,503),/Batas energi/);
  });
  await test('server enforces future and expired challenge windows', async () => {
    await query("UPDATE tantangan SET start_date=now()+interval '1 day'");
    await assert.rejects(claim(100,503),/belum dimulai/);
    await query("UPDATE tantangan SET start_date=now()-interval '2 days',end_date=now()-interval '1 day'");
    await assert.rejects(claim(100,503),/berakhir/);
    await query("UPDATE tantangan SET end_date=now()+interval '1 day'");
  });
  await test('summary includes more than 50 records and only the current account', async () => {
    await query('INSERT INTO contribution(user_id,alumni_id,energy_earned) SELECT $1,$2,1 FROM generate_series(1,51)',[id(1),id(101)]);
    await query('INSERT INTO contribution(user_id,alumni_id,energy_earned) VALUES ($1,$2,999)',[id(2),id(102)]);
    const [row] = await query('SELECT * FROM get_my_contribution_summary()');
    assert.equal(Number(row.energy),54); assert.equal(Number(row.contribution_count),52);
  });
  await test('invalid legacy challenge history cannot increase the claim allowance', async () => {
    await query('INSERT INTO contribution(user_id,alumni_id,tantangan_id,energy_earned) VALUES ($1,$2,$3,-1)',[id(1),id(101),id(301)]);
    await assert.rejects(claim(100,504),/Histori kontribusi/);
    await query('DELETE FROM contribution WHERE energy_earned<0');
    await query('INSERT INTO contribution(user_id,alumni_id,tantangan_id,energy_earned) VALUES ($1,$2,$3,0)',[id(2),id(101),id(301)]);
    await assert.rejects(claim(100,504),/Histori kontribusi/);
    await query('DELETE FROM contribution WHERE user_id=$1 AND alumni_id=$2',[id(2),id(101)]);
  });
  await test('memberships cannot be duplicated', async () => {
    await query('INSERT INTO komunitas_member(komunitas_id,alumni_id) VALUES ($1,$2)',[id(601),id(101)]);
    await assert.rejects(query('INSERT INTO komunitas_member(komunitas_id,alumni_id) VALUES ($1,$2)',[id(601),id(101)]),/komunitas_member_pair_unique/);
  });
  await test('authenticated cannot bypass the reward RPC with direct writes', async () => {
    await db.exec('SET ROLE authenticated');
    await assert.rejects(query('UPDATE scoreboard SET energy=999'),/permission denied/);
    await assert.rejects(query('INSERT INTO contribution(user_id,alumni_id) VALUES ($1,$2)',[id(1),id(101)]),/permission denied/);
    await db.exec('RESET ROLE');
  });
  await test('anonymous cannot execute ranking or reward functions', async () => {
    await db.exec('SET ROLE anon');
    await assert.rejects(query("SELECT * FROM get_contribution_rankings('energy',100,false)"),/permission denied/);
    await assert.rejects(claim(100,503),/permission denied/);
    await db.exec('RESET ROLE');
  });
  await test('privacy migration denies anonymous table and column reads without removing explicit authenticated grants', async () => {
    await db.exec('CREATE TABLE alumni_private(id uuid); GRANT SELECT ON alumni,alumni_private,users TO PUBLIC; GRANT SELECT(name) ON alumni TO anon; GRANT SELECT ON alumni TO authenticated;');
    const privacy = await readFile(new URL('../supabase/migrations/005_anonymous_profile_privacy.sql', import.meta.url),'utf8');
    await db.exec(privacy);
    await db.exec('SET ROLE anon');
    await assert.rejects(query('SELECT name FROM alumni'),/permission denied/);
    await assert.rejects(query('SELECT * FROM users'),/permission denied/);
    await assert.rejects(query('SELECT * FROM alumni_private'),/permission denied/);
    await db.exec('RESET ROLE; SET ROLE authenticated');
    assert.equal((await query('SELECT name FROM alumni')).length,4);
    await db.exec('RESET ROLE');
  });
  console.log(`${passed} database checks passed. Fixture-only PostgreSQL WASM; no live database or multi-connection race test.`);
} finally { await db.close(); }
