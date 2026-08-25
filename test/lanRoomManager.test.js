import test from 'node:test';
import assert from 'node:assert/strict';
import { LanRoomManager, RoomError } from '../server/roomManager.mjs';

function readyRoom() {
  const manager = new LanRoomManager();
  const host = manager.createRoom({ name: '房主' });
  const guestA = manager.joinRoom({ code: host.code, name: '苹果玩家' });
  const guestB = manager.joinRoom({ code: host.code, name: '安卓玩家' });
  manager.setReady(host.code, host.token, true);
  manager.setReady(host.code, guestA.token, true);
  manager.setReady(host.code, guestB.token, true);
  return { manager, host, guestA, guestB };
}

test('三名局域网玩家准备后创建同一个权威牌局', () => {
  const { manager, host, guestA, guestB } = readyRoom();
  const hostView = manager.snapshot(host.code, host.token);
  const appleView = manager.snapshot(host.code, guestA.token);
  const androidView = manager.snapshot(host.code, guestB.token);
  assert.equal(hostView.game.stateVersion, 0);
  assert.deepEqual(hostView.players.map((player) => player.seat), [0, 1, 2]);
  assert.equal(hostView.game.selfHand.length, 17);
  assert.equal(appleView.game.selfHand.length, 17);
  assert.equal(androidView.game.selfHand.length, 17);
  assert.notDeepEqual(hostView.game.selfHand, appleView.game.selfHand);
  assert.equal('hands' in hostView.game, false);
});

test('房主只接受当前版本和当前座位的递增动作', () => {
  const { manager, host, guestA } = readyRoom();
  const first = manager.performAction(host.code, host.token, { seq: 1, stateVersion: 0, action: { type: 'bid', score: 1 } });
  assert.equal(first.snapshot.game.stateVersion, 1);
  assert.throws(
    () => manager.performAction(host.code, guestA.token, { seq: 1, stateVersion: 0, action: { type: 'bid', score: 2 } }),
    (error) => error instanceof RoomError && error.code === 'STALE_STATE',
  );
  const duplicate = manager.performAction(host.code, host.token, { seq: 1, stateVersion: 1, action: { type: 'bid', score: 3 } });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.snapshot.game.stateVersion, 1);
});

test('重连令牌恢复原座位，错误令牌不能读取房间', () => {
  const { manager, host, guestA } = readyRoom();
  manager.disconnect(host.code, guestA.token);
  assert.equal(manager.snapshot(host.code, host.token).players[1].connected, false);
  const restored = manager.reconnect({ code: host.code, token: guestA.token });
  assert.equal(restored.seat, 1);
  assert.equal(manager.snapshot(host.code, host.token).players[1].connected, true);
  assert.throws(() => manager.reconnect({ code: host.code, token: 'wrong' }), (error) => error.code === 'INVALID_SESSION');
});

test('已准备玩家掉线后不会带着离线座位开局', () => {
  const manager = new LanRoomManager();
  const host = manager.createRoom({ name: '房主' });
  const guestA = manager.joinRoom({ code: host.code, name: '玩家甲' });
  const guestB = manager.joinRoom({ code: host.code, name: '玩家乙' });
  manager.setReady(host.code, host.token, true);
  manager.setReady(host.code, guestA.token, true);
  manager.disconnect(host.code, guestA.token);
  manager.setReady(host.code, guestB.token, true);
  const view = manager.snapshot(host.code, host.token);
  assert.equal(view.game, null);
  assert.equal(view.players[1].ready, false);
  assert.equal(view.players[1].connected, false);
});

test('权威回合超时后由公开信息 AI 托管并推进版本', () => {
  let now = 1000;
  const manager = new LanRoomManager({ now: () => now });
  const host = manager.createRoom({ name: '房主' });
  const guestA = manager.joinRoom({ code: host.code, name: '玩家甲' });
  const guestB = manager.joinRoom({ code: host.code, name: '玩家乙' });
  manager.setReady(host.code, host.token, true);
  manager.setReady(host.code, guestA.token, true);
  manager.setReady(host.code, guestB.token, true);
  const before = manager.snapshot(host.code, host.token).game;
  now = before.turnDeadline + 1;
  assert.deepEqual(manager.tick(), [host.code]);
  const after = manager.snapshot(host.code, host.token).game;
  assert.equal(after.stateVersion, 1);
  assert.equal(after.lastAction.automated, true);
  assert.ok(after.turnDeadline > now);
});

test('三名玩家确认后可在原房间开始下一局', () => {
  const { manager, host, guestA, guestB } = readyRoom();
  manager.rooms.get(host.code).game.phase = 'ended';
  manager.setRematch(host.code, host.token, true);
  manager.setRematch(host.code, guestA.token, true);
  assert.equal(manager.snapshot(host.code, host.token).players.filter((player) => player.rematchReady).length, 2);
  manager.setRematch(host.code, guestB.token, true);
  const next = manager.snapshot(host.code, host.token);
  assert.equal(next.game.phase, 'bidding');
  assert.equal(next.players.every((player) => !player.rematchReady), true);
});
