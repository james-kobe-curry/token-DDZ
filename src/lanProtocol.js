export const LAN_PROTOCOL_VERSION = 3;
export const LAN_CLIENT_VERSION = '0.1.10';
export const LAN_TURN_TIME_MS = 20_000;
export const LAN_DISCONNECT_GRACE_MS = 8_000;

export function protocolPayload(extra = {}) {
  return { protocolVersion: LAN_PROTOCOL_VERSION, clientVersion: LAN_CLIENT_VERSION, ...extra };
}
