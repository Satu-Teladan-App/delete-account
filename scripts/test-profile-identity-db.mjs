import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PRODUCT_DB_TEST_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const query = async (sql, args = []) => (await db.query(sql, args)).rows;
let passed = 0;
const test = async (name, fn) => { await fn(); console.log(`PASS ${name}`); passed++; };
const currentYear = new Date().getUTCFullYear();
try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULL::uuid$$;
    CREATE TABLE public.alumni(id integer PRIMARY KEY, batch text, batch_status text, graduation_year integer, name text);
    CREATE TABLE public.scoreboard(alumni_id uuid,user_id uuid,coin numeric,energy numeric);
    CREATE TABLE public.users(user_id uuid,deactivated boolean);
    CREATE TABLE public.alumni_private(LIKE public.alumni INCLUDING ALL);
    INSERT INTO alumni VALUES
      (1,'Alumni - 2006',NULL,NULL,'Fixture'),
      (2,'2006',NULL,NULL,'Fixture'),
      (3,'Aktif - 2028','alumni',2006,'Fixture'),
      (4,'Guru',NULL,NULL,'Fixture'),
      (5,'Alumni - 2006','Alumni',2006,'Fixture'),
      (6,'Alumni - 2007',NULL,2006,'Fixture'),
      (7,'Alumni - 2099',NULL,NULL,'Fixture'),
      (8,'Aktif - 2000','aktif',2000,'Fixture'),
      (9,'Alumni - 2006 extra',NULL,NULL,'Fixture');
    INSERT INTO alumni_private SELECT * FROM alumni;
    ALTER TABLE alumni ADD COLUMN user_id uuid, ADD COLUMN full_name text, ADD COLUMN avatar text, ADD COLUMN consents jsonb;
    GRANT SELECT,INSERT,UPDATE ON alumni,alumni_private TO authenticated;
    CREATE FUNCTION public.sync_batch_status() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $legacy$
    BEGIN
      IF NEW.batch IS NOT NULL AND NEW.batch LIKE '% - %' THEN
        NEW.batch_status := TRIM(SPLIT_PART(NEW.batch, ' - ', 1));
      ELSE
        NEW.batch_status := NEW.batch_status; -- keep existing if batch format is unexpected
      END IF;
      RETURN NEW;
    END;
    $legacy$;
    CREATE TRIGGER trg_sync_batch_status BEFORE INSERT OR UPDATE OF batch ON alumni
      FOR EACH ROW EXECUTE FUNCTION public.sync_batch_status();
    CREATE TRIGGER trg_sync_batch_status BEFORE INSERT OR UPDATE OF batch ON alumni_private
      FOR EACH ROW EXECUTE FUNCTION public.sync_batch_status();
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/007_profile_identity.sql', import.meta.url), 'utf8'));
  await test('reviewed legacy triggers are replaced on both tables without deleting their function', async () => {
    const rows=await query("SELECT c.relname,t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname IN ('alumni','alumni_private') AND NOT t.tgisinternal");
    assert.equal(rows.length,2);
    assert.ok(rows.every(row=>row.tgname==='sync_profile_identity'));
    assert.ok((await query("SELECT to_regprocedure('public.sync_batch_status()') AS legacy"))[0].legacy);
  });
  await test('backfill runs on both profile tables and only fills unambiguous data', async () => {
    for (const table of ['alumni', 'alumni_private']) {
      const [row] = await query(`SELECT batch_status,graduation_year FROM ${table} WHERE id=1`);
      assert.deepEqual(row, { batch_status: 'alumni', graduation_year: 2006 });
      assert.equal((await query(`SELECT batch_status FROM ${table} WHERE id=4`))[0].batch_status, 'guru');
      for (const id of [2,6,7,9]) assert.equal((await query(`SELECT batch_status FROM ${table} WHERE id=$1`,[id]))[0].batch_status, null);
      assert.equal((await query(`SELECT batch_status FROM ${table} WHERE id=5`))[0].batch_status, 'alumni');
    }
  });
  await test('conflicting canonical data is retained and review exposes only identifiers and reasons', async () => {
    assert.equal((await query('SELECT graduation_year FROM alumni WHERE id=3'))[0].graduation_year,2006);
    const rows=await query("SELECT * FROM profile_identity_review WHERE source_table='alumni'");
    assert.ok(rows.some(r=>r.id===3 && r.reason==='conflicting_status'));
    assert.ok(rows.some(r=>r.id===6 && r.reason==='conflicting_year'));
    assert.ok(rows.some(r=>r.id===8 && r.reason==='outdated_student_status'));
    assert.deepEqual(Object.keys(rows[0]).sort(),['id','reason','source_table']);
  });
  await test('new clients write canonical identity and database derives legacy text', async () => {
    await query("INSERT INTO alumni(id,batch_status,graduation_year) VALUES(20,'ALUMNI',2006)");
    assert.equal((await query('SELECT batch FROM alumni WHERE id=20'))[0].batch,'Alumni - 2006');
    assert.equal((await query('SELECT batch_status FROM alumni WHERE id=20'))[0].batch_status,'alumni');
    await query("UPDATE alumni SET graduation_year=2007,batch='stale' WHERE id=20");
    assert.equal((await query('SELECT batch FROM alumni WHERE id=20'))[0].batch,'Alumni - 2007');
  });
  await test('old installed clients still populate canonical fields on insert and update', async () => {
    await query("INSERT INTO alumni(id,batch) VALUES(21,'Alumni - 2006')");
    await query("UPDATE alumni SET batch='Guru' WHERE id=21");
    const [r]=await query('SELECT batch_status,graduation_year FROM alumni WHERE id=21');
    assert.deepEqual(r,{batch_status:'guru',graduation_year:null});
    await query("INSERT INTO alumni_private(id,batch) VALUES(21,'Alumni - 2006')");
    assert.equal((await query('SELECT graduation_year FROM alumni_private WHERE id=21'))[0].graduation_year,2006);
    assert.equal((await query('SELECT batch_status FROM alumni_private WHERE id=21'))[0].batch_status,'alumni');
  });
  await test('invalid and contradictory new identity writes are rejected atomically', async () => {
    for (const sql of [
      "INSERT INTO alumni(id,batch_status,graduation_year) VALUES(30,'other',2006)",
      "INSERT INTO alumni(id,batch_status) VALUES(30,'alumni')",
      `INSERT INTO alumni(id,batch_status,graduation_year) VALUES(30,'alumni',${currentYear+1})`,
      `INSERT INTO alumni(id,batch_status,graduation_year) VALUES(30,'aktif',${currentYear-1})`,
      "INSERT INTO alumni(id,batch) VALUES(30,'2006')",
      "INSERT INTO alumni(id,batch,graduation_year) VALUES(30,'Alumni - 2006',2007)",
    ]) await assert.rejects(query(sql));
    assert.equal((await query('SELECT count(*)::integer AS n FROM alumni WHERE id=30'))[0].n,0);
  });
  await test('teachers do not require a graduation year and students can graduate this year', async () => {
    await query("INSERT INTO alumni(id,batch_status) VALUES(40,'guru')");
    await query('INSERT INTO alumni(id,batch_status,graduation_year) VALUES(41,$1,$2)',['aktif',currentYear]);
  });
  await test('unrelated edits on unresolved historical profiles remain possible', async () => {
    await query("UPDATE alumni SET name='Updated fixture' WHERE id=2");
    await query('UPDATE alumni SET batch=batch WHERE id=8');
    assert.equal((await query('SELECT batch_status FROM alumni WHERE id=2'))[0].batch_status,null);
  });
  await test('authenticated writes can execute the trigger while review remains service-only', async () => {
    await db.exec('SET ROLE authenticated');
    await query("INSERT INTO alumni(id,batch_status,graduation_year) VALUES(50,'alumni',2006)");
    await assert.rejects(query('SELECT * FROM profile_identity_review'),/permission denied/);
    await db.exec('RESET ROLE; SET ROLE anon');
    await assert.rejects(query('SELECT * FROM profile_identity_review'),/permission denied/);
    await db.exec('RESET ROLE; SET ROLE service_role');
    assert.ok((await query('SELECT * FROM profile_identity_review')).length>0);
    await db.exec('RESET ROLE');
  });
  await test('canonical ranking preserves separate metrics, ties, ownership and consent', async () => {
    const rankingDb = new PGlite();
    const rq = async (sql,args=[]) => (await rankingDb.query(sql,args)).rows;
    const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    try {
      await rankingDb.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        CREATE SCHEMA auth;
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.user',true),'')::uuid$$;
        CREATE TABLE alumni(id uuid PRIMARY KEY,user_id uuid,name text,full_name text,avatar text,consents jsonb,batch text,batch_status text,graduation_year integer);
        CREATE TABLE alumni_private(LIKE alumni INCLUDING ALL);
        CREATE TABLE scoreboard(alumni_id uuid,user_id uuid,coin numeric,energy numeric);
        CREATE TABLE users(user_id uuid,deactivated boolean);
      `);
      await rankingDb.exec(await readFile(new URL('../supabase/migrations/007_profile_identity.sql',import.meta.url),'utf8'));
      for (let i=1;i<=5;i++) {
        await rq("INSERT INTO alumni(id,user_id,name,consents,batch_status,graduation_year) VALUES($1,$2,'Fixture',$3,'alumni',2006)",[id(i),id(100+i),{ranking:i!==3}]);
        await rq('INSERT INTO scoreboard VALUES($1,$2,$3,$4)',[id(i),id(i===5?999:100+i),i===2?100:0,10]);
      }
      await rq('INSERT INTO users VALUES($1,true)',[id(104)]);
      await rq("SELECT set_config('test.user',$1,false)",[id(101)]);
      await rankingDb.exec('SET ROLE authenticated');
      const energy=await rq("SELECT * FROM get_profile_contribution_rankings('energy',100,false)");
      assert.equal(energy.length,2);
      assert.ok(energy.every(r=>r.rank===1 && r.batch_status==='alumni' && r.graduation_year===2006));
      assert.ok(energy.every(r=>!('batch' in r)));
      assert.equal((await rq("SELECT * FROM get_profile_contribution_rankings('coin',100,false)"))[0].alumni_id,id(2));
      assert.equal((await rq("SELECT * FROM get_profile_contribution_rankings('energy',100,true)"))[0].alumni_id,id(1));
      await assert.rejects(rq("SELECT * FROM get_profile_contribution_rankings('other',100,false)"));
      await rankingDb.exec('RESET ROLE; SET ROLE anon');
      await assert.rejects(rq("SELECT * FROM get_profile_contribution_rankings('energy',100,false)"),/permission denied/);
    } finally { await rankingDb.close(); }
  });
  await test('unexpected legacy logic or trigger binding aborts and restores all previous triggers', async () => {
    const reviewedBody = `BEGIN
      IF NEW.batch IS NOT NULL AND NEW.batch LIKE '% - %' THEN
        NEW.batch_status := TRIM(SPLIT_PART(NEW.batch, ' - ', 1));
      ELSE NEW.batch_status := NEW.batch_status;
      END IF; RETURN NEW; END;`;
    for (const changed of ['body','binding']) {
      const guardedDb = new PGlite();
      try {
        await guardedDb.exec(`CREATE TABLE alumni(id integer,batch text,batch_status text);
          CREATE TABLE alumni_private(LIKE alumni);
          CREATE FUNCTION public.sync_batch_status() RETURNS trigger LANGUAGE plpgsql AS $old$
            ${changed==='body' ? 'BEGIN NEW.batch_status := upper(NEW.batch); RETURN NEW; END;' : reviewedBody}
          $old$;
          CREATE FUNCTION public.other_private_sync() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END;$$;
          CREATE TRIGGER trg_sync_batch_status BEFORE INSERT OR UPDATE OF batch ON alumni
            FOR EACH ROW EXECUTE FUNCTION public.sync_batch_status();
          CREATE TRIGGER trg_sync_batch_status BEFORE INSERT OR UPDATE OF batch ON alumni_private
            FOR EACH ROW EXECUTE FUNCTION public.${changed==='binding' ? 'other_private_sync' : 'sync_batch_status'}();
        `);
        await assert.rejects(guardedDb.exec(await readFile(new URL('../supabase/migrations/007_profile_identity.sql',import.meta.url),'utf8')), /differs from reviewed preflight/);
        await guardedDb.exec('ROLLBACK');
        const triggers=(await guardedDb.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal")).rows;
        assert.equal(triggers.length,2);
        assert.ok(triggers.every(row=>row.tgname==='trg_sync_batch_status'));
        assert.equal((await guardedDb.query("SELECT to_regprocedure('public.profile_identity_role(text)') AS helper")).rows[0].helper,null);
      } finally { await guardedDb.close(); }
    }
  });
  console.log(`${passed} profile identity database checks passed (isolated PostgreSQL fixture)`);
} finally { await db.close(); }
