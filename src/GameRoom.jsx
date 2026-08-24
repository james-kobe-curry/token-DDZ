import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Icon } from './icons';
import {
  AI_DIFFICULTIES,
  analyzeAiDecision,
  canBeat,
  calculateSpring,
  classifyPlay,
  createSeed,
  dealWithSeed,
  estimateBid,
  evaluatePassDecision,
  evaluatePlayDecision,
  findBestGesturePlay,
  GAME_RULES,
  matchLikelyOptions,
  nextPlayerCounterClockwise,
  playNames,
  rankStrategicActions,
  removeCards,
  sha256,
} from './gameLogic';

const IS_NATIVE_PLATFORM = Capacitor.isNativePlatform();
const GameVoice = registerPlugin('GameVoice');
const BOT_NAMES = ['墨客·小七', '红袖·阿洛'];
const COMBO_COPY = {
  bomb: ['炸', '一锤定音'], rocket: ['王', '天地同辉'], straight: ['顺', '行云流水'],
  pair_straight: ['连', '珠联璧合'], airplane: ['飞', '扶摇直上'],
  airplane_single: ['飞', '扶摇直上'], airplane_pair: ['飞', '扶摇直上'],
};
const CARD_BACK_SKINS = {
  '墨玉牌背': 'card-back-ink', '青玉牌背': 'card-back-jade',
  '赤霞牌背': 'card-back-sunset', '创世链路': 'card-back-genesis',
};
const GAME_SETTINGS_KEY = 'token-landlords:match-settings:v2';
const DEFAULT_GAME_SETTINGS = { soundOn: true, voiceOn: true, vibrationOn: true, smartArrange: true, autoMatch: true, motionOn: true, aiDifficulty: 'elite' };

function loadGameSettings() {
  if (typeof window === 'undefined') return DEFAULT_GAME_SETTINGS;
  try {
    return { ...DEFAULT_GAME_SETTINGS, ...JSON.parse(window.localStorage.getItem(GAME_SETTINGS_KEY) || '{}') };
  } catch {
    return DEFAULT_GAME_SETTINGS;
  }
}

const SOUND_PRESETS = {
  select: { notes: [520], duration: .045, type: 'sine', volume: .035 },
  deal: { notes: [740, 590, 690], duration: .045, gap: .036, type: 'triangle', volume: .035, noise: { duration: .09, volume: .018, frequency: 1800 } },
  card: { notes: [310, 470], duration: .055, gap: .026, type: 'triangle', volume: .045, noise: { duration: .045, volume: .012, frequency: 1450 } },
  pair: { notes: [330, 330, 495], duration: .052, gap: .045, type: 'triangle', volume: .045 },
  triple: { notes: [294, 370, 494], duration: .065, gap: .042, type: 'triangle', volume: .05 },
  action: { notes: [260, 390], duration: .08, gap: .05, type: 'triangle', volume: .045 },
  pass: { notes: [220, 180], duration: .075, type: 'sine', volume: .035 },
  bid: { notes: [330, 440], duration: .09, type: 'triangle', volume: .05 },
  landlord: { notes: [196, 294, 392, 523], duration: .13, type: 'triangle', volume: .06 },
  combo: { notes: [262, 330, 392, 523, 659], duration: .09, gap: .042, type: 'triangle', volume: .05 },
  impact: { notes: [110, 82, 165], duration: .18, gap: .065, type: 'sawtooth', volume: .045, noise: { duration: .25, volume: .04, frequency: 230 } },
  win: { notes: [262, 330, 392, 523, 659, 784], duration: .13, gap: .075, type: 'triangle', volume: .055 },
  loss: { notes: [392, 330, 262, 196], duration: .16, gap: .09, type: 'sine', volume: .045 },
  error: { notes: [190, 155], duration: .1, type: 'square', volume: .025 },
  tick: { notes: [680], duration: .035, type: 'sine', volume: .025 },
  turn: { notes: [392, 587], duration: .11, type: 'triangle', volume: .05 },
};

function useGameAudio(enabled) {
  const contextRef = useRef(null);
  useEffect(() => () => contextRef.current?.close(), []);
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    const unlock = () => {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      contextRef.current ||= new AudioContext();
      if (contextRef.current.state === 'suspended') contextRef.current.resume();
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, [enabled]);
  return useCallback((name, pan = 0) => {
    if (!enabled || typeof window === 'undefined') return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const context = contextRef.current || new AudioContext();
    contextRef.current = context;
    if (context.state === 'suspended') context.resume();
    const preset = SOUND_PRESETS[name] || SOUND_PRESETS.action;
    const start = context.currentTime + .008;
    const gap = preset.gap ?? .055;
    preset.notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const panner = context.createStereoPanner?.();
      oscillator.type = preset.type;
      oscillator.frequency.setValueAtTime(frequency, start + index * gap);
      gain.gain.setValueAtTime(.0001, start + index * gap);
      gain.gain.exponentialRampToValueAtTime(preset.volume, start + index * gap + .008);
      gain.gain.exponentialRampToValueAtTime(.0001, start + index * gap + preset.duration);
      if (panner) {
        panner.pan.value = pan;
        oscillator.connect(gain).connect(panner).connect(context.destination);
      } else oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + index * gap);
      oscillator.stop(start + index * gap + preset.duration + .02);
    });
    if (preset.noise) {
      const frames = Math.max(1, Math.floor(context.sampleRate * preset.noise.duration));
      const buffer = context.createBuffer(1, frames, context.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let index = 0; index < frames; index += 1) samples[index] = (Math.random() * 2 - 1) * (1 - index / frames);
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      const panner = context.createStereoPanner?.();
      source.buffer = buffer;
      filter.type = preset.noise.frequency < 500 ? 'lowpass' : 'bandpass';
      filter.frequency.value = preset.noise.frequency;
      filter.Q.value = 1.4;
      gain.gain.setValueAtTime(preset.noise.volume, start);
      gain.gain.exponentialRampToValueAtTime(.0001, start + preset.noise.duration);
      if (panner) {
        panner.pan.value = pan;
        source.connect(filter).connect(gain).connect(panner).connect(context.destination);
      } else source.connect(filter).connect(gain).connect(context.destination);
      source.start(start);
    }
  }, [enabled]);
}

function useGameVoice(enabled) {
  useEffect(() => () => {
    if (IS_NATIVE_PLATFORM) GameVoice.stop().catch(() => {});
    else window.speechSynthesis?.cancel();
  }, []);
  return useCallback((text, { rate = .96, pitch = 1, interrupt = true } = {}) => {
    if (!enabled || !text || typeof window === 'undefined') return;
    const speakInBrowser = () => {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
      if (interrupt) window.speechSynthesis.cancel();
      const utterance = new window.SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = rate;
      utterance.pitch = pitch;
      utterance.volume = .9;
      const chineseVoice = window.speechSynthesis.getVoices().find((voice) => /^zh[-_]/i.test(voice.lang));
      if (chineseVoice) utterance.voice = chineseVoice;
      window.speechSynthesis.speak(utterance);
    };
    if (IS_NATIVE_PLATFORM) {
      GameVoice.speak({ text, rate, pitch, interrupt, volume: .9 }).catch(speakInBrowser);
    } else speakInBrowser();
  }, [enabled]);
}

function Card({ card, selected, preview = false, onPointerDown, onPointerEnter, onDoubleClick, onKeyDown, groupBreak = false, compact = false, hidden = false, backSkin = '', style }) {
  if (hidden) return <div className={`poker-card card-back ${backSkin} ${compact ? 'compact' : ''}`} style={style}><span>TL</span></div>;
  const joker = card.key === 'joker';
  return (
    <button
      className={`poker-card ${card.color} ${selected ? 'selected' : ''} ${preview ? 'match-preview' : ''} ${groupBreak ? 'rank-break' : ''} ${compact ? 'compact' : ''} ${joker ? 'joker-card' : ''}`}
      data-card-id={card.id}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      aria-label={card.label || `${card.rank}${card.symbol}`}
      aria-pressed={onPointerDown ? selected : undefined}
      tabIndex={onPointerDown ? 0 : -1}
      style={style}
      type="button"
    >
      {joker ? (
        <><span className="joker-letter">J</span><span className="joker-word">O<br />K<br />E<br />R</span><span className="joker-mark">{card.rank === 'BJ' ? '★' : '◇'}</span></>
      ) : (
        <><span className="card-rank">{card.rank}</span><span className="card-suit">{card.symbol}</span><span className="card-center">{card.symbol}</span></>
      )}
    </button>
  );
}

function ActionBubble({ event }) {
  if (!event) return null;
  return <span className={`seat-action-bubble tone-${event.tone || 'normal'}`} key={event.key}>{event.text}</span>;
}

function Avatar({ index, landlord, current, cards, side, turnTime, action, backSkin, threat = false, aiDifficulty = 'elite', thought = '' }) {
  const name = BOT_NAMES[index - 1];
  const aiLevel = AI_DIFFICULTIES[aiDifficulty] || AI_DIFFICULTIES.elite;
  return (
    <div className={`opponent opponent-${side} ${current ? 'active' : ''} ${threat ? 'threat' : ''}`}>
      <ActionBubble event={action} />
      {threat && <span className="threat-flag"><i />{cards === 1 ? '报单' : '报双'}</span>}
      <div className="avatar-wrap">
        <div className={`avatar avatar-${index}`}>{index === 1 ? '七' : '洛'}</div>
        {landlord === index && <span className="landlord-tag"><i>主</i> 地主</span>}
        {current && <span className={`turn-timer avatar-timer ${turnTime <= 5 ? 'urgent' : ''}`} style={{ '--timer-progress': turnTime / 20 }}>{turnTime}</span>}
      </div>
      <span className="compact-seat-label"><b>{name}</b><em>{aiLevel.shortName}</em></span>
      <div className="opponent-meta"><strong>{name}<em className={`ai-level ai-${aiLevel.id}`}>{aiLevel.shortName}</em></strong><span title={thought}>{threat ? `仅剩 ${cards} 张 · 注意封堵` : current ? <>正在计算可能牌路<i className="thinking-dots"><b /><b /><b /></i></> : thought || (landlord === null ? '等待叫分' : landlord === index ? '地主阵营' : '农民阵营')}</span></div>
      <div className="remaining-cards"><span>{cards}</span><small>剩余</small></div>
      <div className={`opponent-card-fan ${backSkin}`} aria-hidden="true"><i /><i /><i /></div>
    </div>
  );
}

function PlayedCards({ play }) {
  if (!play?.cards?.length) return null;
  return (
    <div className={`played-cards played-from-${play.player}`} style={{ '--played-count': play.cards.length }} aria-label={`已打出${play.cards.length}张牌`}>
      {play.cards.map((card, index) => <Card card={card} compact key={card.id} style={{ '--played-i': index }} />)}
    </div>
  );
}

function makeReplayFrame(state, event) {
  return {
    key: `${Date.now()}-${state.replay?.length || 0}-${event.actor ?? 'system'}`,
    actor: event.actor ?? null,
    label: event.label,
    type: event.type || 'system',
    cards: event.cards || [],
    hands: state.hands.map((hand) => [...hand]),
    current: state.current,
    landlord: state.landlord,
    multiplier: state.multiplier,
    bottom: [...state.bottom],
    lastPlay: state.lastPlay ? { ...state.lastPlay, cards: [...(state.lastPlay.cards || [])] } : null,
    passCount: state.passCount || 0,
  };
}

function withReplayFrame(state, event) {
  return { ...state, replay: [...(state.replay || []), makeReplayFrame(state, event)] };
}

function ReplayHand({ title, hand, role }) {
  return (
    <div className="replay-hand-row">
      <span><i>{role}</i><strong>{title}</strong><small>{hand.length} 张</small></span>
      <div>{hand.map((card) => <b className={card.color} key={card.id}>{card.rank === 'SJ' ? '小王' : card.rank === 'BJ' ? '大王' : card.rank}<em>{card.key === 'joker' ? '' : card.symbol}</em></b>)}</div>
    </div>
  );
}

function buildReplayAnalysis(frames, index) {
  const frame = frames[index];
  const before = frames[index - 1];
  if (!frame) return null;
  if (before && frame.actor !== null && frame.cards?.length) {
    return { ...evaluatePlayDecision(before.hands[frame.actor], before.lastPlay, frame.cards), decision: true };
  }
  if (before && frame.type === 'pass' && frame.actor !== null) {
    return {
      ...evaluatePassDecision(before.hands[frame.actor], before.lastPlay, {
        currentPlayer: frame.actor,
        landlord: before.landlord,
        lastPlayer: before.lastPlay?.player ?? null,
        handSizes: before.hands.map((hand) => hand.length),
      }),
      decision: true,
    };
  }
  if (frame.type === 'bid') return { tone: 'neutral', title: '叫分决策', detail: '叫分决定地主归属与初始倍率，后续可结合底牌验证风险。', recommended: null, decision: false };
  if (frame.type === 'landlord') return { tone: 'good', title: '阵营已经确定', detail: '地主获得三张底牌，接下来应优先规划长牌型和收尾牌权。', recommended: null, decision: false };
  if (frame.type === 'result') return { tone: 'good', title: '本局已经结算', detail: '可以回看红色关键节点，比较实战选择与推荐牌路。', recommended: null, decision: false };
  return { tone: 'neutral', title: '牌局起点', detail: '三家初始手牌与公平摘要已锁定，时间轴将记录全部关键决策。', recommended: null, decision: false };
}

function ReplayModal({ frames, fairness, onClose, initialIndex = 0 }) {
  const [index, setIndex] = useState(Math.min(initialIndex, Math.max(0, frames.length - 1)));
  const [playing, setPlaying] = useState(false);
  const frame = frames[Math.min(index, frames.length - 1)];
  const analyses = useMemo(() => frames.map((_, frameIndex) => buildReplayAnalysis(frames, frameIndex)), [frames]);
  const analysis = analyses[Math.min(index, analyses.length - 1)];
  const analysisStats = useMemo(() => analyses.reduce((stats, item) => {
    if (!item?.decision) return stats;
    stats.total += 1;
    stats[item.tone] = (stats[item.tone] || 0) + 1;
    return stats;
  }, { total: 0, good: 0, watch: 0, critical: 0 }), [analyses]);
  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setInterval(() => {
      setIndex((value) => {
        if (value >= frames.length - 1) {
          setPlaying(false);
          return value;
        }
        return value + 1;
      });
    }, 1050);
    return () => window.clearInterval(timer);
  }, [playing, frames.length]);
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'ArrowLeft') setIndex((value) => Math.max(0, value - 1));
      if (event.key === 'ArrowRight') setIndex((value) => Math.min(frames.length - 1, value + 1));
      if (event.key === ' ') { event.preventDefault(); setPlaying((value) => !value); }
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [frames.length, onClose]);
  if (!frame) return null;
  const names = ['你', BOT_NAMES[0], BOT_NAMES[1]];
  return (
    <div className="replay-layer">
      <section className="replay-modal" role="dialog" aria-modal="true" aria-label="本局复盘">
        <header>
          <div><span className="replay-seal">复</span><p><small>MATCH REPLAY</small><strong>本局牌路复盘</strong></p></div>
          <div className="replay-proof"><Icon name="shield" size={15} /><span><small>公平摘要</small><code>{fairness.commit.slice(0, 12)}…</code></span></div>
          <button onClick={onClose} aria-label="关闭复盘"><Icon name="close" size={19} /></button>
        </header>
        <div className="replay-stage">
          <div className={`replay-seat replay-seat-left ${frame.actor === 1 ? 'active' : ''}`}><i>七</i><span><strong>{BOT_NAMES[0]}</strong><small>{frame.hands[1].length} 张 · {frame.landlord === null ? '身份待定' : frame.landlord === 1 ? '地主' : '农民'}</small></span></div>
          <div className={`replay-seat replay-seat-right ${frame.actor === 2 ? 'active' : ''}`}><span><strong>{BOT_NAMES[1]}</strong><small>{frame.hands[2].length} 张 · {frame.landlord === null ? '身份待定' : frame.landlord === 2 ? '地主' : '农民'}</small></span><i>洛</i></div>
          <div className="replay-event">
            <small>第 {index + 1} 步 · 倍数 ×{frame.multiplier}</small>
            <strong>{frame.label}</strong>
            {frame.cards.length > 0 && <div>{frame.cards.map((card, cardIndex) => <Card card={card} compact key={`${card.id}-${cardIndex}`} style={{ '--played-i': cardIndex }} />)}</div>}
          </div>
          <div className={`replay-self ${frame.actor === 0 ? 'active' : ''}`}><i>玩</i><span><strong>你</strong><small>{frame.hands[0].length} 张 · {frame.landlord === null ? '身份待定' : frame.landlord === 0 ? '地主' : '农民'}</small></span></div>
        </div>
        <div className="replay-hands">
          {analysis && (
            <div className={`replay-analysis tone-${analysis.tone}`}>
              <div className="analysis-badge"><Icon name="spark" size={18} /><span><strong>策略复盘</strong><small>{analysisStats.total ? `${analysisStats.good} 次稳健 · ${analysisStats.watch + analysisStats.critical} 个关注点` : '等待关键决策'}</small></span></div>
              <div className="analysis-copy"><strong>{analysis.title}</strong><p>{analysis.detail}</p></div>
              {analysis.recommended?.length > 0 && <div className="analysis-recommend"><small>推荐牌路</small><span>{analysis.recommended.map((card) => <b className={card.color} key={card.id}>{card.rank === 'SJ' ? '小王' : card.rank === 'BJ' ? '大王' : card.rank}<em>{card.key === 'joker' ? '' : card.symbol}</em></b>)}</span></div>}
            </div>
          )}
          {[0, 1, 2].map((player) => <ReplayHand key={player} title={names[player]} hand={frame.hands[player]} role={frame.landlord === null ? '待定' : frame.landlord === player ? '地主' : '农民'} />)}
        </div>
        <div className="replay-timeline">
          <div className="timeline-track">{frames.map((item, frameIndex) => <button className={`${frameIndex === index ? 'active' : ''} type-${item.type} analysis-${analyses[frameIndex]?.tone || 'neutral'}`} title={analyses[frameIndex]?.title} onClick={() => { setIndex(frameIndex); setPlaying(false); }} key={item.key}><i /><span>{item.label}</span></button>)}</div>
          <div className="replay-controls">
            <button onClick={() => { setPlaying(false); setIndex((value) => Math.max(0, value - 1)); }} disabled={index === 0}><Icon name="arrow" size={16} /> 上一步</button>
            <button className="replay-play" onClick={() => { if (index === frames.length - 1) setIndex(0); setPlaying((value) => !value); }}><Icon name={playing ? 'pause' : 'play'} size={17} /> {playing ? '暂停' : '自动播放'}</button>
            <button onClick={() => { setPlaying(false); setIndex((value) => Math.min(frames.length - 1, value + 1)); }} disabled={index === frames.length - 1}>下一步 <Icon name="arrow" size={16} /></button>
            <span>{index + 1} / {frames.length}</span>
          </div>
        </div>
      </section>
    </div>
  );
}

function GameResult({ result, multiplier, onAgain, onExit, onReplay, fairness }) {
  const [showProof, setShowProof] = useState(false);
  const copyProof = () => navigator.clipboard?.writeText(`commit:${fairness.commit}\nseed:${fairness.seed}`);
  return (
    <div className="modal-layer">
      <div className={`result-modal ${result.won ? 'win' : 'loss'}`}>
        <div className="result-rays" />
        <button type="button" className="result-close" onClick={onExit} aria-label="关闭结算并返回大厅"><Icon name="close" size={18} /></button>
        <div className="result-icon">{result.won ? '胜' : '惜'}</div>
        <p className="eyebrow">{result.ranked ? 'RANKED MATCH' : 'CLASSIC MATCH'}</p>
        <h2>{result.won ? '漂亮的一局！' : '差一点，下一局拿下'}</h2>
        <p className="result-sub">{result.text}</p>
        {result.spring && <div className="spring-result"><i>×2</i><span><strong>{result.spring === 'spring' ? '春天' : '反春天'}</strong><small>本局结算倍数翻倍</small></span></div>}
        <div className="result-stats">
          <div><span>倍数</span><strong>×{multiplier}</strong></div>
          <div><span>Token</span><strong className={result.won ? 'positive' : ''}>{result.won ? `+${result.tokens}` : '+0'}</strong></div>
          <div><span>排位分</span><strong className={result.rating >= 0 ? 'positive' : 'negative'}>{result.rating > 0 ? '+' : ''}{result.rating}</strong></div>
        </div>
        <div className="reward-breakdown">
          {result.breakdown.map((item) => <span key={item.label}><small>{item.label}</small><b>+{item.value}</b></span>)}
          <em>奖励上限 {result.rewardPool} Token</em>
        </div>
        <button type="button" className="result-replay-button" onClick={onReplay}>
          <span><Icon name="clock" size={18} /><b>复盘本局</b></span>
          <small>查看完整牌路与每一步剩余手牌</small>
          <Icon name="arrow" size={17} />
        </button>
        <div className="result-actions">
          <button type="button" className="btn btn-ghost" onClick={onExit}>返回大厅</button>
          <button type="button" className="btn btn-primary" onClick={onAgain}>再来一局 <Icon name="arrow" size={17} /></button>
        </div>
        <button type="button" className="proof-toggle" onClick={() => setShowProof(!showProof)}><Icon name="shield" size={16} /> {showProof ? '收起公平凭证' : '查看本局公平凭证'}</button>
        {showProof && (
          <div className="proof-box result-proof">
            <p><span>洗牌摘要</span><code>{fairness.commit}</code></p>
            <p><span>公开种子</span><code>{fairness.seed}</code></p>
            <button onClick={copyProof}><Icon name="copy" size={15} /> 复制凭证</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function GameRoom({ ranked, profile, onExit, onFinish }) {
  useEffect(() => {
    document.body.classList.add('game-active');
    return () => document.body.classList.remove('game-active');
  }, []);

  const initialSettings = useMemo(loadGameSettings, []);
  const [round, setRound] = useState(0);
  const [game, setGame] = useState(null);
  const [selected, setSelected] = useState([]);
  const [toast, setToast] = useState('正在生成可验证牌局…');
  const [proofOpen, setProofOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(initialSettings.soundOn);
  const [voiceOn, setVoiceOn] = useState(initialSettings.voiceOn);
  const [vibrationOn, setVibrationOn] = useState(initialSettings.vibrationOn);
  const [utilityPanel, setUtilityPanel] = useState(null);
  const [turnTime, setTurnTime] = useState(20);
  const [comboFx, setComboFx] = useState(null);
  const [actionBubbles, setActionBubbles] = useState({});
  const [landlordFx, setLandlordFx] = useState(null);
  const [invalidSelection, setInvalidSelection] = useState(false);
  const [smartArrange, setSmartArrange] = useState(initialSettings.smartArrange);
  const [autoMatch, setAutoMatch] = useState(initialSettings.autoMatch);
  const [manualMatchSuppressed, setManualMatchSuppressed] = useState(false);
  const [motionOn, setMotionOn] = useState(initialSettings.motionOn);
  const [aiDifficulty, setAiDifficulty] = useState(AI_DIFFICULTIES[initialSettings.aiDifficulty] ? initialSettings.aiDifficulty : 'elite');
  const [actionLocked, setActionLocked] = useState(false);
  const [hintCursor, setHintCursor] = useState(0);
  const [gestureSnap, setGestureSnap] = useState(false);
  const [turnTakeover, setTurnTakeover] = useState(false);
  const [leadReturnFx, setLeadReturnFx] = useState(null);
  const [handDealing, setHandDealing] = useState(false);
  const [aiThoughts, setAiThoughts] = useState({});
  const [strategicActions, setStrategicActions] = useState([]);
  const [hintLoading, setHintLoading] = useState(false);
  const rewarded = useRef(false);
  const bubbleTimers = useRef({});
  const eventTimers = useRef([]);
  const previousLandlord = useRef(null);
  const dragState = useRef({ active: false, mode: 'select', visited: new Set(), initial: new Set(), pointerId: null, frame: null, lastPoint: null, lastIndex: null, lastHapticAt: 0 });
  const autoHandled = useRef(false);
  const actionLockRef = useRef(false);
  const actionUnlockTimer = useRef(null);
  const autoMatchPauseUntil = useRef(0);
  const selectedRef = useRef([]);
  const previousTurnKey = useRef(null);
  const landlordAnimationUntil = useRef(0);
  const dealAnimationTimer = useRef(null);
  const handElement = useRef(null);
  const previousHandPositions = useRef(new Map());
  const aiWorker = useRef(null);
  const aiRequests = useRef(new Map());
  const aiRequestSerial = useRef(0);
  const hintCursorRef = useRef(0);
  const playSfx = useGameAudio(soundOn);
  const speakGame = useGameVoice(voiceOn);
  const rewardPool = ranked ? 420 : 300;
  const cardBackSkin = CARD_BACK_SKINS[profile.equipped] || CARD_BACK_SKINS['墨玉牌背'];

  const requestAiAnalysis = useCallback((type, payload) => {
    const fallback = () => type === 'decision'
      ? analyzeAiDecision(payload.hand, payload.previous, payload.context)
      : rankStrategicActions(payload.hand, payload.previous, payload.context, payload.difficulty || 'super');
    if (!aiWorker.current) return Promise.resolve(fallback());
    const id = ++aiRequestSerial.current;
    return new Promise((resolve) => {
      aiRequests.current.set(id, { resolve, fallback });
      aiWorker.current.postMessage({ id, type, payload });
    });
  }, []);

  useEffect(() => {
    if (typeof Worker === 'undefined') return undefined;
    const worker = new Worker(new URL('./aiWorker.js', import.meta.url), { type: 'module' });
    aiWorker.current = worker;
    worker.onmessage = ({ data }) => {
      const request = aiRequests.current.get(data.id);
      if (!request) return;
      aiRequests.current.delete(data.id);
      request.resolve(data.error ? request.fallback() : data.result);
    };
    worker.onerror = () => {
      aiRequests.current.forEach((request) => request.resolve(request.fallback()));
      aiRequests.current.clear();
      worker.terminate();
      if (aiWorker.current === worker) aiWorker.current = null;
    };
    return () => {
      worker.terminate();
      aiRequests.current.forEach((request) => request.resolve(request.fallback()));
      aiRequests.current.clear();
      if (aiWorker.current === worker) aiWorker.current = null;
    };
  }, []);

  const vibrate = useCallback((pattern = 8) => {
    if (!vibrationOn) return;
    if (IS_NATIVE_PLATFORM) {
      const strong = Array.isArray(pattern) || pattern >= 20;
      Haptics.impact({ style: strong ? ImpactStyle.Heavy : ImpactStyle.Light }).catch(() => {});
      return;
    }
    if (typeof navigator !== 'undefined') navigator.vibrate?.(pattern);
  }, [vibrationOn]);

  const releaseActionLock = useCallback(() => {
    actionLockRef.current = false;
    window.clearTimeout(actionUnlockTimer.current);
    setActionLocked(false);
  }, []);

  const acquireActionLock = useCallback(() => {
    if (actionLockRef.current) return false;
    actionLockRef.current = true;
    setActionLocked(true);
    window.clearTimeout(actionUnlockTimer.current);
    actionUnlockTimer.current = window.setTimeout(releaseActionLock, 1100);
    return true;
  }, [releaseActionLock]);

  const showAction = useCallback((player, text, tone = 'normal', duration = 1150) => {
    const event = { text, tone, key: Date.now() + player };
    setActionBubbles((items) => ({ ...items, [player]: event }));
    window.clearTimeout(bubbleTimers.current[player]);
    bubbleTimers.current[player] = window.setTimeout(() => {
      setActionBubbles((items) => items[player]?.key === event.key ? { ...items, [player]: null } : items);
    }, duration);
  }, []);

  useEffect(() => () => {
    Object.values(bubbleTimers.current).forEach(window.clearTimeout);
    eventTimers.current.forEach(window.clearTimeout);
    window.clearTimeout(actionUnlockTimer.current);
    window.clearTimeout(dealAnimationTimer.current);
  }, []);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    try {
      window.localStorage.setItem(GAME_SETTINGS_KEY, JSON.stringify({ soundOn, voiceOn, vibrationOn, smartArrange, autoMatch, motionOn, aiDifficulty }));
    } catch {
      // Browsers may deny storage in privacy mode; gameplay remains available.
    }
  }, [soundOn, voiceOn, vibrationOn, smartArrange, autoMatch, motionOn, aiDifficulty]);

  useEffect(() => {
    if (!actionLockRef.current) return undefined;
    const timer = window.setTimeout(releaseActionLock, 260);
    return () => window.clearTimeout(timer);
  }, [game?.phase, game?.current, game?.bidCount, releaseActionLock]);

  useEffect(() => {
    let live = true;
    async function init() {
      rewarded.current = false;
      releaseActionLock();
      window.clearTimeout(dealAnimationTimer.current);
      setHandDealing(false);
      setSelected([]);
      setManualMatchSuppressed(false);
      setActionBubbles({});
      setAiThoughts({});
      setStrategicActions([]);
      setHintLoading(false);
      setLandlordFx(null);
      setLeadReturnFx(null);
      setTurnTakeover(false);
      setReplayOpen(false);
      previousLandlord.current = null;
      previousTurnKey.current = null;
      landlordAnimationUntil.current = 0;
      const seed = createSeed();
      const dealt = dealWithSeed(seed);
      const commit = await sha256(`${seed}:${dealt.deckOrder.join('|')}`);
      if (!live) return;
      const demoMode = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('demo') : null;
      const demoReplay = demoMode === 'replay';
      const demoResult = demoMode === 'result' || demoReplay;
      const demoMatching = demoMode === 'matching';
      const demoThreat = demoMode === 'threat';
      const demoWaiting = demoMode === 'waiting';
      const demoPlaying = demoMode === 'playing' || demoMode === 'selected' || demoMatching || demoThreat || demoWaiting || demoResult;
      const initialHands = demoPlaying
        ? dealt.hands.map((hand, index) => index === 0 ? (demoResult ? [] : [...hand, ...dealt.bottom].sort((a, b) => b.value - a.value)) : demoThreat && index === 2 ? hand.slice(-1) : hand)
        : dealt.hands;
      const demoPairCard = demoMatching ? initialHands[0].find((card, index, cards) => card.value > 3 && cards.some((candidate, candidateIndex) => candidateIndex !== index && candidate.rank === card.rank)) : null;
      const lowerTemplate = demoPairCard ? dealt.hands.flat().find((card) => card.value === demoPairCard.value - 1) : null;
      const demoTargetCards = lowerTemplate ? [{ ...lowerTemplate, id: 'demo-target-a' }, { ...lowerTemplate, id: 'demo-target-b' }] : null;
      const initialState = {
        phase: demoResult ? 'ended' : demoPlaying ? 'playing' : 'bidding', hands: initialHands, bottom: dealt.bottom, seed, commit, deckOrder: dealt.deckOrder,
        current: demoWaiting ? 1 : 0, turnSerial: 0, highestBid: 0, highestBidder: null, bidCount: 0, bids: [], landlord: demoPlaying ? 0 : null,
        lastPlay: demoTargetCards ? { ...classifyPlay(demoTargetCards), cards: demoTargetCards, player: 2 } : null, lastActor: demoTargetCards ? 2 : null, passCount: 0, multiplier: demoResult ? 2 : 1, winner: demoResult ? 0 : null, spring: demoResult ? 'spring' : null,
        playCounts: demoResult ? [1, 0, 0] : [0, 0, 0],
        playedCards: demoTargetCards || [],
        trail: demoMode === 'selected' ? [{ player: 1, text: '不出', key: 'demo-1' }, { player: 2, text: '单张', key: 'demo-2' }, { player: 0, text: '对子', key: 'demo-3' }] : [],
        logs: ['牌局摘要已生成'],
        replay: [],
      };
      if (demoReplay) {
        const dealState = { ...initialState, phase: 'bidding', hands: dealt.hands, landlord: null, current: 0, winner: null, spring: null, multiplier: 1, replay: [] };
        const landlordHands = dealt.hands.map((hand, player) => player === 0 ? [...hand, ...dealt.bottom].sort((a, b) => b.value - a.value) : hand);
        const firstPlay = landlordHands[0].slice(-1);
        const afterFirstPlay = landlordHands.map((hand, player) => player === 0 ? removeCards(hand, firstPlay) : hand);
        const firstCombo = classifyPlay(firstPlay);
        const afterPlayState = { ...dealState, hands: afterFirstPlay, landlord: 0, current: 1, lastPlay: { ...firstCombo, cards: firstPlay, player: 0 } };
        const finalState = { ...initialState, replay: [] };
        initialState.replay = [
          makeReplayFrame(dealState, { label: '牌局已锁定', type: 'deal' }),
          makeReplayFrame({ ...dealState, current: 1 }, { actor: 0, label: '你 · 叫 3 分', type: 'bid' }),
          makeReplayFrame({ ...dealState, hands: landlordHands, landlord: 0, current: 0 }, { actor: 0, label: '你成为地主', type: 'landlord' }),
          makeReplayFrame(afterPlayState, { actor: 0, label: '你 · 单张', type: 'play', cards: firstPlay }),
          makeReplayFrame({ ...afterPlayState, current: 2, passCount: 1 }, { actor: 1, label: `${BOT_NAMES[0]} · 不出`, type: 'pass' }),
          makeReplayFrame(finalState, { actor: 0, label: '你赢得本局 · 春天', type: 'result' }),
        ];
      } else {
        initialState.replay = [makeReplayFrame(initialState, { label: '牌局已锁定', type: 'deal' })];
      }
      if (demoPlaying) previousLandlord.current = 0;
      setHandDealing(true);
      setGame(initialState);
      dealAnimationTimer.current = window.setTimeout(() => setHandDealing(false), 1020);
      if (demoMode === 'selected') {
        const pairRank = initialHands[0].find((card, index, cards) => cards.some((candidate, candidateIndex) => candidateIndex !== index && candidate.rank === card.rank))?.rank;
        setSelected(initialHands[0].filter((card) => card.rank === pairRank).slice(0, 2).map((card) => card.id));
      }
      if (demoMatching && demoPairCard) setSelected([demoPairCard.id]);
      if (demoReplay) setReplayOpen(true);
      setToast(demoPlaying ? '' : '请选择叫分');
      playSfx('deal');
    }
    init();
    return () => { live = false; };
  }, [round, releaseActionLock]);

  useLayoutEffect(() => {
    const cards = Array.from(handElement.current?.querySelectorAll('[data-card-id]') || []);
    const nextPositions = new Map(cards.map((card) => [card.dataset.cardId, card.getBoundingClientRect()]));

    // WebView transform animations on an overlapping 17-card hand can invalidate
    // the whole composited layer. Native keeps stable DOM positions and lets the
    // lightweight CSS selection transition provide feedback instead.
    if (motionOn && !handDealing && !IS_NATIVE_PLATFORM) {
      cards.forEach((card) => {
        const previous = previousHandPositions.current.get(card.dataset.cardId);
        const current = nextPositions.get(card.dataset.cardId);
        const deltaX = previous ? previous.left - current.left : 0;
        if (Math.abs(deltaX) < 1 || card.classList.contains('selected')) return;
        card.animate(
          [{ transform: `translateX(${deltaX}px)` }, { transform: 'translateX(0)' }],
          { duration: 260, easing: 'cubic-bezier(.2,.82,.24,1)', fill: 'none' },
        );
      });
    }

    previousHandPositions.current = nextPositions;
  }, [game?.hands?.[0], handDealing, motionOn, smartArrange]);

  useEffect(() => {
    if (game?.landlord === null || game?.landlord === undefined || previousLandlord.current === game.landlord) return;
    previousLandlord.current = game.landlord;
    landlordAnimationUntil.current = Date.now() + 1550;
    const name = game.landlord === 0 ? '你' : BOT_NAMES[game.landlord - 1];
    setLandlordFx({ player: game.landlord, name, key: Date.now() });
    showAction(game.landlord, '地主', 'landlord', 1550);
    playSfx('landlord', game.landlord === 1 ? -.65 : game.landlord === 2 ? .65 : 0);
    speakGame(`${name}成为地主`, { rate: .92, pitch: .95 });
    const timer = window.setTimeout(() => setLandlordFx(null), 1550);
    eventTimers.current.push(timer);
  }, [game?.landlord, playSfx, showAction, speakGame]);

  useEffect(() => {
    if (game?.phase !== 'playing') {
      previousTurnKey.current = null;
      setTurnTakeover(false);
      return undefined;
    }
    const turnKey = `${game.phase}:${game.current}:${game.turnSerial || 0}`;
    if (previousTurnKey.current === turnKey) return undefined;
    if (game.current !== 0) {
      previousTurnKey.current = turnKey;
      setTurnTakeover(false);
      return undefined;
    }
    const delay = Math.max(0, landlordAnimationUntil.current - Date.now());
    const cueTimer = window.setTimeout(() => {
      previousTurnKey.current = turnKey;
      setTurnTakeover(true);
      playSfx('turn');
      speakGame(game.lastPlay ? '轮到你出牌' : '你获得牌权', { rate: .98, pitch: 1.03 });
      vibrate([10, 34, 14]);
    }, delay);
    const clearTimer = window.setTimeout(() => setTurnTakeover(false), delay + 1050);
    return () => { window.clearTimeout(cueTimer); window.clearTimeout(clearTimer); };
  }, [game?.phase, game?.current, game?.turnSerial, game?.lastPlay, playSfx, speakGame, vibrate]);

  const finishBid = (state, bidder) => {
    const landlord = bidder;
    const hands = state.hands.map((hand, index) => index === landlord
      ? [...hand, ...state.bottom].sort((a, b) => b.value - a.value)
      : hand);
    const name = landlord === 0 ? '你' : BOT_NAMES[landlord - 1];
    return withReplayFrame(
      { ...state, hands, phase: 'playing', landlord, current: landlord, lastPlay: null, logs: [`${name} 成为地主`, ...state.logs] },
      { actor: landlord, label: `${name}成为地主`, type: 'landlord' },
    );
  };

  const placeBid = (player, score) => {
    if (!game || game.phase !== 'bidding' || game.current !== player || actionLockRef.current) return false;
    if (!acquireActionLock()) return false;
    showAction(player, score ? `${score} 分` : '不叫', score === 3 ? 'landlord' : 'normal');
    playSfx(score ? 'bid' : 'pass', player === 1 ? -.65 : player === 2 ? .65 : 0);
    speakGame(score ? `${['', '一', '两', '三'][score]}分` : '不叫', { rate: 1.02, pitch: player === 1 ? .93 : player === 2 ? 1.06 : 1 });
    vibrate(score === 3 ? [12, 24, 18] : 8);
    setGame((state) => {
      if (!state || state.phase !== 'bidding' || state.current !== player) return state;
      const highestBid = score > state.highestBid ? score : state.highestBid;
      const highestBidder = score > state.highestBid ? player : state.highestBidder;
      const bidCount = state.bidCount + 1;
      const actionText = score ? `叫${score}分` : '不叫';
      const name = player === 0 ? '你' : BOT_NAMES[player - 1];
      const next = withReplayFrame(
        { ...state, highestBid, highestBidder, bidCount, current: nextPlayerCounterClockwise(player), turnSerial: (state.turnSerial || 0) + 1, bids: [...state.bids, { player, score }], trail: [...(state.trail || []), { player, text: actionText, key: `${Date.now()}-${player}` }].slice(-4), logs: [`${name} ${score ? `叫 ${score} 分` : '不叫'}`, ...state.logs] },
        { actor: player, label: `${name} · ${score ? `叫 ${score} 分` : '不叫'}`, type: 'bid' },
      );
      if (score === 3) return finishBid(next, player);
      if (bidCount >= 3) {
        if (highestBidder === null) {
          setToast('无人叫地主，正在重新发牌');
          window.setTimeout(() => setRound((value) => value + 1), 800);
          return { ...next, phase: 'redeal' };
        }
        return finishBid(next, highestBidder);
      }
      return next;
    });
    return true;
  };

  useEffect(() => {
    if (!game || game.phase !== 'bidding' || game.current === 0) return undefined;
    const timer = window.setTimeout(() => {
      const score = estimateBid(game.hands[game.current], aiDifficulty, { currentPlayer: game.current, turnSerial: game.turnSerial || game.bidCount });
      placeBid(game.current, score > game.highestBid ? score : 0);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [game?.phase, game?.current, game?.bidCount, aiDifficulty]);

  const completeTurn = (player, cards) => {
    const playedCombo = classifyPlay(cards);
    const activeHandIds = new Set(game?.hands?.[player]?.map((card) => card.id) || []);
    const ownsCards = cards?.length && new Set(cards.map((card) => card.id)).size === cards.length && cards.every((card) => activeHandIds.has(card.id));
    if (!game || game.phase !== 'playing' || game.current !== player || !playedCombo || !canBeat(playedCombo, game.lastPlay) || !ownsCards || actionLockRef.current) return false;
    if (!acquireActionLock()) return false;
    const dramatic = ['bomb', 'rocket'].includes(playedCombo.type);
    showAction(player, playNames[playedCombo.type], dramatic ? 'impact' : 'play');
    const playSound = dramatic
      ? 'impact'
      : ['straight', 'pair_straight', 'airplane', 'airplane_single', 'airplane_pair'].includes(playedCombo.type)
        ? 'combo'
        : playedCombo.type === 'pair'
          ? 'pair'
          : ['triple', 'triple_single', 'triple_pair'].includes(playedCombo.type) ? 'triple' : 'card';
    playSfx(playSound, player === 1 ? -.65 : player === 2 ? .65 : 0);
    speakGame(playNames[playedCombo.type], { rate: dramatic ? .86 : 1, pitch: player === 1 ? .93 : player === 2 ? 1.06 : 1 });
    vibrate(dramatic ? [28, 35, 48] : 10);
    const remaining = Math.max(0, (game?.hands[player]?.length || cards.length) - cards.length);
    if (remaining === 1 || remaining === 2) {
      const timer = window.setTimeout(() => {
        showAction(player, remaining === 1 ? '报单' : '报双', 'alert', 1450);
        playSfx('bid', player === 1 ? -.65 : player === 2 ? .65 : 0);
        speakGame(remaining === 1 ? '报单' : '报双', { rate: 1.05, pitch: player === 1 ? .93 : player === 2 ? 1.06 : 1 });
      }, 480);
      eventTimers.current.push(timer);
    }
    if (motionOn && ['bomb', 'rocket', 'straight', 'pair_straight', 'airplane', 'airplane_single', 'airplane_pair'].includes(playedCombo.type)) {
      setComboFx({ type: playedCombo.type, label: playNames[playedCombo.type], key: Date.now() });
      window.setTimeout(() => setComboFx(null), 1150);
    }
    setGame((state) => {
      if (!state || state.phase !== 'playing' || state.current !== player) return state;
      const combo = classifyPlay(cards);
      const hands = state.hands.map((hand, index) => index === player ? removeCards(hand, cards) : hand);
      const playCounts = state.playCounts.map((count, index) => index === player ? count + 1 : count);
      let multiplier = combo.type === 'bomb' || combo.type === 'rocket' ? state.multiplier * 2 : state.multiplier;
      const winner = hands[player].length === 0 ? player : null;
      const spring = winner === null ? null : calculateSpring(playCounts, state.landlord, winner);
      if (spring) multiplier *= 2;
      const next = {
        ...state, hands, multiplier, winner, spring, playCounts,
        playedCards: [...(state.playedCards || []), ...cards],
        phase: winner === null ? 'playing' : 'ended',
        current: winner === null ? nextPlayerCounterClockwise(player) : player,
        turnSerial: (state.turnSerial || 0) + 1,
        lastPlay: { ...combo, cards, player }, lastActor: player, passCount: 0,
        trail: [...(state.trail || []), { player, text: playNames[combo.type], key: `${Date.now()}-${player}` }].slice(-4),
        logs: [`${player === 0 ? '你' : BOT_NAMES[player - 1]} 打出${playNames[combo.type]}`, ...state.logs],
      };
      const name = player === 0 ? '你' : BOT_NAMES[player - 1];
      return withReplayFrame(next, {
        actor: player,
        label: winner === null ? `${name} · ${playNames[combo.type]}` : `${name} · ${playNames[combo.type]} · 赢得本局${spring ? ` · ${spring === 'spring' ? '春天' : '反春天'}` : ''}`,
        type: winner === null ? 'play' : 'result',
        cards,
      });
    });
    if (player === 0) setSelected([]);
    return true;
  };

  const passTurn = (player) => {
    if (!game || game.phase !== 'playing' || game.current !== player || !game.lastPlay || actionLockRef.current) return false;
    if (!acquireActionLock()) return false;
    if (game.passCount + 1 >= 2) {
      const owner = game.lastPlay.player;
      const name = owner === 0 ? '你' : BOT_NAMES[owner - 1];
      setLeadReturnFx({ player: owner, name, key: Date.now() });
      const timer = window.setTimeout(() => setLeadReturnFx(null), 1050);
      eventTimers.current.push(timer);
    }
    showAction(player, '不出', 'pass');
    playSfx('pass', player === 1 ? -.65 : player === 2 ? .65 : 0);
    speakGame('不出', { rate: 1.02, pitch: player === 1 ? .93 : player === 2 ? 1.06 : 1 });
    setGame((state) => {
      if (!state || state.phase !== 'playing' || state.current !== player || !state.lastPlay) return state;
      const passCount = state.passCount + 1;
      const name = player === 0 ? '你' : BOT_NAMES[player - 1];
      if (passCount >= 2) {
        return withReplayFrame(
          { ...state, current: state.lastPlay.player, turnSerial: (state.turnSerial || 0) + 1, lastPlay: null, passCount: 0, trail: [...(state.trail || []), { player, text: '不出', key: `${Date.now()}-${player}` }].slice(-4), logs: ['新一轮出牌', `${name} 不出`, ...state.logs] },
          { actor: player, label: `${name} · 不出 · 新一轮`, type: 'pass' },
        );
      }
      return withReplayFrame(
        { ...state, current: nextPlayerCounterClockwise(player), turnSerial: (state.turnSerial || 0) + 1, passCount, trail: [...(state.trail || []), { player, text: '不出', key: `${Date.now()}-${player}` }].slice(-4), logs: [`${name} 不出`, ...state.logs] },
        { actor: player, label: `${name} · 不出`, type: 'pass' },
      );
    });
    if (player === 0) setSelected([]);
    return true;
  };

  useEffect(() => {
    if (!game || game.phase !== 'playing' || game.current === 0) return undefined;
    const thinkTime = 620 + Math.min(620, game.hands[game.current].length * 24 + (game.lastPlay ? 170 : 0));
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const target = game.lastPlay;
      const decision = await requestAiAnalysis('decision', { hand: game.hands[game.current], previous: target, context: {
        currentPlayer: game.current,
        landlord: game.landlord,
        lastPlayer: game.lastActor,
        handSizes: game.hands.map((hand) => hand.length),
        seenCards: game.playedCards || [],
        publicCards: game.bottom,
        turnSerial: game.turnSerial,
        difficulty: aiDifficulty,
      } });
      if (cancelled) return;
      setAiThoughts((items) => ({ ...items, [game.current]: decision.reason }));
      if (decision.action === 'play' && decision.cards?.length) completeTurn(game.current, decision.cards);
      else passTurn(game.current);
    }, thinkTime);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [game?.phase, game?.current, game?.hands, game?.lastPlay, aiDifficulty, requestAiAnalysis]);

  useEffect(() => {
    if (!game || !['bidding', 'playing'].includes(game.phase)) return undefined;
    autoHandled.current = false;
    setTurnTime(20);
    const interval = window.setInterval(() => {
      if (!actionLockRef.current && Date.now() >= landlordAnimationUntil.current) setTurnTime((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [game?.phase, game?.current]);

  useEffect(() => {
    if (!game || turnTime !== 0 || game.current !== 0 || autoHandled.current) return;
    autoHandled.current = true;
    if (game.phase === 'bidding') {
      setToast('叫分超时，已自动选择不叫');
      placeBid(0, 0);
      return;
    }
    if (game.phase !== 'playing') return;
    let cancelled = false;
    requestAiAnalysis('decision', { hand: game.hands[0], previous: game.lastPlay, context: {
      currentPlayer: 0,
      landlord: game.landlord,
      lastPlayer: game.lastActor,
      handSizes: game.hands.map((hand) => hand.length),
      seenCards: game.playedCards || [],
      publicCards: game.bottom,
      turnSerial: game.turnSerial,
      difficulty: 'super',
    } }).then((decision) => {
      if (cancelled) return;
      if (decision.action === 'play' && decision.cards?.length) {
        setToast(`操作超时 · 托管：${decision.reason}`);
        completeTurn(0, decision.cards);
      } else {
        setToast(`操作超时 · 不出：${decision.reason}`);
        passTurn(0);
      }
    });
    return () => { cancelled = true; };
  }, [turnTime, game?.phase, game?.current, requestAiAnalysis]);

  useEffect(() => {
    if (turnTime > 0 && turnTime <= 5 && game?.current === 0) playSfx('tick');
  }, [turnTime, game?.current, playSfx]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(''), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const cardAtPoint = (clientX, clientY) => {
      const elements = Array.from(handElement.current?.querySelectorAll('[data-card-id]') || []);
      if (!elements.length) return null;
      const rects = elements.map((element) => element.getBoundingClientRect());
      const minTop = Math.min(...rects.map((rect) => rect.top)) - 28;
      const maxBottom = Math.max(...rects.map((rect) => rect.bottom)) + 18;
      if (clientY < minTop || clientY > maxBottom) return null;
      if (clientX < rects[0].left - 24 || clientX > rects.at(-1).right + 24) return null;
      for (let index = 0; index < rects.length; index += 1) {
        const rightEdge = index === rects.length - 1 ? rects[index].right + 12 : rects[index + 1].left;
        if (clientX <= rightEdge) return elements[index].dataset.cardId;
      }
      return elements.at(-1).dataset.cardId;
    };
    const visitPoint = (clientX, clientY) => {
      const drag = dragState.current;
      if (!drag.active) return;
      const id = cardAtPoint(clientX, clientY);
      if (!id) return;
      const index = game?.hands?.[0]?.findIndex((card) => card.id === id) ?? -1;
      if (index < 0) return;
      const start = drag.lastIndex === null ? index : Math.min(drag.lastIndex, index);
      const end = drag.lastIndex === null ? index : Math.max(drag.lastIndex, index);
      drag.lastIndex = index;
      const crossedIds = game.hands[0].slice(start, end + 1).map((card) => card.id).filter((cardId) => !drag.visited.has(cardId));
      if (!crossedIds.length) return;
      crossedIds.forEach((cardId) => drag.visited.add(cardId));
      autoMatchPauseUntil.current = Date.now() + (drag.mode === 'select' ? 180 : 900);
      setSelected((items) => drag.mode === 'select'
        ? [...new Set([...items, ...crossedIds])]
        : items.filter((item) => !crossedIds.includes(item)));
      const now = Date.now();
      if (now - drag.lastHapticAt > 42) {
        drag.lastHapticAt = now;
        vibrate(4);
      }
    };
    const moveDrag = (event) => {
      const drag = dragState.current;
      if (!drag.active || (drag.pointerId !== null && event.pointerId !== drag.pointerId)) return;
      if (event.cancelable) event.preventDefault();
      drag.lastPoint = { x: event.clientX, y: event.clientY };
      if (drag.frame !== null) return;
      drag.frame = window.requestAnimationFrame(() => {
        const current = dragState.current;
        current.frame = null;
        if (current.lastPoint) visitPoint(current.lastPoint.x, current.lastPoint.y);
      });
    };
    const endDrag = (event) => {
      const drag = dragState.current;
      if (!drag.active || (drag.pointerId !== null && event.pointerId !== drag.pointerId)) return;
      if (drag.frame !== null) {
        window.cancelAnimationFrame(drag.frame);
        drag.frame = null;
      }
      if (event.clientX !== undefined) visitPoint(event.clientX, event.clientY);
      drag.active = false;
      if (drag.mode !== 'select' || drag.visited.size < 2 || !game || game.phase !== 'playing') return;
      const intended = new Set([...drag.initial, ...drag.visited]);
      const gestureCards = game.hands[0].filter((card) => intended.has(card.id));
      const best = findBestGesturePlay(game.hands[0], gestureCards, game.lastPlay);
      if (!best?.length) return;
      const bestIds = best.map((card) => card.id);
      const changed = bestIds.length !== intended.size || bestIds.some((id) => !intended.has(id));
      autoMatchPauseUntil.current = Date.now() + 900;
      setManualMatchSuppressed(true);
      setSelected(bestIds);
      if (changed) {
        const combo = classifyPlay(best);
        setToast(`已按滑动轨迹匹配${playNames[combo.type]}`);
        setGestureSnap(true);
        playSfx('combo');
        const timer = window.setTimeout(() => setGestureSnap(false), 520);
        eventTimers.current.push(timer);
      }
    };
    const cancelDrag = () => {
      const drag = dragState.current;
      if (drag.frame !== null) window.cancelAnimationFrame(drag.frame);
      drag.active = false;
      drag.frame = null;
    };
    window.addEventListener('pointermove', moveDrag, { passive: false });
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', cancelDrag);
    return () => {
      window.removeEventListener('pointermove', moveDrag);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', cancelDrag);
      cancelDrag();
    };
  }, [game, playSfx, vibrate]);

  const selectedCards = useMemo(() => game?.hands?.[0]?.filter((card) => selected.includes(card.id)) || [], [game?.hands, selected]);
  const rankCounts = useMemo(() => (game?.hands?.[0] || []).reduce((counts, card) => ({ ...counts, [card.rank]: (counts[card.rank] || 0) + 1 }), {}), [game?.hands]);
  const selectedCombo = useMemo(() => classifyPlay(selectedCards), [selectedCards]);
  const selectionCanPlay = Boolean(selectedCombo && canBeat(selectedCombo, game?.lastPlay));
  const matchingOptions = useMemo(() => {
    if (!game || !selected.length) return [];
    return matchLikelyOptions(game.hands[0], selectedCards, game.lastPlay);
  }, [game?.hands, game?.lastPlay, selectedCards, selected.length]);
  const likelyMatch = useMemo(() => {
    if (!game || !autoMatch || manualMatchSuppressed || actionLocked || !selected.length || selectionCanPlay) return null;
    return matchingOptions[0] || null;
  }, [game, manualMatchSuppressed, actionLocked, selected.length, selectionCanPlay, autoMatch, matchingOptions]);
  const matchPreviewIds = useMemo(() => new Set((likelyMatch || []).filter((card) => !selected.includes(card.id)).map((card) => card.id)), [likelyMatch, selected]);
  const alternateMatches = useMemo(() => matchingOptions.filter((option) => option.length !== selected.length || option.some((card) => !selected.includes(card.id))).slice(0, 3), [matchingOptions, selected]);
  useEffect(() => {
    if (!game || game.phase !== 'playing') {
      setStrategicActions([]);
      setHintLoading(false);
      return undefined;
    }
    let cancelled = false;
    setHintLoading(true);
    setStrategicActions([]);
    requestAiAnalysis('hints', { hand: game.hands[0], previous: game.lastPlay, context: {
      currentPlayer: 0,
      landlord: game.landlord,
      lastPlayer: game.lastActor,
      handSizes: game.hands.map((hand) => hand.length),
      seenCards: game.playedCards || [],
      publicCards: game.bottom,
      turnSerial: game.turnSerial,
      includeAlternatives: true,
    }, difficulty: 'super' }).then((actions) => {
      if (cancelled) return;
      setStrategicActions(actions);
      setHintLoading(false);
    });
    return () => { cancelled = true; };
  }, [game?.phase, game?.current, game?.hands, game?.lastPlay, game?.landlord, game?.lastActor, game?.playedCards, game?.bottom, game?.turnSerial, requestAiAnalysis]);
  const hintRankings = useMemo(() => {
    const typeOrder = { single: 0, pair: 1, triple: 2, triple_single: 3, triple_pair: 4, straight: 5, pair_straight: 6, airplane: 7, airplane_single: 8, airplane_pair: 9, four_two_single: 10, four_two_pair: 11, bomb: 12, rocket: 13 };
    return strategicActions.filter((candidate) => candidate.action === 'play').sort((a, b) => {
      const specialA = ['bomb', 'rocket'].includes(a.combo.type) ? 1 : 0;
      const specialB = ['bomb', 'rocket'].includes(b.combo.type) ? 1 : 0;
      const followsA = game?.lastPlay && a.combo.type === game.lastPlay.type ? 0 : 1;
      const followsB = game?.lastPlay && b.combo.type === game.lastPlay.type ? 0 : 1;
      return specialA - specialB
        || followsA - followsB
        || a.combo.rank - b.combo.rank
        || (typeOrder[a.combo.type] ?? 99) - (typeOrder[b.combo.type] ?? 99)
        || (a.breakCost ?? 0) - (b.breakCost ?? 0)
        || a.score - b.score;
    });
  }, [strategicActions, game?.lastPlay]);
  const passAdvice = useMemo(() => strategicActions.find((candidate) => candidate.action === 'pass') || null, [strategicActions]);
  const hintOptions = useMemo(() => hintRankings.map((candidate) => candidate.cards), [hintRankings]);
  const hintGroups = useMemo(() => hintOptions.reduce((groups, cards, index) => {
    const type = classifyPlay(cards).type;
    const group = groups.find((item) => item.type === type);
    if (group) group.indices.push(index);
    else groups.push({ type, indices: [index] });
    return groups;
  }, []), [hintOptions]);
  const hintMeta = useMemo(() => {
    if (!hintOptions.length) return null;
    const selectedIds = new Set(selected);
    const selectedHintIndex = selected.length ? hintOptions.findIndex((cards) => cards.length === selected.length && cards.every((card) => selectedIds.has(card.id))) : -1;
    const globalIndex = selectedHintIndex >= 0 ? selectedHintIndex : hintCursor % hintOptions.length;
    const type = classifyPlay(hintOptions[globalIndex]).type;
    const group = hintGroups.find((item) => item.type === type);
    const insight = hintRankings[globalIndex];
    return { type, localIndex: group.indices.indexOf(globalIndex) + 1, count: group.indices.length, globalIndex: globalIndex + 1, total: hintOptions.length, grade: insight?.grade, reason: insight?.reason };
  }, [hintCursor, hintOptions, hintGroups, hintRankings, selected]);
  const noPlayableResponse = Boolean(!hintLoading && game?.phase === 'playing' && game.current === 0 && game.lastPlay && hintOptions.length === 0);
  const turnDirective = useMemo(() => {
    if (!game || game.phase !== 'playing' || game.current !== 0) return null;
    const opposingPlayers = game.landlord === 0 ? [1, 2] : game.landlord === null ? [] : [game.landlord];
    const dangerCards = opposingPlayers.map((player) => game.hands[player].length).filter((count) => count <= 2).sort((a, b) => a - b)[0];
    const dangerCopy = dangerCards === 1 ? ' · 对手报单，注意高单封堵' : dangerCards === 2 ? ' · 对手报双，注意对子封堵' : '';
    if (noPlayableResponse) return { tone: 'blocked', eyebrow: 'NO LEGAL PLAY', title: '没有可压制牌', detail: '建议选择不出，保留当前手牌结构' };
    if (game.lastPlay) return { tone: 'follow', eyebrow: 'YOUR TURN', title: '轮到你出牌', detail: `请压过 ${playNames[game.lastPlay.type]}${dangerCopy}` };
    return { tone: 'lead', eyebrow: 'YOU HAVE CONTROL', title: '你获得牌权', detail: `可打出任意合法牌型${dangerCopy}` };
  }, [game?.phase, game?.current, game?.lastPlay, noPlayableResponse]);
  const correctionOption = useMemo(() => {
    if (!selected.length || selectionCanPlay) return null;
    return likelyMatch || matchingOptions[0] || hintOptions[0] || null;
  }, [selected.length, selectionCanPlay, likelyMatch, matchingOptions, hintOptions]);
  const comparisonCopy = useMemo(() => {
    if (!selected.length) return null;
    const target = game?.lastPlay;
    const currentName = selectedCombo ? playNames[selectedCombo.type] : '未成牌型';
    const targetName = target ? playNames[target.type] : '自由出牌';
    return { targetName, currentName, valid: selectionCanPlay, currentRank: selectedCombo?.rank, targetRank: target?.rank };
  }, [selected.length, selectedCombo, selectionCanPlay, game?.lastPlay]);
  const selectedAdvice = useMemo(() => {
    if (!selected.length) return null;
    const ids = new Set(selected);
    return strategicActions.find((advice) => advice.action === 'play' && advice.cards.length === selected.length && advice.cards.every((card) => ids.has(card.id))) || null;
  }, [selected, strategicActions]);
  const selectionFeedback = useMemo(() => {
    if (!selected.length) {
      const target = game?.lastPlay;
      if (target) return { tone: 'idle', title: '请选择跟牌组合', detail: `目标：${playNames[target.type]} · ${target.cards.map((card) => card.rank === 'SJ' ? '小王' : card.rank === 'BJ' ? '大王' : card.rank).join(' ')}` };
      return { tone: 'idle', title: '请选择出牌组合', detail: '你拥有牌权 · 横向滑动可连续选牌' };
    }
    if (likelyMatch) {
      const combo = classifyPlay(likelyMatch);
      return { tone: 'matching', title: `正在匹配${playNames[combo.type]}`, detail: `将自动补全为 ${likelyMatch.length} 张` };
    }
    if (!selectedCombo) return { tone: 'invalid', title: '尚未组成牌型', detail: '调整选择后会实时识别' };
    if (!selectionCanPlay) {
      const target = game?.lastPlay;
      if (target?.type === 'rocket') return { tone: 'invalid', title: '无法大过王炸', detail: '建议选择不出' };
      if (target && selectedCombo.type !== target.type && !['bomb', 'rocket'].includes(selectedCombo.type)) return { tone: 'invalid', title: `需要跟出${playNames[target.type]}`, detail: `当前选择为${playNames[selectedCombo.type]}` };
      return { tone: 'invalid', title: `需要大过${playNames[target?.type] || '上家'}`, detail: `当前选择为${playNames[selectedCombo.type]}` };
    }
    if (selectedAdvice) return { tone: 'valid', title: `${selectedAdvice.grade} · ${playNames[selectedCombo.type]}`, detail: selectedAdvice.reason };
    if (!hintLoading && strategicActions.length) {
      const primary = strategicActions[0];
      return { tone: 'risky', title: `可以出，但不是优选`, detail: primary.action === 'pass' ? `建议不出：${primary.reason}` : `更推荐${playNames[primary.combo.type]}：${primary.reason}` };
    }
    return { tone: 'valid', title: playNames[selectedCombo.type], detail: `${selected.length} 张 · 可以出牌 · Enter 确认` };
  }, [selected.length, selectedCombo, selectionCanPlay, game?.lastPlay, likelyMatch, selectedAdvice, hintLoading, strategicActions]);

  useEffect(() => {
    if (!likelyMatch || !autoMatch || manualMatchSuppressed || actionLocked) return undefined;
    const selectionSignature = [...selected].sort().join('|');
    const delay = Math.max(380, autoMatchPauseUntil.current - Date.now() + 30);
    const timer = window.setTimeout(() => {
      if (dragState.current.active || Date.now() < autoMatchPauseUntil.current) return;
      if ([...selectedRef.current].sort().join('|') !== selectionSignature) return;
      const ids = likelyMatch.map((card) => card.id);
      if (ids.length === selectedRef.current.length && ids.every((id) => selectedRef.current.includes(id))) return;
      setSelected(ids);
      const combo = classifyPlay(likelyMatch);
      setToast(`已智能匹配${playNames[combo.type]}`);
      playSfx('select');
      vibrate(7);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [likelyMatch, autoMatch, manualMatchSuppressed, actionLocked, selected, playSfx, vibrate]);

  useEffect(() => {
    hintCursorRef.current = 0;
    setHintCursor(0);
  }, [game?.current, game?.lastPlay?.type, game?.lastPlay?.rank, game?.lastPlay?.length, game?.hands?.[0]?.length]);

  const result = useMemo(() => {
    if (!game || game.phase !== 'ended') return null;
    const won = game.landlord === 0 ? game.winner === 0 : game.winner !== game.landlord;
    const baseReward = won ? 80 : 0;
    const multiplierReward = won ? Math.min(160, Math.max(0, game.multiplier - 1) * 40) : 0;
    const rankedReward = won && ranked ? 80 : 0;
    const springReward = won && game.spring ? 80 : 0;
    const breakdown = [
      { label: '胜局奖励', value: baseReward },
      ...(multiplierReward ? [{ label: '倍数加成', value: multiplierReward }] : []),
      ...(rankedReward ? [{ label: '排位加成', value: rankedReward }] : []),
      ...(springReward ? [{ label: game.spring === 'spring' ? '春天奖励' : '反春奖励', value: springReward }] : []),
    ];
    return {
      won, ranked, tokens: Math.min(rewardPool, breakdown.reduce((sum, item) => sum + item.value, 0)), rewardPool, breakdown, spring: game.spring,
      rating: ranked ? (won ? 18 : -12) : 0,
      text: won ? (game.landlord === 0 ? '地主力压全场，牌路干净利落。' : '农民阵营配合取胜，守住了这一局。') : '牌局已经记录，调整牌路后再战。',
    };
  }, [game?.phase, game?.winner, game?.landlord, game?.multiplier, game?.spring, ranked, rewardPool]);

  useEffect(() => {
    if (result && !rewarded.current) {
      rewarded.current = true;
      onFinish(result);
      playSfx(result.won ? 'win' : 'loss');
      speakGame(result.won ? '恭喜获胜' : '再接再厉', { rate: .9, pitch: result.won ? 1.06 : .92 });
    }
  }, [result, onFinish, playSfx, speakGame]);

  useEffect(() => {
    if (game?.phase !== 'playing' || game.current !== 0) return undefined;
    const onShortcut = (event) => {
      if (event.repeat || ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
      if (actionLockRef.current) return;
      if (event.key === 'Escape' && selected.length) { event.preventDefault(); autoMatchPauseUntil.current = Date.now() + 900; setManualMatchSuppressed(true); setSelected([]); }
      if (event.key.toLowerCase() === 'h') { event.preventDefault(); hint(event.shiftKey); }
      if (event.key.toLowerCase() === 'p' && game.lastPlay) { event.preventDefault(); passTurn(0); }
      if (event.key === 'Enter' && selectionCanPlay && !event.target.closest?.('.poker-card')) { event.preventDefault(); playSelected(); }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [game?.phase, game?.current, game?.lastPlay, selected, selectionCanPlay, hintCursor, hintOptions, hintGroups, actionLocked]);

  if (!game) return <div className="game-loading"><div className="brand-mark">T</div><p>{toast}</p></div>;

  const pauseAutoMatch = (duration = 180) => {
    autoMatchPauseUntil.current = Date.now() + duration;
  };
  const updateDraggedCard = (id, shouldSelect) => {
    setSelected((items) => shouldSelect
      ? (items.includes(id) ? items : [...items, id])
      : items.filter((item) => item !== id));
  };
  const toggleCardWithKeyboard = (event, id) => {
    if (!['Enter', ' '].includes(event.key) || game.phase !== 'playing') return;
    event.preventDefault();
    const removing = selected.includes(id);
    pauseAutoMatch(removing ? 900 : 180);
    setManualMatchSuppressed(removing);
    setSelected((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
    playSfx('select');
    vibrate(6);
  };
  const startCardDrag = (event, id) => {
    if (game.phase !== 'playing' || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const shouldSelect = !selected.includes(id);
    pauseAutoMatch(shouldSelect ? 180 : 900);
    setManualMatchSuppressed(!shouldSelect);
    dragState.current = { active: true, mode: shouldSelect ? 'select' : 'remove', visited: new Set([id]), initial: new Set(selected), pointerId: event.pointerId, frame: null, lastPoint: { x: event.clientX, y: event.clientY }, lastIndex: game.hands[0].findIndex((card) => card.id === id), lastHapticAt: Date.now() };
    updateDraggedCard(id, shouldSelect);
    playSfx('select');
    vibrate(5);
  };
  const selectRank = (rank) => {
    if (game.phase !== 'playing') return;
    const ids = game.hands[0].filter((card) => card.rank === rank).map((card) => card.id);
    pauseAutoMatch(420);
    setManualMatchSuppressed(false);
    setSelected((items) => [...new Set([...items, ...ids])]);
    playSfx('select');
    vibrate(8);
  };
  const triggerInvalid = (message) => {
    setInvalidSelection(false);
    window.requestAnimationFrame(() => setInvalidSelection(true));
    const timer = window.setTimeout(() => setInvalidSelection(false), 460);
    eventTimers.current.push(timer);
    setToast(message);
    playSfx('error');
    vibrate([10, 28, 10]);
  };
  const playSelected = () => {
    if (actionLocked) return;
    if (!selectedCombo) return triggerInvalid('这组牌还不能组成有效牌型');
    if (!selectionCanPlay) return triggerInvalid(selectionFeedback.title);
    setToast('');
    completeTurn(0, selectedCards);
  };
  const hint = (nextType = false) => {
    if (actionLocked) return;
    if (!hintOptions.length) return setToast('没有能大过的牌，建议不出');
    const selectedIds = new Set(selected);
    const selectedIndex = selected.length ? hintOptions.findIndex((cards) => cards.length === selected.length && cards.every((card) => selectedIds.has(card.id))) : -1;
    let index = hintCursorRef.current % hintOptions.length;
    if (selectedIndex >= 0 && selectedIndex === index && hintOptions.length > 1) index = (index + 1) % hintOptions.length;
    if (nextType && hintGroups.length > 1) {
      const currentType = classifyPlay(hintOptions[selectedIndex >= 0 ? selectedIndex : index]).type;
      const nextGroup = hintGroups.find((group) => group.type !== currentType && group.indices[0] > index)
        || hintGroups.find((group) => group.type !== currentType);
      index = nextGroup.indices[0];
    }
    const cards = hintOptions[index];
    const type = classifyPlay(cards).type;
    const group = hintGroups.find((item) => item.type === type);
    const localIndex = group.indices.indexOf(index) + 1;
    const insight = hintRankings[index];
    pauseAutoMatch(900);
    setManualMatchSuppressed(true);
    setSelected(cards.map((card) => card.id));
    const nextIndex = (index + 1) % hintOptions.length;
    hintCursorRef.current = nextIndex;
    setHintCursor(nextIndex);
    setToast(`智能提示 · ${insight?.grade || '建议'} ${playNames[type]} · ${insight?.reason || `${localIndex}/${group.indices.length}`}`);
    playSfx('select');
    vibrate(7);
  };
  const canPass = Boolean(game.lastPlay);
  const activePlay = game.lastPlay;
  const opposingPlayers = game.landlord === 0 ? [1, 2] : game.landlord === null ? [] : [game.landlord];
  const threatPlayer = opposingPlayers.find((player) => game.hands[player].length <= 2);
  const selfClosing = game.phase === 'playing' && game.hands[0].length <= 2;

  return (
    <main className={`game-room premium-room phase-${game.phase} ${threatPlayer !== undefined ? 'opponent-threat' : ''} ${selfClosing ? 'self-closing' : ''} ${turnTakeover ? 'turn-takeover' : ''} ${turnTime <= 5 && game.current === 0 ? 'turn-urgent' : ''} ${noPlayableResponse ? 'no-playable-response' : ''} ${actionLocked ? 'is-transitioning' : ''} ${motionOn ? '' : 'reduced-motion'} ${comboFx && ['bomb', 'rocket'].includes(comboFx.type) ? 'is-impact' : ''}`} aria-busy={actionLocked}>
      <div className="guochao-backdrop" aria-hidden="true"><i className="cloud cloud-a" /><i className="cloud cloud-b" /><i className="mountain mountain-a" /><i className="mountain mountain-b" /><i className="lattice left" /><i className="lattice right" /></div>
      <div className="room-dust" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} style={{ '--dust-i': index }} />)}</div>
      <div className="game-ambient ambient-one" /><div className="game-ambient ambient-two" />
      <header className="game-header premium-header">
        <div className="room-brand">
          <button className="icon-btn quiet" onClick={onExit} aria-label="退出牌局"><Icon name="close" size={18} /></button>
          <span className="room-seal">斗</span>
          <div><strong>金玉棋牌室</strong><small>JINYU CLUB · 壹号雅间</small></div>
        </div>
        <div className="match-hud">
          <span><small>模式</small><b>{ranked ? '排位赛' : '经典场'}</b></span>
          <i />
          <span><small>底分</small><b>100</b></span>
          <i />
          <span className="multiplier-value"><small>当前倍数</small><b key={game.multiplier}>×{game.multiplier}</b></span>
          <i />
          <span className="reward-pool-hud"><small>Token 奖励池</small><b><em>T</em>{rewardPool}</b></span>
        </div>
        <div className="room-tools">
          <button className="tool-button" onClick={() => setUtilityPanel(utilityPanel === 'chat' ? null : 'chat')} aria-label="快捷聊天"><Icon name="chat" size={17} /><span>聊天</span></button>
          <button className="tool-button" onClick={() => setSoundOn(!soundOn)} aria-label={soundOn ? '关闭操作音效' : '开启操作音效'}><Icon name={soundOn ? 'volume' : 'volumeOff'} size={17} /><span>音效</span></button>
          <button className="tool-button" onClick={() => setUtilityPanel(utilityPanel === 'settings' ? null : 'settings')} aria-label="设置"><Icon name="settings" size={17} /><span>设置</span></button>
          <button className="fair-pill" onClick={() => setProofOpen(!proofOpen)}><Icon name="shield" size={15} /> 公平 <i /></button>
        </div>
      </header>

      {utilityPanel === 'chat' && (
        <aside className="utility-popover chat-panel">
          <div className="utility-title"><span><Icon name="chat" size={16} /> 快捷聊天</span><button onClick={() => setUtilityPanel(null)}><Icon name="close" size={14} /></button></div>
          {['稳住，我们能赢。', '这牌打得漂亮！', '合作愉快。', '稍等，我想一想。'].map((message) => <button key={message} onClick={() => { setToast(`你：${message}`); speakGame(message, { rate: 1.02, pitch: 1.02 }); setUtilityPanel(null); }}>{message}</button>)}
        </aside>
      )}
      {utilityPanel === 'settings' && (
        <aside className="utility-popover settings-panel">
          <div className="utility-title"><span><Icon name="settings" size={16} /> 对局设置</span><button onClick={() => setUtilityPanel(null)}><Icon name="close" size={14} /></button></div>
          <label><span>操作音效<small>选牌、出牌与倒计时提示</small></span><button className={`switch ${soundOn ? 'on' : ''}`} onClick={() => setSoundOn(!soundOn)}><i /></button></label>
          <label><span>牌局语音<small>叫分、牌型、报单与胜负播报</small></span><button className={`switch ${voiceOn ? 'on' : ''}`} onClick={() => setVoiceOn((value) => !value)}><i /></button></label>
          <label><span>触感反馈<small>选牌轻触与重要牌型震动</small></span><button className={`switch ${vibrationOn ? 'on' : ''}`} onClick={() => setVibrationOn((value) => !value)}><i /></button></label>
          <label><span>智能理牌<small>保持递减并拉开组合</small></span><button className={`switch ${smartArrange ? 'on' : ''}`} onClick={() => setSmartArrange((value) => !value)}><i /></button></label>
          <label><span>智能匹配<small>根据已选牌自动补全牌型</small></span><button className={`switch ${autoMatch ? 'on' : ''}`} onClick={() => setAutoMatch((value) => !value)}><i /></button></label>
          <label><span>动态效果<small>呼吸光、牌型粒子与转场</small></span><button className={`switch ${motionOn ? 'on' : ''}`} onClick={() => setMotionOn((value) => !value)}><i /></button></label>
          <div className="ai-difficulty-setting">
            <span><b>AI 强度</b><small>{AI_DIFFICULTIES[aiDifficulty].description}</small></span>
            <div className="ai-difficulty-options" role="radiogroup" aria-label="AI 强度">
              {Object.values(AI_DIFFICULTIES).map((level) => <button type="button" role="radio" aria-checked={aiDifficulty === level.id} className={aiDifficulty === level.id ? 'active' : ''} onClick={() => setAiDifficulty(level.id)} key={level.id}>{level.shortName}</button>)}
            </div>
            <p><i />AI 仅使用自己的手牌、公开底牌、已出牌记录和剩余张数，不读取其他玩家暗牌。</p>
          </div>
          <details className="room-rules"><summary>查看本桌规则</summary><p>顺子至少 {GAME_RULES.straightMinimum} 张 · 连对至少 {GAME_RULES.pairStraightMinimum} 组 · 飞机至少 {GAME_RULES.airplaneMinimum} 组</p><p>四带二允许携带一对；飞机翅膀不可使用核心点数的第四张。</p></details>
        </aside>
      )}

      {proofOpen && (
        <div className="proof-popover">
          <div><Icon name="shield" /><span><strong>牌局摘要已锁定</strong><small>牌局结束后公开种子，可自行复算牌序</small></span></div>
          <code>{game.commit}</code>
          <p>当前为本地原型验证；正式联机版将由权威服务器生成并签名。</p>
        </div>
      )}

      <section className="table-stage">
        <div className="table-shadow" />
        <div className="table-surface premium-table"><div className="table-ring" /><div className="table-weave" /><div className="table-logo"><b>斗</b><span>金 玉 · 雅 局</span></div></div>
        <Avatar index={1} landlord={game.landlord} current={game.current === 1} cards={game.hands[1].length} side="left" turnTime={turnTime} action={actionBubbles[1]} backSkin={cardBackSkin} threat={threatPlayer === 1} aiDifficulty={aiDifficulty} thought={aiThoughts[1]} />
        <Avatar index={2} landlord={game.landlord} current={game.current === 2} cards={game.hands[2].length} side="right" turnTime={turnTime} action={actionBubbles[2]} backSkin={cardBackSkin} threat={threatPlayer === 2} aiDifficulty={aiDifficulty} thought={aiThoughts[2]} />

        <div className="landlord-cards-panel" aria-label="地主底牌">
          <span className="panel-ornament left" />
          <strong><i>主</i> 地主牌</strong>
          <div className="bottom-cards">
            {game.bottom.map((card) => <Card key={card.id} card={card} compact hidden={game.phase === 'bidding' || game.phase === 'redeal'} backSkin={cardBackSkin} />)}
          </div>
          <span className="panel-ornament right" />
        </div>

        {game.trail.length > 0 && (
          <div className="turn-trail" aria-label="最近牌局记录">
            <strong>牌路</strong>
            {game.trail.slice(-4).map((entry) => <span className={`trail-player-${entry.player}`} key={entry.key}><i>{entry.player === 0 ? '你' : entry.player === 1 ? '七' : '洛'}</i>{entry.text}</span>)}
          </div>
        )}

        {game.phase !== 'bidding' && activePlay && (
          <div className={`seat-play-zone seat-play-${activePlay.player} play-type-${activePlay.type}`} style={{ '--played-count': activePlay.cards.length }}>
            <PlayedCards play={activePlay} />
            <span className="play-label"><i>{activePlay.player === 0 ? '你' : activePlay.player === 1 ? '七' : '洛'}</i><b>{activePlay.player === 0 ? '你' : BOT_NAMES[activePlay.player - 1]} · {playNames[activePlay.type]}</b><em>{activePlay.cards.length} 张</em></span>
          </div>
        )}

        <div className="table-center">
          {game.phase === 'bidding' ? (
            <div className="bid-status">
              <p>{game.current === 0 ? '轮到你叫地主' : `${BOT_NAMES[game.current - 1]} 正在思考…`}</p>
              <div className="bid-chips">{game.bids.map((bid, i) => <span key={i}>{bid.player === 0 ? '你' : BOT_NAMES[bid.player - 1]} · {bid.score || '不叫'}</span>)}</div>
            </div>
          ) : (game.current !== 0 || actionLocked) && !leadReturnFx ? <span className={`turn-message waiting-turn ${actionLocked ? 'settling' : ''}`} key={`${game.current}-${game.lastPlay?.player ?? 'lead'}-${actionLocked}`}><i />{actionLocked ? '正在落牌 · 结算牌权' : `${BOT_NAMES[game.current - 1]} 正在思考`}</span> : null}
        </div>

        {leadReturnFx && <div className={`lead-return-fx player-${leadReturnFx.player}`} key={leadReturnFx.key}><i /><span><small>CONTROL RETURNED</small><strong>牌权归还 · {leadReturnFx.name}开启新一轮</strong></span><i /></div>}

        <div className={`self-profile ${game.current === 0 ? 'active' : ''} ${selfClosing ? 'closing' : ''}`}>
          <ActionBubble event={actionBubbles[0]} />
          <div className="avatar-wrap">
            <div className="avatar self-avatar">玩</div>
            {game.landlord === 0 && <span className="landlord-tag"><i>主</i> 地主</span>}
            {game.current === 0 && <span className={`turn-timer avatar-timer ${turnTime <= 5 ? 'urgent' : ''}`} style={{ '--timer-progress': turnTime / 20 }}>{turnTime}</span>}
          </div>
          <div><strong>{profile.name}</strong><span>{selfClosing ? `仅剩 ${game.hands[0].length} 张 · 准备收官` : `${game.landlord === 0 ? '地主阵营' : game.landlord === null ? '等待叫分' : '农民阵营'} · ${profile.rating}分`}</span></div>
        </div>

        <div className={`action-zone ${game.current === 0 ? 'has-controls' : game.phase === 'playing' ? 'has-preselect' : 'toast-only'}`}>
          {toast && <div className="game-toast" role="status">{toast}</div>}
          {game.phase === 'bidding' && game.current === 0 && (
            <div className="bid-actions">
              <button className="game-action muted" disabled={actionLocked} onClick={() => placeBid(0, 0)}>不叫</button>
              {[1, 2, 3].filter((score) => score > game.highestBid).map((score) => <button className="game-action primary" disabled={actionLocked} onClick={() => placeBid(0, score)} key={score}>{score} 分</button>)}
            </div>
          )}
          {game.phase === 'playing' && game.current === 0 && (
            <div className={`play-console status-${selectionFeedback.tone}`}>
              {turnDirective && (
                <div className={`turn-directive tone-${turnDirective.tone} ${turnTakeover ? 'takeover' : ''}`}>
                  <span className="directive-signal"><i /><i /><i /></span>
                  <div className="directive-copy"><small>{turnDirective.eyebrow}</small><strong>{turnDirective.title}</strong><span>{turnDirective.detail}</span></div>
                  {game.lastPlay?.cards?.length > 0 && (
                    <div className="directive-target" aria-label="需要压过的牌">
                      <small>目标</small><div>{game.lastPlay.cards.slice(0, 3).map((card) => <Card card={card} compact key={`target-${card.id}`} />)}{game.lastPlay.cards.length > 3 && <b>+{game.lastPlay.cards.length - 3}</b>}</div>
                    </div>
                  )}
                  <span className={`console-timer ${turnTime <= 5 ? 'urgent' : turnTime <= 10 ? 'warning' : ''}`} style={{ '--timer-progress': turnTime / 20 }}><b>{turnTime}</b><small>秒</small></span>
                </div>
              )}
              {!selected.length && (hintLoading || strategicActions.length > 0) && (
                <div className={`strategy-advice ${hintLoading ? 'loading' : ''}`}>
                  <span><small>SUPER ANALYSIS</small><b>{hintLoading ? '正在推演未知手牌…' : '当前策略建议'}</b></span>
                  {!hintLoading && strategicActions.slice(0, 3).map((advice) => <button className={`advice-${advice.action}`} key={`${advice.action}-${advice.cards.map((card) => card.id).join('|')}`} onClick={() => {
                    pauseAutoMatch(900);
                    setManualMatchSuppressed(true);
                    if (advice.action === 'play') setSelected(advice.cards.map((card) => card.id));
                    else setSelected([]);
                    setToast(`${advice.grade}建议 · ${advice.action === 'pass' ? '不出' : playNames[advice.combo.type]} · ${advice.reason}`);
                    playSfx('select');
                  }}><em>{advice.grade}</em><strong>{advice.action === 'pass' ? '不出' : playNames[advice.combo.type]}</strong><small>{advice.reason}</small></button>)}
                  {hintLoading && <i className="strategy-loader"><b /><b /><b /></i>}
                </div>
              )}
              {selected.length > 0 && (!game.lastPlay || likelyMatch) && <div className="selection-readout"><i /><span><strong>{selectionFeedback.title}</strong><small>{selectionFeedback.detail}</small></span></div>}
              {comparisonCopy && game.lastPlay && !likelyMatch && (
                <div className={`play-comparison ${comparisonCopy.valid ? 'valid' : 'invalid'}`}>
                  <span><small>目标牌型</small><b>{comparisonCopy.targetName}</b></span><i>→</i><span><small>当前选择</small><b>{comparisonCopy.currentName}</b></span>
                  <em>{comparisonCopy.valid ? '可以出牌' : '需要调整'}</em>
                  {correctionOption && <button onClick={() => { pauseAutoMatch(900); setManualMatchSuppressed(true); setSelected(correctionOption.map((card) => card.id)); playSfx('select'); vibrate(7); }}>一键修正为{playNames[classifyPlay(correctionOption).type]}</button>}
                </div>
              )}
              {alternateMatches.length > 0 && (selectionCanPlay || !autoMatch) && (
                <div className="match-candidates"><small>可能还想出</small>{alternateMatches.map((option) => { const combo = classifyPlay(option); return <button disabled={actionLocked} key={option.map((card) => card.id).join('|')} onClick={() => { pauseAutoMatch(900); setManualMatchSuppressed(true); setSelected(option.map((card) => card.id)); setToast(`已匹配${playNames[combo.type]}`); playSfx('select'); vibrate(7); }}>{playNames[combo.type]} <i>+{option.length - selected.length}</i></button>; })}</div>
              )}
              <div className="play-actions">
                <button className="game-action subtle" onClick={() => { pauseAutoMatch(900); setManualMatchSuppressed(true); setSelected([]); }} disabled={!selected.length || actionLocked} aria-keyshortcuts="Escape" title="快捷键 Esc"><Icon name="undo" size={16} /> 重选</button>
                <button className={`game-action muted pass-action ${passAdvice?.grade === '首选' ? 'recommended' : ''}`} onClick={() => passTurn(0)} disabled={!canPass || actionLocked} aria-keyshortcuts="P" title={passAdvice?.reason || '快捷键 P'}>不出{passAdvice?.grade === '首选' && <em>首选</em>}</button>
                <button className="game-action muted hint-action" onClick={() => hint(false)} disabled={actionLocked || hintLoading || !hintOptions.length} aria-keyshortcuts="H" title="H：下一条策略；Shift+H：下个牌型">{hintLoading ? '计算中' : '智能提示'}{hintMeta && <em>{hintMeta.grade} {hintMeta.globalIndex}/{hintMeta.total}</em>}</button>
                <button className={`game-action primary play-submit ${selected.length && !selectionCanPlay ? 'invalid' : ''}`} onClick={playSelected} disabled={!selected.length || actionLocked} aria-keyshortcuts="Enter" title="快捷键 Enter"><span className="submit-copy"><small>{actionLocked ? '正在结算' : selectionCanPlay ? selectionFeedback.title : selected.length ? '当前选择' : '等待选择'}</small><b>{actionLocked ? '已提交' : selectionCanPlay ? '出牌' : selected.length ? '检查牌型' : '请选择牌'}</b></span>{selected.length ? <em>{selected.length}</em> : ''}</button>
              </div>
            </div>
          )}
          {game.phase === 'playing' && game.current !== 0 && (
            <div className={`preselect-console ${selected.length ? (selectedCombo ? 'ready' : 'adjust') : 'idle'}`}>
              <span className="preselect-pulse"><i /><i /></span>
              <div>
                <small>WAITING PRESELECT</small>
                <strong>{selected.length ? (selectedCombo ? `已预选 · ${playNames[selectedCombo.type]}` : `已选 ${selected.length} 张 · 待整理`) : '等待时也可以提前选牌'}</strong>
                <em>{selected.length ? '到你出牌时会按最新牌面重新校验' : '轻点或横向滑动手牌，选牌不会被 AI 回合清空'}</em>
              </div>
              <button type="button" className="preselect-hint" onClick={() => hint(false)} disabled={actionLocked || hintLoading || !hintOptions.length}>{hintLoading ? '推演中' : '智能预选'}{hintOptions.length > 1 && <b>{(hintMeta?.globalIndex || 0)}/{hintOptions.length}</b>}</button>
              <button type="button" className="preselect-clear" onClick={() => { pauseAutoMatch(900); setManualMatchSuppressed(true); setSelected([]); }} disabled={!selected.length}>清空</button>
            </div>
          )}
        </div>

        <div ref={handElement} className={`player-hand ${handDealing ? 'hand-dealing' : ''} ${smartArrange ? 'smart-arranged' : ''} ${gestureSnap ? 'gesture-snap' : ''} ${invalidSelection ? 'invalid-shake' : ''} ${game.phase === 'playing' && game.current !== 0 ? 'preselect-enabled' : ''} ${actionLocked && game.current === 0 ? 'input-locked' : ''}`} style={{ '--hand-count': game.hands[0].length }}>
          {game.hands[0].map((card, index) => (
            <Card key={card.id} card={card} selected={selected.includes(card.id)} preview={matchPreviewIds.has(card.id)} groupBreak={smartArrange && rankCounts[card.rank] > 1 && game.hands[0][index + 1]?.rank !== card.rank} onPointerDown={(event) => startCardDrag(event, card.id)} onDoubleClick={() => selectRank(card.rank)} onKeyDown={(event) => toggleCardWithKeyboard(event, card.id)} style={{ '--card-i': index, '--reverse-i': game.hands[0].length - index }} />
          ))}
        </div>
        <div className="hand-helper">
          <button className={smartArrange ? 'active' : ''} onClick={() => setSmartArrange((value) => !value)}><span>理</span><b>智能分组</b><i>{smartArrange ? '开' : '关'}</i></button>
          <small>{autoMatch ? '滑动吸附 · 智能匹配' : '拖动选牌 · 双击同点数'}</small>
        </div>
      </section>

      {landlordFx && (
        <div className={`landlord-reveal landlord-player-${landlordFx.player}`} key={landlordFx.key}>
          <div className="reveal-rings"><i /><i /><i /></div>
          <span className="reveal-seal">主</span>
          <div><small>LANDLORD</small><strong>{landlordFx.name}成为地主</strong></div>
        </div>
      )}

      {comboFx && (
        <div className={`combo-effect combo-${comboFx.type}`} key={comboFx.key}>
          <div className="combo-particles">{Array.from({ length: 16 }, (_, index) => <i key={index} style={{ '--particle': index }} />)}</div>
          <b className="combo-emblem">{COMBO_COPY[comboFx.type]?.[0] || '妙'}</b>
          <span>{comboFx.label}</span><small>{COMBO_COPY[comboFx.type]?.[1] || '漂亮一手'}</small>
        </div>
      )}

      {result && <GameResult result={result} multiplier={game.multiplier} onExit={onExit} onReplay={() => setReplayOpen(true)} onAgain={() => setRound((value) => value + 1)} fairness={{ commit: game.commit, seed: game.seed }} />}
      {replayOpen && <ReplayModal frames={game.replay || []} fairness={{ commit: game.commit, seed: game.seed }} initialIndex={import.meta.env.DEV ? Number(new URLSearchParams(window.location.search).get('replayStep')) || 0 : 0} onClose={() => setReplayOpen(false)} />}
    </main>
  );
}
