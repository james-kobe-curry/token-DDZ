import test from 'node:test';
import assert from 'node:assert/strict';
import { HostRoomError, HostRoomManager } from '../src/hostRoomManager.js';

async function readyPhoneRoom() {
  const manager = new HostRoomManager();
  const host = manager.createRoom({ name: '安卓房主' });
  const guestA = manager.joinRoom({ code: host.code, name: '苹果牌友' });
  const guestB = manager.joinRoom({ code: host.code, name: '安卓牌友' });
  await manager.setReady(host.code, host.token, true);
  await manager.setReady(host.code, guestA.token, true);
  await manager.setReady(host.code, guestB.token, true);
  return { manager, host, guestA, guestB };
}

test('安卓 WebView 房主引擎生成三人权威牌局与 SHA-256 承诺', async () => {
  const { manager, host, guestA, guestB } = await readyPhoneRoom();
  const views = [host, guestA, guestB].map((session) => manager.snapshot(host.code, session.token));
  assert.deepEqual(views.map((view) => view.selfPlayer), [0, 1, 2]);
  assert.equal(views.every((view) => view.game.selfHand.length === 17), true);
  assert.equal(views.every((view) => view.game.commit.length === 64), true);
  assert.equal(views.some((view) => 'hands' in view.game || 'seed' in view.game), false);
});

test('安卓房主引擎保持逆时针动作、版本校验与重复动作幂等', async () => {
  const { manager, host, guestA, guestB } = await readyPhoneRoom();
  await manager.performAction(host.code, host.token, { seq: 1, stateVersion: 0, action: { type: 'bid', score: 1 } });
  assert.equal(manager.snapshot(host.code, guestA.token).game.current, 2);
  await manager.performAction(host.code, guestB.token, { seq: 1, stateVersion: 1, action: { type: 'bid', score: 0 } });
  assert.equal(manager.snapshot(host.code, guestB.token).game.current, 1);
  await manager.performAction(host.code, guestA.token, { seq: 1, stateVersion: 2, action: { type: 'bid', score: 0 } });
  const playing = manager.snapshot(host.code, host.token).game;
  assert.equal(playing.phase, 'playing');
  assert.equal(playing.current, 0);
  assert.equal(playing.selfHand.length, 20);
  const duplicate = await manager.performAction(host.code, host.token, { seq: 1, stateVersion: 3, action: { type: 'pass' } });
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(
    manager.performAction(host.code, guestA.token, { seq: 2, stateVersion: 2, action: { type: 'pass' } }),
    (error) => error instanceof HostRoomError && error.code === 'STALE_STATE',
  );
});

test('安卓房主引擎使用重连令牌恢复原座位', async () => {
  const { manager, host, guestA } = await readyPhoneRoom();
  manager.disconnect(host.code, guestA.token);
  assert.equal(manager.snapshot(host.code, host.token).players[1].connected, false);
  const restored = manager.reconnect({ code: host.code, token: guestA.token });
  assert.equal(restored.seat, 1);
  assert.equal(manager.snapshot(host.code, host.token).players[1].connected, true);
  assert.throws(() => manager.reconnect({ code: host.code, token: 'invalid' }), (error) => error.code === 'INVALID_SESSION');
});

test('安卓房主不会让已准备但掉线的座位启动牌局', async () => {
  const manager = new HostRoomManager();
  const host = manager.createRoom({ name: '房主' });
  const guestA = manager.joinRoom({ code: host.code, name: '玩家甲' });
  const guestB = manager.joinRoom({ code: host.code, name: '玩家乙' });
  await manager.setReady(host.code, host.token, true);
  await manager.setReady(host.code, guestA.token, true);
  manager.disconnect(host.code, guestA.token);
  await manager.setReady(host.code, guestB.token, true);
  const view = manager.snapshot(host.code, host.token);
  assert.equal(view.game, null);
  assert.equal(view.players[1].ready, false);
});

test('安卓手机房主可补入人机并由房主权威引擎自动行动', async () => {
  let now = 1000;
  const manager = new HostRoomManager({ now: () => now });
  const host = manager.createRoom({ name: '安卓房主' });
  const guest = manager.joinRoom({ code: host.code, name: '苹果牌友' });
  await manager.setBots(host.code, host.token, 1);
  await manager.setReady(host.code, host.token, true);
  await manager.setReady(host.code, guest.token, true);
  const lobbyFilled = manager.snapshot(host.code, host.token);
  assert.equal(lobbyFilled.players.find((player) => player.isBot)?.difficulty, 'master');
  await manager.performAction(host.code, host.token, { seq: 1, stateVersion: 0, action: { type: 'bid', score: 1 } });
  assert.deepEqual(await manager.tick(), [host.code]);
  const afterBot = manager.snapshot(host.code, guest.token).game;
  assert.equal(afterBot.stateVersion, 2);
  assert.equal(afterBot.lastAction.bot, true);
});
