import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as NativeApp } from '@capacitor/app';
import GameRoom from './GameRoom';
import LanRoom from './LanRoom';
import { Icon } from './icons';
import packageMetadata from '../package.json';
import { clearMatchSnapshot, readMatchSnapshot } from './matchStorage';
import { localDayKey, normalizeDailyProfile } from './profileState';

const defaultProfile = {
  name: '玩家_0721', tokens: 1280, rating: 1260, games: 28, wins: 17, streak: 2,
  dailyDate: localDayKey(), dailyGames: 0, dailyWins: 0, claimed: [], owned: ['墨玉牌背'], equipped: '墨玉牌背',
};

const shopItems = [
  { id: 'ink', name: '墨玉牌背', price: 0, className: 'skin-ink', tag: '默认' },
  { id: 'jade', name: '青玉牌背', price: 280, className: 'skin-jade', tag: '人气' },
  { id: 'sunset', name: '赤霞牌背', price: 420, className: 'skin-sunset', tag: '赛季' },
  { id: 'genesis', name: '创世链路', price: 680, className: 'skin-genesis', tag: '稀有' },
];

const taskDefs = [
  { id: 'play1', title: '完成 1 局对战', detail: '无论胜负，认真打完一局', target: 1, field: 'dailyGames', reward: 60 },
  { id: 'win1', title: '赢得 1 局对战', detail: '经典场或排位赛均可', target: 1, field: 'dailyWins', reward: 100 },
  { id: 'play3', title: '完成 3 局对战', detail: '保持节奏，稳中求胜', target: 3, field: 'dailyGames', reward: 180 },
];

function getRank(rating) {
  if (rating >= 1800) return { name: 'Token 王者', tier: 'T', next: 2200 };
  if (rating >= 1500) return { name: '钻石链主', tier: 'D', next: 1800 };
  if (rating >= 1200) return { name: '黄金节点 II', tier: 'G', next: 1500 };
  if (rating >= 900) return { name: '白银矿工', tier: 'S', next: 1200 };
  return { name: '青铜新手', tier: 'B', next: 900 };
}

function Brand() {
  return <div className="brand"><span className="brand-mark">T</span><span><b>TOKEN</b><em>斗地主</em></span></div>;
}

function TopBar({ profile, page, setPage }) {
  return (
    <header className="topbar">
      <Brand />
      <nav className="main-nav">
        {[['home', '大厅'], ['rank', '排位'], ['tasks', '任务'], ['shop', '藏品']].map(([id, label]) => (
          <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}>{label}</button>
        ))}
      </nav>
      <div className="top-resources">
        <button className="token-balance" onClick={() => setPage('shop')}><span className="token-symbol">T</span><b>{profile.tokens.toLocaleString()}</b><i>+</i></button>
        <button className="profile-chip" onClick={() => setPage('profile')}><span className="mini-avatar">玩</span><span><b>{profile.name}</b><small>{getRank(profile.rating).name}</small></span><Icon name="arrow" size={16} /></button>
      </div>
    </header>
  );
}

function MobileNav({ page, setPage }) {
  const items = [['home', 'home', '大厅'], ['rank', 'trophy', '排位'], ['tasks', 'target', '任务'], ['shop', 'bag', '藏品'], ['profile', 'user', '我的']];
  return <nav className="mobile-nav">{items.map(([id, icon, label]) => <button className={page === id ? 'active' : ''} key={id} onClick={() => setPage(id)}><Icon name={icon} /><span>{label}</span></button>)}</nav>;
}

function Hero({ onStart }) {
  return (
    <section className="hero-card">
      <div className="hero-grid" /><div className="hero-glow" />
      <div className="hero-copy">
        <span className="soft-badge"><Icon name="shield" size={15} /> 可验证公平牌局</span>
        <h1>每一手好牌，<br /><em>都有迹可循。</em></h1>
        <p>经典三人斗地主，牌局种子摘要开局锁定。纯粹竞技，输赢不扣 Token。</p>
        <div className="hero-actions"><button className="btn btn-primary btn-large" onClick={() => onStart(false)}><Icon name="play" /> 快速开局</button><span><i className="online-dot" /> 本地人机 · 随时开局</span></div>
      </div>
      <div className="hero-art" aria-hidden="true">
        <div className="orbit orbit-one" /><div className="orbit orbit-two" />
        <div className="hero-card-stack hero-spade"><span>A</span><b>♠</b></div>
        <div className="hero-card-stack hero-joker"><span>J</span><b>王</b></div>
        <div className="floating-token token-one">T</div><div className="floating-token token-two">T</div><div className="floating-token token-three">T</div>
      </div>
    </section>
  );
}

function Modes({ onStart, onFriend }) {
  return (
    <section className="section-block">
      <div className="section-heading"><div><span>PLAY MODES</span><h2>选择玩法</h2></div><button>全部玩法 <Icon name="arrow" size={16} /></button></div>
      <div className="mode-grid">
        <button className="mode-card classic" onClick={() => onStart(false)}>
          <div className="mode-icon"><span>♠</span><span>♥</span></div><div><span className="mode-kicker">3–6 分钟</span><h3>经典场</h3><p>标准三人规则 · 轻松开一局</p></div><i className="mode-arrow"><Icon name="play" /></i>
        </button>
        <button className="mode-card ranked" onClick={() => onStart(true)}>
          <div className="mode-icon"><Icon name="trophy" size={32} /></div><div><span className="mode-kicker">赛季 S01</span><h3>排位赛</h3><p>公平竞技 · 冲击 Token 王者</p></div><i className="mode-arrow"><Icon name="play" /></i>
        </button>
        <button className="mode-card friend" onClick={onFriend}>
          <div className="mode-icon"><Icon name="users" size={32} /></div><div><span className="mode-kicker">局域网 Beta</span><h3>好友房</h3><p>跨设备同桌 · 权威服务判定</p></div><i className="mode-arrow"><Icon name="arrow" /></i>
        </button>
        <button className="mode-card locked" onClick={() => window.alert('癞子玩法将在 V1.1 解锁。')}>
          <div className="mode-icon"><Icon name="spark" size={32} /></div><div><span className="mode-kicker">即将上线</span><h3>癞子玩法</h3><p>更多组合 · 更高牌型上限</p></div><i className="mode-arrow"><Icon name="lock" size={18} /></i>
        </button>
      </div>
    </section>
  );
}

function DailyPanel({ profile, onClaim, setPage }) {
  const doneCount = taskDefs.filter((task) => profile[task.field] >= task.target).length;
  return (
    <aside className="daily-panel">
      <div className="daily-top"><div><span>DAILY QUEST</span><h3>今日挑战</h3></div><div className="daily-ring" style={{ '--progress': `${(doneCount / taskDefs.length) * 360}deg` }}><span>{doneCount}<small>/3</small></span></div></div>
      <div className="mini-tasks">
        {taskDefs.slice(0, 2).map((task) => {
          const ready = profile[task.field] >= task.target;
          const claimed = profile.claimed.includes(task.id);
          return <div className="mini-task" key={task.id}><span className={`task-check ${ready ? 'ready' : ''}`}>{ready ? <Icon name="check" size={14} /> : `${Math.min(profile[task.field], task.target)}/${task.target}`}</span><div><b>{task.title}</b><small>+{task.reward} Token</small></div><button disabled={!ready || claimed} onClick={() => onClaim(task)}>{claimed ? '已领' : ready ? '领取' : '进行中'}</button></div>;
        })}
      </div>
      <button className="view-all" onClick={() => setPage('tasks')}>查看全部任务 <Icon name="arrow" size={15} /></button>
      <div className="season-strip"><div><span>S01 赛季</span><b>链路初启</b></div><small>本地赛季</small></div>
    </aside>
  );
}

function HomePage({ profile, onStart, onFriend, onClaim, setPage }) {
  return <div className="dashboard"><div className="dashboard-main"><Hero onStart={onStart} /><Modes onStart={onStart} onFriend={onFriend} /></div><DailyPanel profile={profile} onClaim={onClaim} setPage={setPage} /></div>;
}

function RankPage({ profile, onStart }) {
  const rank = getRank(profile.rating);
  const leaderboard = [
    ['01', '节点_Zero', 2188, '零'], ['02', '纸牌先知', 2074, '知'], ['03', '链上小地主', 1982, '链'], ['16', profile.name, profile.rating, '玩'], ['17', '顺子研究员', 1248, '顺'],
  ];
  return <div className="content-page rank-page"><section className="rank-hero"><div className="rank-medal"><span>{rank.tier}</span><i /><i /></div><div><span className="page-kicker">SEASON 01 · 链路初启</span><h1>{rank.name}</h1><p>当前积分 <b>{profile.rating}</b> · 距离下一段位还差 {Math.max(0, rank.next - profile.rating)} 分</p><div className="rank-progress"><i style={{ width: `${Math.min(100, (profile.rating / rank.next) * 100)}%` }} /></div><button className="btn btn-primary" onClick={() => onStart(true)}><Icon name="trophy" /> 开始排位</button></div></section><section className="leaderboard panel"><div className="panel-title"><div><span>LOCAL DEMO</span><h2>本地演示榜</h2></div><small>非联网排名</small></div>{leaderboard.map(([pos, name, score, avatar]) => <div className={`leader-row ${name === profile.name ? 'self' : ''}`} key={pos}><b className="leader-pos">{pos}</b><span className="leader-avatar">{avatar}</span><strong>{name}{name === profile.name && <em>我</em>}</strong><span>{score} 分</span></div>)}</section></div>;
}

function TasksPage({ profile, onClaim }) {
  const total = taskDefs.reduce((sum, task) => sum + task.reward, 0);
  return <div className="content-page"><div className="page-title"><span className="page-kicker">DAILY QUESTS</span><h1>今日任务</h1><p>完成对局即可获取 Token。任务每日零点刷新。</p></div><section className="task-list panel">{taskDefs.map((task) => { const progress = Math.min(profile[task.field], task.target); const ready = progress >= task.target; const claimed = profile.claimed.includes(task.id); return <article className="task-row" key={task.id}><span className={`large-task-icon ${ready ? 'ready' : ''}`}>{claimed ? <Icon name="check" /> : <Icon name="target" />}</span><div className="task-copy"><h3>{task.title}</h3><p>{task.detail}</p><div><i style={{ width: `${(progress / task.target) * 100}%` }} /></div><small>{progress} / {task.target}</small></div><div className="task-reward"><span><i className="token-symbol">T</i> +{task.reward}</span><button className={`btn ${ready && !claimed ? 'btn-primary' : 'btn-ghost'}`} disabled={!ready || claimed} onClick={() => onClaim(task)}>{claimed ? '已领取' : ready ? '领取' : '未完成'}</button></div></article>; })}<footer>今日可获得 <b>{total} Token</b><span>Token 不可提现、转赠或交易</span></footer></section></div>;
}

function ShopPage({ profile, onBuy }) {
  return <div className="content-page"><div className="page-title"><span className="page-kicker">COLLECTION</span><h1>赛季藏品</h1><p>使用游戏内赚取的 Token 解锁装扮，不影响牌局胜率。</p></div><div className="shop-grid">{shopItems.map((item) => { const owned = profile.owned.includes(item.name); const equipped = profile.equipped === item.name; return <article className={`shop-card ${equipped ? 'equipped' : ''}`} key={item.id}><div className={`shop-preview ${item.className}`}><span className="shop-tag">{equipped ? '使用中' : item.tag}</span><div className="preview-card"><b>T</b><i>◈</i><small>TOKEN LANDLORDS</small></div></div><div className="shop-info"><div><h3>{item.name}</h3><p>{equipped ? '当前牌局正在使用' : '限定动态牌背'}</p></div><button className={owned ? 'owned' : ''} onClick={() => onBuy(item)} disabled={equipped}>{equipped ? <><Icon name="check" size={15} /> 使用中</> : owned ? '装备' : <><i className="token-symbol">T</i> {item.price}</>}</button></div></article>; })}</div><div className="shop-notice"><Icon name="info" /><p><b>关于 Token</b><span>Token 仅通过游戏行为获得，仅用于兑换本游戏内数字装扮，不支持购买、提现或用户间转移。</span></p></div></div>;
}

function ProfilePage({ profile }) {
  const winRate = profile.games ? Math.round((profile.wins / profile.games) * 100) : 0;
  return <div className="content-page"><section className="profile-hero panel"><div className="big-avatar">玩<span /></div><div><span className="page-kicker">PLAYER PROFILE</span><h1>{profile.name}</h1><p>ID TL-2026-0721 · 加入于 S01 赛季</p><div className="profile-badges"><span><Icon name="shield" size={15} /> 本地牌手</span><span>{getRank(profile.rating).name}</span></div></div></section><div className="stat-grid"><div className="stat-card"><span>总场次</span><b>{profile.games}</b><small>本赛季</small></div><div className="stat-card"><span>胜率</span><b>{winRate}%</b><small>{profile.wins} 场胜利</small></div><div className="stat-card"><span>最高连胜</span><b>{Math.max(5, profile.streak)}</b><small>继续保持</small></div><div className="stat-card"><span>排位积分</span><b>{profile.rating}</b><small>{getRank(profile.rating).name}</small></div></div><section className="panel owned-panel"><div className="panel-title"><div><span>MY COLLECTION</span><h2>我的藏品</h2></div><small>{profile.owned.length} 件</small></div><div className="owned-list">{profile.owned.map((item) => <span key={item}><i>◈</i><b>{item}</b><small>{item === profile.equipped ? '使用中' : '已拥有'}</small></span>)}</div></section></div>;
}

export default function App() {
  const [profile, setProfile] = useState(() => {
    try { return normalizeDailyProfile({ ...defaultProfile, ...JSON.parse(localStorage.getItem('tl-profile') || '{}') }); } catch { return defaultProfile; }
  });
  const [page, setPage] = useState('home');
  const [match, setMatch] = useState(() => {
    const preview = new URLSearchParams(window.location.search).get('play');
    if (preview) return { ranked: preview === 'ranked', key: Date.now() };
    const snapshot = readMatchSnapshot();
    return snapshot ? { ranked: snapshot.ranked, key: `resume-${snapshot.savedAt}`, snapshot } : null;
  });
  const [notice, setNotice] = useState('');
  const pageRef = useRef(page);
  const matchRef = useRef(match);

  const startMatch = useCallback((ranked) => {
    clearMatchSnapshot();
    const nextMatch = { ranked, key: Date.now() };
    matchRef.current = nextMatch;
    setMatch(nextMatch);
  }, []);
  const exitMatch = useCallback(() => {
    // Keep native-back state synchronous with the visible route. Waiting for
    // the ref-sync effect leaves a short window where Android believes the
    // finished match is still open and makes the user press Back repeatedly.
    clearMatchSnapshot();
    matchRef.current = null;
    pageRef.current = 'home';
    setMatch(null);
    setPage('home');
  }, []);
  const startLan = useCallback(() => {
    clearMatchSnapshot();
    pageRef.current = 'lan';
    setPage('lan');
  }, []);
  const exitLan = useCallback(() => {
    pageRef.current = 'home';
    setPage('home');
  }, []);

  useEffect(() => { localStorage.setItem('tl-profile', JSON.stringify(profile)); }, [profile]);
  useEffect(() => {
    const refreshDailyState = () => setProfile((current) => normalizeDailyProfile(current));
    const untilTomorrow = new Date();
    untilTomorrow.setHours(24, 0, 1, 0);
    const timer = window.setTimeout(refreshDailyState, Math.max(1000, untilTomorrow.getTime() - Date.now()));
    document.addEventListener('visibilitychange', refreshDailyState);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', refreshDailyState); };
  }, [profile.dailyDate]);
  useEffect(() => { if (!notice) return undefined; const timer = setTimeout(() => setNotice(''), 2400); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { pageRef.current = page; }, [page]);
  useEffect(() => { matchRef.current = match; }, [match]);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined;
    let listener;
    NativeApp.addListener('backButton', () => {
      if (matchRef.current) {
        exitMatch();
        return;
      }
      if (pageRef.current !== 'home') {
        pageRef.current = 'home';
        setPage('home');
        return;
      }
      NativeApp.exitApp();
    }).then((handle) => { listener = handle; });
    return () => { listener?.remove(); };
  }, [exitMatch]);

  const finishMatch = (result) => {
    clearMatchSnapshot();
    setProfile((current) => {
      const fresh = normalizeDailyProfile(current);
      return {
        ...fresh,
        tokens: fresh.tokens + result.tokens,
        rating: Math.max(0, fresh.rating + result.rating),
        games: fresh.games + 1,
        wins: fresh.wins + (result.won ? 1 : 0),
        streak: result.won ? fresh.streak + 1 : 0,
        dailyGames: fresh.dailyGames + 1,
        dailyWins: fresh.dailyWins + (result.won ? 1 : 0),
      };
    });
  };
  const claimTask = (task) => {
    if (profile.claimed.includes(task.id) || profile[task.field] < task.target) return;
    setProfile((current) => ({ ...current, tokens: current.tokens + task.reward, claimed: [...current.claimed, task.id] }));
    setNotice(`已领取 ${task.reward} Token`);
  };
  const buyItem = (item) => {
    if (profile.owned.includes(item.name)) {
      setProfile((current) => ({ ...current, equipped: item.name }));
      setNotice(`${item.name} 已装备`);
      return;
    }
    if (profile.tokens < item.price) return setNotice('Token 不足，完成任务即可获取');
    setProfile((current) => ({ ...current, tokens: current.tokens - item.price, owned: [...current.owned, item.name], equipped: item.name }));
    setNotice(`${item.name} 已解锁并装备`);
  };

  const body = useMemo(() => {
    if (page === 'rank') return <RankPage profile={profile} onStart={startMatch} />;
    if (page === 'tasks') return <TasksPage profile={profile} onClaim={claimTask} />;
    if (page === 'shop') return <ShopPage profile={profile} onBuy={buyItem} />;
    if (page === 'profile') return <ProfilePage profile={profile} />;
    return <HomePage profile={profile} onStart={startMatch} onFriend={startLan} onClaim={claimTask} setPage={setPage} />;
  }, [page, profile]);

  if (match) return <GameRoom key={match.key} ranked={match.ranked} profile={profile} initialSnapshot={match.snapshot} onExit={exitMatch} onFinish={finishMatch} />;
  if (page === 'lan') return <LanRoom profile={profile} onExit={exitLan} />;

  return (
    <div className="app-shell">
      <div className="app-noise" /><TopBar profile={profile} page={page} setPage={setPage} />
      <main className="app-content">{body}</main>
      <footer className="site-footer"><Brand /><p>健康游戏 · 公平竞技 · Token 不可交易</p><span>Prototype v{packageMetadata.version}</span></footer>
      <MobileNav page={page} setPage={setPage} />
      {notice && <div className="notice-toast"><Icon name="check" size={18} /> {notice}</div>}
    </div>
  );
}
