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
