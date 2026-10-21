// Security rules tests with @firebase/rules-unit-testing: every collection,
// every role, read and write.
import { describe, it, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, where, addDoc } from 'firebase/firestore';

const ROLES = ['guest', 'official', 'frontdesk', 'accounts', 'admin'];
const STAFF = ['frontdesk', 'accounts', 'admin'];
const ACC = ['accounts', 'admin'];

// collection -> sample doc and who may read it.
//   'all'   any signed-in user;  'none' nobody
//   { owner: field, roles: [...] }  owner of the doc (by field) or these roles
const MATRIX = {
  users: { id: 'OWNER', data: { name: 'x' }, read: { ownerIsId: true, roles: STAFF } },
  aadhaarRefs: { id: 'h1', data: { uid: 'OWNER' }, read: 'none' },
  officialRequests: { id: 'r1', data: { uid: 'OWNER' }, read: { owner: 'uid', roles: ['admin'] } },
  buildings: { id: 'b1', data: { name: 'A' }, read: 'all' },
  roomTypes: { id: 't1', data: { name: 'Std' }, read: 'all' },
  rooms: { id: 'r1', data: { number: '101' }, read: 'all' },
  categories: { id: 'guest', data: { name: 'G' }, read: 'all' },
  rates: { id: 'guest_t1', data: { amountPaise: 100 }, read: 'all' },
  'rates/guest_t1/history': { id: 'h1', data: { old: 1 }, read: { roles: ACC } },
  settings: { id: 'global', data: { holdMinutes: 10 }, read: 'all' },
  roomNights: { id: 'r1_2026-11-01', data: { roomId: 'r1' }, read: 'all' },
  bookings: { id: 'k1', data: { userId: 'OWNER' }, read: { owner: 'userId', roles: STAFF } },
  queue: { id: 'q1', data: { userId: 'OWNER' }, read: { owner: 'userId', roles: STAFF } },
  counters: { id: 'bookings', data: { value: 1 }, read: 'none' },
  payments: { id: 'p1', data: { userId: 'OWNER' }, read: { owner: 'userId', roles: ACC } },
  invoices: { id: 'i1', data: { userId: 'OWNER' }, read: { owner: 'userId', roles: ACC } },
  receipts: { id: 'c1', data: { userId: 'OWNER' }, read: { owner: 'userId', roles: STAFF } },
  reminders: { id: 'm1', data: { invoiceId: 'i1' }, read: { roles: ACC } },
  auditLogs: { id: 'a1', data: { entity: 'booking', actorUid: 'OWNER' }, read: { roles: ['admin'] } },
  webhookEvents: { id: 'e1', data: { type: 'x' }, read: 'none' },
  idempotencyKeys: { id: 'k1', data: { uid: 'OWNER' }, read: 'none' },
};

let env;
const OWNER = 'owner-uid';

const ctx = (uid, role, extra = {}) => env.authenticatedContext(uid, { role, categoryId: 'guest', ...extra }).firestore();

describe('firestore.rules', () => {
  before(async () => {
    const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
    env = await initializeTestEnvironment({
      projectId: 'demo-rules-test',
      firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'), host, port: Number(port) },
    });
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (c) => {
      const fs = c.firestore();
      for (const [col, spec] of Object.entries(MATRIX)) {
        const data = JSON.parse(JSON.stringify(spec.data).replaceAll('OWNER', OWNER));
        await setDoc(doc(fs, col, spec.id.replace('OWNER', OWNER)), data);
      }
      await setDoc(doc(fs, 'auditLogs', 'a2'), { entity: 'payment' });
    });
  });
  after(async () => env?.cleanup());

  for (const [col, spec] of Object.entries(MATRIX)) {
    const id = spec.id.replace('OWNER', OWNER);
    describe(col, () => {
      it('no client can create, update or delete (any role, owner included)', async () => {
        for (const role of ROLES) {
          for (const uid of [OWNER, `other-${role}`]) {
            const fs = ctx(uid, role);
            await assertFails(setDoc(doc(fs, col, id), { hacked: true }));
            await assertFails(updateDoc(doc(fs, col, id), { hacked: true }));
            await assertFails(deleteDoc(doc(fs, col, id)));
            await assertFails(addDoc(collection(fs, col), { hacked: true }));
          }
        }
        await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), col, id), { x: 1 }));
      });

      it('unauthenticated cannot read', async () => {
        await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), col, id)));
      });

      it('reads follow the data-model table', async () => {
        for (const role of ROLES) {
          for (const uid of [OWNER, `other-${role}`]) {
            const isOwner = uid === OWNER;
            let allowed;
            if (spec.read === 'all') allowed = true;
            else if (spec.read === 'none') allowed = false;
            else allowed = (spec.read.roles ?? []).includes(role) || (isOwner && (spec.read.owner || spec.read.ownerIsId));
            const p = getDoc(doc(ctx(uid, role), col, id));
            if (allowed) await assertSucceeds(p);
            else await assertFails(p);
          }
        }
      });
    });
  }

  it('accounts can read payment audit entries but not others', async () => {
    await assertSucceeds(getDoc(doc(ctx('acc', 'accounts'), 'auditLogs', 'a2')));
    await assertFails(getDoc(doc(ctx('acc', 'accounts'), 'auditLogs', 'a1')));
  });

  it('a suspended user cannot read even public catalogue data', async () => {
    await assertFails(getDoc(doc(ctx(OWNER, 'guest', { suspended: true }), 'rooms', 'r1')));
  });

  it('guest cannot list all bookings, but can list their own', async () => {
    const fs = ctx(OWNER, 'guest');
    await assertFails(getDocs(collection(fs, 'bookings')));
    await assertSucceeds(getDocs(query(collection(fs, 'bookings'), where('userId', '==', OWNER))));
  });

  it('live board: any signed-in user can query roomNights by date range', async () => {
    const fs = ctx('someone', 'guest');
    await assertSucceeds(getDocs(query(collection(fs, 'roomNights'), where('date', '>=', '2026-11-01'))));
  });
});
