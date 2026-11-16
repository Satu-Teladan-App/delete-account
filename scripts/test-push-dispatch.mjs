import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchPushBatch } from '../supabase/functions/push-dispatch/dispatch.mjs';
const config = {
  environment: 'development',
  projectId: 'fixture-project',
  accessToken: 'fixture-secret',
};
function fixture(receipts = false) {
  const job = {
    id: 'job',
    lease_id: 'lease',
    device_id: 'device',
    token: 'ExpoPushToken[fixture]',
    recipient_id: 'recipient',
    receipt_id: receipts ? 'receipt' : null,
    title: 'Pembaruan',
    body: 'Ada pembaruan',
    attempts: 1,
    status: 'sending',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
  const device = { id: 'device', token: job.token, active: true };
  const db = {
    rpc: async (name, args) => ({
      data: args.p_receipts === receipts ? [job] : [],
      error: null,
    }),
    from(table) {
      let patch;
      const filters = [];
      const q = {
        update(p) {
          patch = p;
          return q;
        },
        eq(k, v) {
          filters.push([k, v]);
          return q;
        },
        then(resolve, reject) {
          const row = table === 'push_devices' ? device : job;
          if (filters.every(([k, v]) => row[k] === v)) {
            Object.assign(row, patch);
          }
          return Promise.resolve({ error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return { job, device, db };
}
test('accepted send stores receipt without claiming device delivery', async () => {
  const { job, db } = fixture();
  await dispatchPushBatch(db, config, async (url, options) => {
    assert.match(url, /\/send$/);
    const [message] = JSON.parse(options.body);
    assert.deepEqual(message.data, { notification_id: 'recipient' });
    assert.equal(message.channelId, 'updates');
    return Response.json({ data: [{ status: 'ok', id: 'receipt' }] });
  });
  assert.equal(job.status, 'receipt');
  assert.equal(job.receipt_id, 'receipt');
});
test('receipt success marks provider handoff complete', async () => {
  const { job, db } = fixture(true);
  await dispatchPushBatch(
    db,
    config,
    async () => Response.json({ data: { receipt: { status: 'ok' } } }),
  );
  assert.equal(job.status, 'delivered');
});
test('invalid device is disabled and permanently failed', async () => {
  const { job, device, db } = fixture();
  await dispatchPushBatch(
    db,
    config,
    async () =>
      Response.json({
        data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
      }),
  );
  assert.equal(device.active, false);
  assert.equal(job.status, 'failed');
});
test('429 retries with a future backoff', async () => {
  const { job, db } = fixture();
  await dispatchPushBatch(
    db,
    config,
    async () => new Response('', { status: 429 }),
  );
  assert.equal(job.status, 'queued');
  assert.ok(new Date(job.next_attempt_at) > new Date());
});
test('retry budget stops repeated sends', async () => {
  const { job, db } = fixture();
  job.attempts = 5;
  await dispatchPushBatch(
    db,
    config,
    async () => new Response('', { status: 503 }),
  );
  assert.equal(job.status, 'failed');
});
test('network timeout has unknown outcome and is not blindly resent', async () => {
  const { job, db } = fixture();
  await dispatchPushBatch(db, config, async () => {
    throw new Error('timeout');
  });
  assert.equal(job.status, 'unknown');
});
test('permanent payload error is not retried', async () => {
  const { job, db } = fixture();
  await dispatchPushBatch(
    db,
    config,
    async () => new Response('', { status: 400 }),
  );
  assert.equal(job.status, 'failed');
});
test('missing send ticket is unknown, missing receipt is polled later', async () => {
  const send = fixture();
  await dispatchPushBatch(
    send.db,
    config,
    async () => Response.json({ data: [] }),
  );
  assert.equal(send.job.status, 'unknown');
  const receipt = fixture(true);
  await dispatchPushBatch(
    receipt.db,
    config,
    async () => Response.json({ data: {} }),
  );
  assert.equal(receipt.job.status, 'receipt');
  assert.ok(new Date(receipt.job.next_attempt_at) > new Date());
});
