import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { canBeat, classifyPlay, findBestGesturePlay, matchLikelyPlay, playNames, rankStrategicActions } from './gameLogic';
import { defaultLanWebSocketUrl, LanClient, readLanSession } from './lanClient';
import { canHostOnThisDevice, PhoneLanHostController } from './phoneLanHost';
import { Icon } from './icons';

const SERVER_KEY = 'token-landlords:lan-server:v1';
const GAME_SETTINGS_KEY = 'token-landlords:match-settings:v2';
let lanAudioContext = null;

function readLanEffects() {
  try {
    const settings = JSON.parse(window.localStorage.getItem(GAME_SETTINGS_KEY) || '{}');
    return { soundOn: settings.soundOn !== false, vibrationOn: settings.vibrationOn !== false };
  } catch {
    return { soundOn: true, vibrationOn: true };
  }
}

function playLanCue(type = 'action') {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    lanAudioContext ||= new AudioContextClass();
    if (lanAudioContext.state === 'suspended') lanAudioContext.resume();
    const oscillator = lanAudioContext.createOscillator();
    const gain = lanAudioContext.createGain();
    oscillator.type = type === 'bomb' ? 'sawtooth' : 'triangle';
    oscillator.frequency.value = type === 'turn' ? 660 : type === 'bomb' ? 105 : type === 'pass' ? 260 : 430;
    gain.gain.setValueAtTime(type === 'bomb' ? .055 : .035, lanAudioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, lanAudioContext.currentTime + (type === 'bomb' ? .28 : .11));
    oscillator.connect(gain).connect(lanAudioContext.destination);
    oscillator.start();
    oscillator.stop(lanAudioContext.currentTime + (type === 'bomb' ? .28 : .11));
  } catch { /* audio is optional */ }
}

function normalizeServerUrl(value) {
  let url = String(value || '').trim();
  if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, 'ws');
  else if (!/^wss?:\/\//i.test(url)) url = `ws://${url}`;
  const parsed = new URL(url);
  if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = '/ws';
  if (Capacitor.isNativePlatform() && parsed.protocol === 'ws:') {
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const privateHost = host === 'localhost' || host === '::1' || host.endsWith('.local') || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || (() => { const match = host.match(/^172\.(\d+)\./); return match && Number(match[1]) >= 16 && Number(match[1]) <= 31; })();
    if (!privateHost) throw new Error('原生版明文连接只允许同一局域网内的房主地址');
  }
  return parsed.toString();
}

function CardFace({ card, selected = false, onClick, onPointerDown, onKeyDown, compact = false }) {
  const joker = card.key === 'joker';
  return (
    <button type="button" data-card-id={card.id} aria-pressed={selected} onClick={onClick} onPointerDown={onPointerDown} onKeyDown={onKeyDown} className={`poker-card ${card.color} ${selected ? 'selected' : ''} ${compact ? 'compact' : ''} ${joker ? 'joker-card' : ''}`}>
      {joker ? <><span className="joker-letter">{card.color === 'red' ? 'B' : 'S'}</span><span className="joker-word">J<br />O<br />K<br />E<br />R</span><span className="joker-mark">{card.color === 'red' ? '王' : '♟'}</span></> : <><span className="card-rank">{card.rank}</span><span className="card-suit">{card.symbol}</span><span className="card-center">{card.symbol}</span></>}
    </button>
  );
}

function Seat({ player, cards, active, side, landlord, action, seconds }) {
  return (
    <div className={`lan-seat lan-seat-${side} ${active ? 'active' : ''}`}>
      <span className="lan-avatar">{player?.name?.slice(0, 1) || '?'}</span>
      <span><strong>{player?.name || '等待加入'}</strong><small>{player ? `${player.connected ? '在线' : '重连中'} · ${cards} 张` : '空座位'}</small></span>
      {landlord && <i>地主</i>}
      {active && <em className={`lan-seat-timer ${seconds <= 5 ? 'urgent' : ''}`}>{seconds}</em>}
      {action && <b className="lan-action-bubble">{action}</b>}
    </div>
  );
}

function LanMatch({ room, client, status, onExit }) {
  const game = room.game;
  const self = room.selfPlayer;
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [hintIndex, setHintIndex] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [actionBubble, setActionBubble] = useState(null);
  const [impact, setImpact] = useState(false);
  const [resultNotice, setResultNotice] = useState('');
  const effects = useMemo(readLanEffects, []);
  const previousVersion = useRef(game.stateVersion);
  const selectedRef = useRef(selected);
  const handElement = useRef(null);
  const dragState = useRef({ active: false, mode: 'select', visited: new Set(), initial: new Set(), pointerId: null, lastIndex: null, frame: null, lastPoint: null });
  const selectedCards = useMemo(() => game.selfHand.filter((card) => selected.includes(card.id)), [game.selfHand, selected]);
  const selectedCombo = useMemo(() => classifyPlay(selectedCards), [selectedCards]);
  const canSubmit = Boolean(selectedCombo && canBeat(selectedCombo, game.lastPlay));
  const hints = useMemo(() => rankStrategicActions(game.selfHand, game.lastPlay, {
    currentPlayer: self, landlord: game.landlord, lastPlayer: game.lastActor,
    handSizes: game.handSizes, seenCards: game.playedCards, publicCards: game.bottom,
    turnSerial: game.stateVersion, includeAlternatives: true,
  }, 'super').filter((action) => action.action === 'play').map((action) => action.cards), [game.selfHand, game.lastPlay, game.landlord, game.lastActor, game.handSizes, game.playedCards, game.bottom, game.stateVersion, self]);
  const turnSeconds = Math.max(0, Math.ceil(((game.turnDeadline || clock) - clock) / 1000));
  // Dou Dizhu proceeds counter-clockwise on this table: self -> right -> left.
  const rightSeat = (self + 2) % 3;
  const leftSeat = (self + 1) % 3;
  const playerAt = (seat) => room.players.find((player) => player.seat === seat);

  useEffect(() => {
    const activeIds = new Set(game.selfHand.map((card) => card.id));
    setSelected((items) => items.filter((id) => activeIds.has(id)));
    if (game.stateVersion !== previousVersion.current) {
      previousVersion.current = game.stateVersion;
      setBusy(false);
      setNotice('');
    }
  }, [game.selfHand, game.stateVersion]);

  useEffect(() => { selectedRef.current = selected; }, [selected]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const action = game.lastAction;
    if (!action) return undefined;
    const label = action.type === 'bid' ? (action.score ? `${action.score} 分` : '不叫') : action.type === 'pass' ? '不出' : playNames[action.combo?.type] || '出牌';
    setActionBubble({ player: action.player, label: action.automated ? `托管 · ${label}` : label });
    const special = ['bomb', 'rocket'].includes(action.combo?.type);
    if (effects.soundOn) playLanCue(special ? 'bomb' : action.type === 'pass' ? 'pass' : 'action');
    if (special) setImpact(true);
    const timer = window.setTimeout(() => setActionBubble(null), 1600);
    const impactTimer = window.setTimeout(() => setImpact(false), 650);
    return () => { window.clearTimeout(timer); window.clearTimeout(impactTimer); };
  }, [game.stateVersion, game.lastAction, effects.soundOn]);

  useEffect(() => {
    if (game.current !== self || !['bidding', 'playing'].includes(game.phase)) return;
    if (effects.soundOn) playLanCue('turn');
    if (effects.vibrationOn) navigator.vibrate?.([12, 34, 14]);
  }, [game.current, game.phase, game.stateVersion, self, effects.soundOn, effects.vibrationOn]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(''), 1900);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const cardAtPoint = (clientX, clientY) => {
      const elements = Array.from(handElement.current?.querySelectorAll('[data-card-id]') || []);
      if (!elements.length) return null;
      const rects = elements.map((element) => element.getBoundingClientRect());
      if (clientY < Math.min(...rects.map((rect) => rect.top)) - 25 || clientY > Math.max(...rects.map((rect) => rect.bottom)) + 16) return null;
      if (clientX < rects[0].left - 20 || clientX > rects.at(-1).right + 20) return null;
      for (let index = 0; index < rects.length; index += 1) {
        const rightEdge = index === rects.length - 1 ? rects[index].right + 10 : rects[index + 1].left;
        if (clientX <= rightEdge) return { id: elements[index].dataset.cardId, index };
      }
      return { id: elements.at(-1).dataset.cardId, index: elements.length - 1 };
    };
    const visitPoint = (clientX, clientY) => {
      const drag = dragState.current;
      if (!drag.active) return;
      const hit = cardAtPoint(clientX, clientY);
      if (!hit) return;
      const start = drag.lastIndex === null ? hit.index : Math.min(drag.lastIndex, hit.index);
      const end = drag.lastIndex === null ? hit.index : Math.max(drag.lastIndex, hit.index);
      drag.lastIndex = hit.index;
      const crossed = game.selfHand.slice(start, end + 1).map((card) => card.id).filter((id) => !drag.visited.has(id));
      if (!crossed.length) return;
      crossed.forEach((id) => drag.visited.add(id));
      setSelected((items) => drag.mode === 'select' ? [...new Set([...items, ...crossed])] : items.filter((id) => !crossed.includes(id)));
    };
    const move = (event) => {
      const drag = dragState.current;
      if (!drag.active || event.pointerId !== drag.pointerId) return;
      if (event.cancelable) event.preventDefault();
      drag.lastPoint = { x: event.clientX, y: event.clientY };
      if (drag.frame !== null) return;
      drag.frame = requestAnimationFrame(() => {
        drag.frame = null;
        if (drag.lastPoint) visitPoint(drag.lastPoint.x, drag.lastPoint.y);
      });
    };
    const end = (event) => {
      const drag = dragState.current;
      if (!drag.active || event.pointerId !== drag.pointerId) return;
      if (drag.frame !== null) cancelAnimationFrame(drag.frame);
      visitPoint(event.clientX, event.clientY);
      drag.active = false;
      drag.frame = null;
      if (drag.mode !== 'select' || drag.visited.size < 2 || game.phase !== 'playing') return;
      const intended = new Set([...drag.initial, ...drag.visited]);
      const gestureCards = game.selfHand.filter((card) => intended.has(card.id));
      const best = findBestGesturePlay(game.selfHand, gestureCards, game.lastPlay);
      if (!best?.length) return;
      const bestIds = best.map((card) => card.id);
      setSelected(bestIds);
      if (bestIds.length !== intended.size || bestIds.some((id) => !intended.has(id))) setNotice(`已智能吸附为${playNames[classifyPlay(best).type]}`);
    };
    const cancel = () => { if (dragState.current.frame !== null) cancelAnimationFrame(dragState.current.frame); dragState.current.active = false; dragState.current.frame = null; };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', cancel); cancel(); };
  }, [game.selfHand, game.lastPlay, game.phase]);

  useEffect(() => {
    if (game.phase !== 'playing' || !selected.length || selectedCombo || dragState.current.active) return undefined;
    const likely = matchLikelyPlay(game.selfHand, selectedCards, game.lastPlay);
    if (!likely?.length) return undefined;
    const signature = [...selected].sort().join('|');
    const timer = window.setTimeout(() => {
      if (dragState.current.active || [...selectedRef.current].sort().join('|') !== signature) return;
      setSelected(likely.map((card) => card.id));
      setNotice(`已智能匹配${playNames[classifyPlay(likely).type]}`);
    }, 420);
    return () => window.clearTimeout(timer);
  }, [game.phase, game.selfHand, game.lastPlay, selected, selectedCards, selectedCombo]);

  const startCardDrag = (event, id) => {
    if (game.phase !== 'playing' || (event.pointerType !== 'touch' && event.button !== 0)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const selecting = !selected.includes(id);
    dragState.current = { active: true, mode: selecting ? 'select' : 'remove', visited: new Set([id]), initial: new Set(selected), pointerId: event.pointerId, lastIndex: game.selfHand.findIndex((card) => card.id === id), frame: null, lastPoint: { x: event.clientX, y: event.clientY } };
    setSelected((items) => selecting ? [...new Set([...items, id])] : items.filter((item) => item !== id));
  };

  const submit = async (action) => {
    if (busy) return;
    setBusy(true);
    try {
      await client.act(action, game.stateVersion);
      await client.sync();
      setBusy(false);
    } catch (error) {
      setBusy(false);
      setNotice(error.message);
      if (error.code === 'STALE_STATE') client.sync().catch(() => {});
    }
  };

  const hint = () => {
    if (!hints.length) return setNotice('没有可以压过的牌');
    const option = hints[hintIndex % hints.length];
    setSelected(option.map((card) => card.id));
    setHintIndex((value) => (value + 1) % hints.length);
    setNotice(`提示 ${playNames[classifyPlay(option).type]} · ${hintIndex % hints.length + 1}/${hints.length}`);
  };

  if (game.phase === 'ended') {
    const won = game.winner === self || (game.landlord !== self && game.winner !== game.landlord);
    const selfPlayer = playerAt(self);
    const rematchCount = room.players.filter((player) => player.rematchReady).length;
    return <main className="lan-result"><div><span className="room-seal">斗</span><small>局域网牌局结束</small><h1>{won ? '本方获胜' : '本方落败'}</h1><p>胜者：{playerAt(game.winner)?.name} · 最终倍数 ×{game.multiplier}{game.spring ? ` · ${game.spring === 'spring' ? '春天' : '反春天'}` : ''}</p>{resultNotice && <b className="lan-result-error">{resultNotice}</b>}<div className="lan-result-actions"><button className={`btn ${selfPlayer?.rematchReady ? 'btn-ghost' : 'btn-primary'}`} disabled={busy || status !== 'connected'} onClick={async () => { setBusy(true); setResultNotice(''); try { await client.setRematch(!selfPlayer?.rematchReady); } catch (error) { setResultNotice(error.message || '操作失败，请重试'); } finally { setBusy(false); } }}>{selfPlayer?.rematchReady ? '取消再来一局' : '再来一局'} · {rematchCount}/3</button><button className="btn btn-ghost" onClick={onExit}>返回大厅</button></div></div></main>;
  }

  const confirmExit = () => {
    const copy = self === 0 ? '你是房主，退出会结束本机房间，确定离开吗？' : '退出后可以凭本机重连凭证恢复牌局，确定离开吗？';
    if (window.confirm(copy)) onExit();
  };

  return (
    <main className="lan-game">
      <header className="lan-game-header">
        <button className="icon-btn" onClick={confirmExit} aria-label="退出局域网牌局"><Icon name="close" /></button>
        <div><small>局域网好友房</small><strong>房间 {room.code}</strong></div>
        <span><small>状态版本</small><b>#{game.stateVersion}</b></span>
        <span><small>倍数</small><b>×{game.multiplier}</b></span>
      </header>
      <section className="lan-table">
        {impact && <div className="lan-impact"><b>炸</b></div>}
        <div className="table-surface premium-table"><div className="table-ring" /><div className="table-logo"><b>斗</b><span>LAN FRIEND ROOM</span></div></div>
        <Seat player={playerAt(leftSeat)} cards={game.handSizes[leftSeat]} active={game.current === leftSeat} side="left" landlord={game.landlord === leftSeat} action={actionBubble?.player === leftSeat ? actionBubble.label : ''} seconds={turnSeconds} />
        <Seat player={playerAt(rightSeat)} cards={game.handSizes[rightSeat]} active={game.current === rightSeat} side="right" landlord={game.landlord === rightSeat} action={actionBubble?.player === rightSeat ? actionBubble.label : ''} seconds={turnSeconds} />
        <div className="lan-bottom-cards"><strong>地主牌</strong><div>{game.bottom.length ? game.bottom.map((card) => <CardFace key={card.id} card={card} compact />) : Array.from({ length: game.bottomCount }, (_, index) => <i key={index}>T</i>)}</div></div>
        <div className="lan-center-play">
          {game.lastPlay ? <><small>{playerAt(game.lastPlay.player)?.name} · {playNames[game.lastPlay.type]}</small><div>{game.lastPlay.cards.map((card) => <CardFace key={card.id} card={card} compact />)}</div></> : <strong>{game.phase === 'bidding' ? '叫地主' : '新一轮牌权'}</strong>}
        </div>
        <div className={`lan-self-seat ${game.current === self ? 'active' : ''}`}><span>{playerAt(self)?.name}</span><small>{game.landlord === self ? '地主' : game.landlord === null ? '等待叫分' : '农民'} · {game.selfHand.length} 张</small>{game.current === self && <em className={`lan-seat-timer ${turnSeconds <= 5 ? 'urgent' : ''}`}>{turnSeconds}</em>}{actionBubble?.player === self && <b className="lan-action-bubble">{actionBubble.label}</b>}</div>
        <div className="lan-actions">
          {game.phase === 'bidding' ? (
            game.current === self
              ? <><button disabled={busy} onClick={() => submit({ type: 'bid', score: 0 })}>不叫</button>{[1, 2, 3].filter((score) => score > game.highestBid).map((score) => <button className="primary" disabled={busy} key={score} onClick={() => submit({ type: 'bid', score })}>{score} 分</button>)}</>
              : <span>等待 {playerAt(game.current)?.name} 叫分…</span>
          ) : (
            <><button onClick={() => setSelected([])} disabled={!selected.length || busy}>重选</button><button onClick={hint} disabled={!hints.length || busy}>提示 {hints.length ? `${hintIndex % hints.length + 1}/${hints.length}` : ''}</button><button onClick={() => submit({ type: 'pass' })} disabled={game.current !== self || !game.lastPlay || busy}>不出</button><button className="primary" disabled={game.current !== self || !selected.length || !canSubmit || busy} onClick={() => submit({ type: 'play', cardIds: selected })}>{busy ? '同步中' : canSubmit ? `出牌 · ${playNames[selectedCombo.type]}` : '请选择牌'}</button></>
          )}
        </div>
        {notice && <div className="lan-notice">{notice}</div>}
        {status !== 'connected' && <div className="lan-network-cover"><i /><strong>{status === 'reconnecting' ? '网络波动，正在自动重连' : status === 'incompatible' ? '联机版本不兼容' : '与房主连接中断'}</strong><small>{status === 'reconnecting' ? '恢复后将自动同步最新牌局' : '请检查 Wi-Fi 或房主状态'}</small></div>}
        <div ref={handElement} className="lan-hand" style={{ '--hand-count': game.selfHand.length }}>
          {game.selfHand.map((card) => <CardFace key={card.id} card={card} selected={selected.includes(card.id)} onPointerDown={(event) => startCardDrag(event, card.id)} onKeyDown={(event) => { if (event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); setSelected((items) => items.includes(card.id) ? items.filter((id) => id !== card.id) : [...items, card.id]); }} />)}
        </div>
      </section>
    </main>
  );
}

export default function LanRoom({ profile, onExit }) {
  const androidHostCapable = canHostOnThisDevice();
  const defaultUrl = useMemo(() => {
    const fallback = androidHostCapable ? 'ws://192.168.1.2:4174/ws' : defaultLanWebSocketUrl();
    try { return localStorage.getItem(SERVER_KEY) || fallback; } catch { return fallback; }
  }, [androidHostCapable]);
  const [serverUrl, setServerUrl] = useState(defaultUrl);
  const [roomCode, setRoomCode] = useState('');
  const [status, setStatus] = useState('idle');
  const [room, setRoom] = useState(null);
  const [error, setError] = useState('');
  const [hostInfo, setHostInfo] = useState(null);
  const [hostBusy, setHostBusy] = useState(false);
  const savedSession = useMemo(() => readLanSession(), []);
  const clientRef = useRef(null);
  const hostControllerRef = useRef(null);

  useEffect(() => () => {
    clientRef.current?.close();
    hostControllerRef.current?.stop();
  }, []);

  const connect = async (address = serverUrl) => {
    const url = normalizeServerUrl(address);
    clientRef.current?.close();
    const client = new LanClient({
      url,
      onStatus: setStatus,
      onMessage: (message) => {
        if (message.type === 'room_state') setRoom(message.payload);
        if (message.type === 'error' || message.type === 'host_closing') setError(message.message || '房主已结束房间');
      },
    });
    clientRef.current = client;
    await client.connect();
    localStorage.setItem(SERVER_KEY, url);
    return client;
  };

  const run = async (action) => {
    setError('');
    try { await action(await connect()); } catch (reason) { setError(reason.message); setStatus('error'); }
  };

  const startPhoneRoom = async () => {
    setError('');
    setHostBusy(true);
    try {
      await hostControllerRef.current?.stop();
      const controller = new PhoneLanHostController({ onStopped: (reason) => { setError(reason); setStatus('error'); } });
      hostControllerRef.current = controller;
      const info = await controller.start({ port: 4174 });
      setHostInfo(info);
      setServerUrl(info.webSocketUrl);
      const client = await connect(info.webSocketUrl);
      await client.createRoom(profile.name);
    } catch (reason) {
      await hostControllerRef.current?.stop();
      hostControllerRef.current = null;
      setHostInfo(null);
      setError(reason.message || '手机开房失败');
      setStatus('error');
    } finally {
      setHostBusy(false);
    }
  };

  if (room?.game) return <LanMatch room={room} client={clientRef.current} status={status} onExit={onExit} />;

  return (
    <main className="lan-lobby">
      <div className="lan-lobby-glow" />
      <section className="lan-connect-card">
        <button className="lan-close" onClick={onExit} aria-label="关闭好友房"><Icon name="close" /></button>
        <span className="room-seal">友</span>
        <small>LOCAL NETWORK · BETA</small>
        <h1>{room ? `房间 ${room.code}` : '局域网好友房'}</h1>
        {!room ? <p>{androidHostCapable ? '本机可直接担任房主；另外两台设备连接同一 Wi-Fi 或本机热点后即可加入。' : '连接同一 Wi-Fi 下的 Android 房主，输入服务地址和六位房间码即可加入。'}</p> : <p>三名玩家全部准备后，房主手机会生成唯一权威牌局。</p>}

        {!room ? (
          <>
            {androidHostCapable && <button className="btn btn-primary lan-phone-host" disabled={hostBusy} onClick={startPhoneRoom}><Icon name="users" /> {hostBusy ? '正在启动房主' : '本机创建房间'}</button>}
            {androidHostCapable && <div className="lan-divider"><span>或加入其他安卓房主</span></div>}
            <label className="lan-field"><span>房主服务地址</span><input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="ws://192.168.1.10:4174/ws" /></label>
            {Capacitor.isNativePlatform() && <small className="lan-native-note">房主地址可从对方房间页复制。使用手机热点时，另外两台设备连接该热点即可。</small>}
            <div className={`lan-create-row ${androidHostCapable ? 'join-only' : ''}`}>{!androidHostCapable && <><button className="btn btn-primary" onClick={() => run((client) => client.createRoom(profile.name))}><Icon name="users" /> 创建房间</button><i>或</i></>}<input value={roomCode} maxLength={6} onChange={(event) => setRoomCode(event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ''))} placeholder="六位房间码" /><button className="btn btn-ghost" disabled={roomCode.length !== 6} onClick={() => run((client) => client.joinRoom(roomCode, profile.name))}>加入</button></div>
            {savedSession && <button className="lan-reconnect" onClick={() => run((client) => client.reconnect(savedSession))}>恢复房间 {savedSession.code}</button>}
          </>
        ) : (
          <>
            <div className="lan-code"><span>房间码</span><b>{room.code}</b><button onClick={() => navigator.clipboard?.writeText(room.code)}>复制</button></div>
            {hostInfo && <div className="lan-host-share"><span>牌友浏览器打开</span><b>{hostInfo.httpAddresses?.[0] || '请先连接 Wi-Fi 或开启热点'}</b>{hostInfo.httpAddresses?.[0] && <button onClick={() => navigator.clipboard?.writeText(hostInfo.httpAddresses[0])}>复制地址</button>}</div>}
            <div className="lan-player-list">{[0, 1, 2].map((seat) => { const player = room.players.find((item) => item.seat === seat); return <div key={seat} className={player?.ready ? 'ready' : ''}><i>{seat + 1}</i><span><strong>{player?.name || '等待牌友加入'}</strong><small>{player ? player.ready ? '已准备' : player.connected ? '在线 · 未准备' : '等待重连' : '空座位'}</small></span>{player?.ready && <Icon name="check" />}</div>; })}</div>
            <button className="btn btn-primary lan-ready" onClick={() => { setError(''); clientRef.current.setReady(!room.players.find((player) => player.seat === room.selfPlayer)?.ready).catch((reason) => setError(reason.message)); }}>{room.players.find((player) => player.seat === room.selfPlayer)?.ready ? '取消准备' : '准备开局'}</button>
          </>
        )}
        <footer><i className={`connection-dot ${status}`} /> {status === 'connected' ? '已连接房主' : status === 'connecting' ? '正在连接' : status === 'reconnecting' ? '正在自动重连' : status === 'incompatible' ? '版本不兼容' : status === 'error' ? '连接失败' : '等待连接'}{error && <b>{error}</b>}</footer>
      </section>
    </main>
  );
}
