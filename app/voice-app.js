'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { createRtcSession } from './webrtc';

const NICK_KEY = 'moeim-nickname';
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

function cleanName(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function hue(text) {
  let value = 0;
  for (const char of text || '?') value = (value * 33 + char.codePointAt(0)) % 360;
  return value;
}

function initial(name) {
  return [...(name || '?')][0] || '?';
}

function formatWho(list) {
  if (!list?.length) return '참여자 없음';
  const names = list.map((person) => person.nickname);
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} 외 ${names.length - 3}명`;
}

function loadNick() {
  try { return localStorage.getItem(NICK_KEY) || ''; } catch { return ''; }
}

function storeNick(value) {
  try { localStorage.setItem(NICK_KEY, value); } catch { /* private mode */ }
}

function Icon({ name }) {
  const paths = {
    mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
    micOff: '<path d="M9 9v3a3 3 0 0 0 5.1 2.1"/><path d="M15 9.5V6a3 3 0 0 0-5.4-1.8"/><path d="M5 11a7 7 0 0 0 11.2 5.6"/><path d="M12 18v3"/><path d="M4 4l16 16"/>',
    headphones: '<path d="M4 13v5a2 2 0 0 0 2 2h1v-8H6a2 2 0 0 0-2 2z"/><path d="M20 13v5a2 2 0 0 1-2 2h-1v-8h1a2 2 0 0 1 2 2z"/><path d="M4 13a8 8 0 0 1 16 0"/>',
    headphonesOff: '<path d="M4 13a8 8 0 0 1 12.5-6.6"/><path d="M20 13v2"/><path d="M4 13v5a2 2 0 0 0 2 2h1v-8"/><path d="M17 12v8h1a2 2 0 0 0 2-2v-3"/><path d="M4 4l16 16"/>',
    screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    leave: '<path d="M10 7V5H5v14h5v-2"/><path d="M10 12h9"/><path d="M16 9l3 3-3 3"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  };
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: paths[name] }} />
  );
}

function ScreenVideo({ track, label, muted }) {
  const ref = useRef(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return undefined;
    video.srcObject = new MediaStream([track]);
    video.play().catch(() => {});
    return () => { video.srcObject = null; };
  }, [track]);
  return (
    <figure className="tile">
      <video ref={ref} autoPlay playsInline muted={muted} />
      <figcaption>{label}</figcaption>
    </figure>
  );
}

export default function VoiceApp() {
  const socketRef = useRef(null);
  const rtcRef = useRef(null);
  const roomRef = useRef(null);
  const meRef = useRef({ muted: false, deafened: false, sharing: false, muteBeforeDeafen: false });
  const participantsRef = useRef([]);
  const remoteVideos = useRef(new Map());
  const remoteAudios = useRef([]);
  const audioCtxRef = useRef(null);
  const busyRef = useRef(false);
  const triedDeepLink = useRef(false);

  const [nickname, setNickname] = useState('');
  const [rooms, setRooms] = useState([]);
  const [maxMembers, setMaxMembers] = useState(8);
  const [room, setRoom] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [me, setMe] = useState(meRef.current);
  const [socketId, setSocketId] = useState('');
  const [online, setOnline] = useState(false);
  const [micError, setMicError] = useState('');
  const [toast, setToast] = useState('');
  const [conn, setConn] = useState({});
  const [screenTrack, setScreenTrack] = useState(null);
  const [videoEpoch, setVideoEpoch] = useState(0);
  const [stageCollapsed, setStageCollapsed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [passwordRoom, setPasswordRoom] = useState(null);
  const [secure, setSecure] = useState(true);

  const createDialog = useRef(null);
  const passwordDialog = useRef(null);
  const nickTimer = useRef(0);
  const nicknameRef = useRef('');
  const presenceIds = useRef(null);

  function showToast(message) {
    setToast(message);
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => setToast(''), 3200);
  }

  function patchMe(partial) {
    const next = { ...meRef.current, ...partial };
    meRef.current = next;
    setMe(next);
    return next;
  }

  function playPresence(kind) {
    const ctx = audioCtxRef.current;
    if (!ctx || meRef.current.deafened) return;
    ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    const notes = kind === 'join' ? [523.25, 659.25] : [392, 311.13];
    notes.forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = now + index * 0.08;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.07, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.18);
    });
  }

  function applyParticipants(list) {
    const sorted = [...list].sort((a, b) => {
      if (a.id === socketRef.current?.id) return -1;
      if (b.id === socketRef.current?.id) return 1;
      return a.joinedAt - b.joinedAt;
    });
    const ids = new Set(sorted.map((person) => person.id));
    const self = socketRef.current?.id;
    if (!roomRef.current) {
      presenceIds.current = null;
    } else if (!presenceIds.current) {
      presenceIds.current = ids;
    } else {
      let joined = false;
      let left = false;
      for (const id of ids) {
        if (id !== self && !presenceIds.current.has(id)) joined = true;
      }
      for (const id of presenceIds.current) {
        if (id !== self && !ids.has(id)) left = true;
      }
      presenceIds.current = ids;
      if (joined) playPresence('join');
      if (left) playPresence('leave');
    }
    participantsRef.current = sorted;
    setParticipants(sorted);
    for (const person of sorted) {
      if (person.id !== socketRef.current?.id && !person.sharing) remoteVideos.current.delete(person.id);
    }
    setVideoEpoch((value) => value + 1);
  }

  function pushState(next = meRef.current) {
    socketRef.current?.emit('state:update', {
      muted: next.muted || next.deafened,
      deafened: next.deafened,
      sharing: next.sharing,
    });
  }

  function applyMic(stream, flags = meRef.current) {
    stream?.getAudioTracks().forEach((track) => {
      track.enabled = !flags.muted && !flags.deafened;
    });
    remoteAudios.current.forEach((audio) => { audio.muted = flags.deafened; });
  }

  function unlockAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx && !audioCtxRef.current) audioCtxRef.current = new Ctx();
    audioCtxRef.current?.resume().catch(() => {});
    const audio = new Audio(SILENT_WAV);
    audio.muted = true;
    audio.play().catch(() => {});
  }

  async function ensureMic() {
    const current = rtcRef.current?.localStream;
    if (current?.getAudioTracks().some((track) => track.readyState === 'live')) {
      applyMic(current);
      return current;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicError('이 브라우저는 마이크를 지원하지 않아요. 다른 사람 목소리는 들을 수 있어요.');
      return null;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      rtcRef.current.setLocalStream(stream);
      rtcRef.current.localStream = stream;
      applyMic(stream);
      setMicError('');
      return stream;
    } catch (err) {
      if (err?.name === 'NotFoundError') setMicError('마이크를 찾지 못했어요. 듣기만 가능해요.');
      else if (err?.name === 'NotAllowedError') setMicError('마이크 권한이 막혀 있어요. 주소창의 권한을 허용해 주세요.');
      else setMicError('마이크를 열지 못했어요. 듣기만 가능해요.');
      return null;
    }
  }

  function readNickname() {
    const name = cleanName(nicknameRef.current, 16);
    if (!name) {
      showToast('별명을 입력해 주세요.');
      return null;
    }
    storeNick(name);
    return name;
  }

  function emitAck(event, payload) {
    const socket = socketRef.current;
    if (!socket?.connected) return Promise.resolve({ ok: false, message: '서버에 연결되어 있지 않아요.' });
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => resolve({ ok: false, message: '서버 응답이 없어요.' }), 8000);
      socket.emit(event, payload, (res) => {
        window.clearTimeout(timer);
        resolve(res || { ok: false, message: '서버 응답이 이상해요.' });
      });
    });
  }

  function enterRoom(nextRoom) {
    roomRef.current = nextRoom.id;
    rtcRef.current.setRoom(nextRoom.id);
    rtcRef.current.setMediaReady(true);
    setRoom(nextRoom);
    applyParticipants(nextRoom.participants);
    rtcRef.current.sync(nextRoom.participants.map((person) => person.id));
    rtcRef.current.flushSignals();
    const url = new URL(window.location.href);
    url.searchParams.set('room', nextRoom.id);
    window.history.replaceState(null, '', `${url.pathname}?room=${nextRoom.id}`);
  }

  async function leaveRoom({ keepMic = false } = {}) {
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState(null, '', url.pathname);
    stopShare();
    rtcRef.current.closeAll();
    remoteVideos.current.clear();
    remoteAudios.current.forEach((audio) => { audio.srcObject = null; });
    remoteAudios.current = [];
    const prev = roomRef.current;
    roomRef.current = null;
    rtcRef.current.setRoom(null);
    setRoom(null);
    applyParticipants([]);
    setScreenTrack(null);
    if (prev) await emitAck('room:leave');
    if (!keepMic && rtcRef.current.localStream) {
      rtcRef.current.localStream.getTracks().forEach((track) => track.stop());
      rtcRef.current.localStream = null;
      rtcRef.current.setLocalStream(null);
    }
  }

  async function createRoom(name, password) {
    if (busyRef.current) return;
    const nick = readNickname();
    if (!nick) return;
    busyRef.current = true;
    try {
      unlockAudio();
      const stream = await ensureMic();
      applyMic(stream);
      if (roomRef.current) await leaveRoom({ keepMic: true });
      const res = await emitAck('room:create', { name, password, nickname: nick });
      if (!res.ok) {
        showToast(res.message || '방을 만들지 못했어요.');
        return;
      }
      enterRoom(res.room);
      pushState();
      setCreateOpen(false);
    } finally {
      busyRef.current = false;
    }
  }

  async function joinRoom(roomId, password) {
    if (busyRef.current) return;
    const nick = readNickname();
    if (!nick) return;
    busyRef.current = true;
    try {
      unlockAudio();
      const stream = await ensureMic();
      applyMic(stream);
      if (roomRef.current && roomRef.current !== roomId) await leaveRoom({ keepMic: true });
      const res = await emitAck('room:join', { roomId, password, nickname: nick });
      if (!res.ok) {
        showToast(res.message || '방에 들어가지 못했어요.');
        return;
      }
      enterRoom(res.room);
      pushState();
    } finally {
      busyRef.current = false;
    }
  }

  function requestJoin(target) {
    if (!target || target.id === roomRef.current) return;
    unlockAudio();
    if (!target.hasPassword) {
      joinRoom(target.id, '');
      return;
    }
    setPasswordRoom(target);
  }

  function stopShare() {
    const stream = rtcRef.current?.screenStream || null;
    if (!stream && !meRef.current.sharing) return;
    if (rtcRef.current) {
      rtcRef.current.screenStream = null;
      rtcRef.current.setScreenStream(null);
    }
    const next = patchMe({ sharing: false });
    setScreenTrack(null);
    pushState(next);
    if (stream) rtcRef.current.stopScreen(stream);
  }

  async function toggleScreen() {
    if (!roomRef.current) return;
    unlockAudio();
    if (meRef.current.sharing || rtcRef.current.screenStream) {
      stopShare();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      showToast('이 브라우저에서는 화면 공유를 쓸 수 없어요.');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: true,
      });
    } catch (err) {
      if (err?.name === 'NotAllowedError') return;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      } catch (err2) {
        if (err2?.name !== 'NotAllowedError') showToast('화면 공유를 시작하지 못했어요.');
        return;
      }
    }
    const videoTrack = stream.getVideoTracks()[0];
    videoTrack?.addEventListener('ended', () => stopShare());
    rtcRef.current.screenStream = stream;
    rtcRef.current.publishScreen(stream);
    setScreenTrack(videoTrack || null);
    const next = patchMe({ sharing: true });
    pushState(next);
  }

  function toggleMute() {
    if (!roomRef.current) return;
    const current = meRef.current;
    const next = current.deafened && current.muted
      ? patchMe({ deafened: false, muted: false })
      : patchMe({ muted: !current.muted });
    applyMic(rtcRef.current.localStream, next);
    pushState(next);
  }

  function toggleDeafen() {
    if (!roomRef.current) return;
    const current = meRef.current;
    const next = current.deafened
      ? patchMe({ deafened: false, muted: Boolean(current.muteBeforeDeafen) })
      : patchMe({ deafened: true, muted: true, muteBeforeDeafen: current.muted });
    applyMic(rtcRef.current.localStream, next);
    pushState(next);
  }

  function clearPeerMedia(peerId) {
    remoteVideos.current.delete(peerId);
    setVideoEpoch((value) => value + 1);
  }

  useEffect(() => {
    const saved = loadNick();
    const initialNick = saved || `손님${Math.floor(100 + Math.random() * 900)}`;
    nicknameRef.current = initialNick;
    setNickname(initialNick);
    if (!saved) storeNick(initialNick);
    setSecure(window.isSecureContext);

    const socket = io({ autoConnect: true });
    socketRef.current = socket;
    const rtc = createRtcSession({
      socket,
      onTrack: (peerId, track) => {
        if (track.kind === 'audio') {
          const audio = new Audio();
          audio.autoplay = true;
          audio.srcObject = new MediaStream([track]);
          audio.muted = meRef.current.deafened;
          audio.play().catch(() => {});
          remoteAudios.current.push(audio);
          track.addEventListener('ended', () => {
            audio.srcObject = null;
            remoteAudios.current = remoteAudios.current.filter((item) => item !== audio);
          });
          return;
        }
        if (track.kind !== 'video') return;
        const bucket = remoteVideos.current.get(peerId) || new Map();
        bucket.set(track.id, track);
        remoteVideos.current.set(peerId, bucket);
        const drop = () => {
          bucket.delete(track.id);
          if (!bucket.size) remoteVideos.current.delete(peerId);
          setVideoEpoch((value) => value + 1);
        };
        track.addEventListener('ended', drop);
        track.addEventListener('mute', () => {
          window.setTimeout(() => {
            const owner = participantsRef.current.find((person) => person.id === peerId);
            if (track.readyState === 'ended' || (track.muted && owner && !owner.sharing)) drop();
          }, 300);
        });
        setVideoEpoch((value) => value + 1);
      },
      onConnection: (peerId, status) => {
        setConn((prev) => ({ ...prev, [peerId]: status }));
      },
    });
    rtcRef.current = rtc;

    socket.on('connect', () => {
      setOnline(true);
      setSocketId(socket.id);
      const name = cleanName(initialNick, 16);
      if (name) socket.emit('nickname:update', name);
    });
    socket.on('disconnect', () => {
      setOnline(false);
      if (roomRef.current) {
        rtc.closeAll();
        remoteVideos.current.clear();
        roomRef.current = null;
        setRoom(null);
        applyParticipants([]);
        setScreenTrack(null);
        showToast('연결이 끊어져 방에서 나왔어요.');
      }
    });
    socket.on('rooms', (payload) => {
      const list = Array.isArray(payload) ? payload : payload.rooms || [];
      if (payload?.maxMembers) setMaxMembers(payload.maxMembers);
      setRooms(list);
      if (triedDeepLink.current || roomRef.current) return;
      triedDeepLink.current = true;
      const wanted = new URLSearchParams(window.location.search).get('room');
      if (!wanted) return;
      if (!/^[a-z0-9]{6}$/.test(wanted)) return;
      const found = list.find((item) => item.id === wanted);
      if (found) requestJoin(found);
      else showToast('링크의 방을 찾을 수 없어요.');
    });
    socket.on('room:state', (next) => {
      if (!next || next.id !== roomRef.current) return;
      setRoom(next);
      applyParticipants(next.participants);
      rtc.sync(next.participants.map((person) => person.id));
    });
    socket.on('share:stop', ({ id }) => {
      clearPeerMedia(id);
    });
    socket.on('signal', (message) => rtc.handleSignal(message));

    const onKey = (event) => {
      if (event.target.matches('input, textarea')) return;
      if ((event.key === 'm' || event.key === 'M') && roomRef.current) {
        event.preventDefault();
        toggleMute();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      socket.disconnect();
    };
    // Mount once. Handlers read the latest values through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.body.dataset.view = room ? 'call' : 'lobby';
    document.body.dataset.online = online ? '1' : '0';
  }, [room, online]);

  useEffect(() => {
    const dialog = createDialog.current;
    if (!dialog) return;
    if (createOpen && !dialog.open) dialog.showModal();
    if (!createOpen && dialog.open) dialog.close();
  }, [createOpen]);

  useEffect(() => {
    const dialog = passwordDialog.current;
    if (!dialog) return;
    if (passwordRoom && !dialog.open) dialog.showModal();
    if (!passwordRoom && dialog.open) dialog.close();
  }, [passwordRoom]);

  const tiles = useMemo(() => {
    const list = [];
    if (me.sharing && screenTrack && screenTrack.readyState !== 'ended') {
      list.push({ id: 'local', track: screenTrack, label: '내 화면', muted: true });
    }
    for (const person of participants) {
      if (!person.sharing || person.id === socketId) continue;
      const bucket = remoteVideos.current.get(person.id);
      if (!bucket) continue;
      for (const [trackId, track] of bucket) {
        if (track.readyState === 'ended') continue;
        list.push({
          id: `${person.id}:${trackId}`,
          track,
          label: `${person.nickname}의 화면`,
          muted: false,
        });
      }
    }
    return list;
    // videoEpoch refreshes the map-backed list when a track arrives or is removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.sharing, screenTrack, participants, socketId, videoEpoch]);

  useEffect(() => {
    if (!tiles.length) setStageCollapsed(false);
  }, [tiles.length]);

  const connLabel = {
    failed: '연결 실패',
    disconnected: '연결 끊김',
    connecting: '연결 중',
    new: '연결 중',
    checking: '연결 중',
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          <div>
            <strong>모임실</strong>
            <p>로그인 없는 보이스 채팅</p>
          </div>
        </div>
        <label className="nick-field">
          <span>내 별명</span>
          <input
            maxLength={16}
            value={nickname}
            autoComplete="nickname"
            placeholder="별명을 입력하세요"
            onChange={(event) => {
              const value = event.target.value;
              setNickname(value);
              nicknameRef.current = value;
              const name = cleanName(value, 16);
              if (name) storeNick(name);
              window.clearTimeout(nickTimer.current);
              nickTimer.current = window.setTimeout(() => {
                if (name && socketRef.current?.connected) socketRef.current.emit('nickname:update', name);
              }, 400);
            }}
          />
        </label>
        <p className="nick-help">이 별명으로 보여요. 계정은 필요 없어요.</p>
        <div className="side-head">
          <h2>열린 방</h2>
          <span>{rooms.length}</span>
        </div>
        <div className="room-list">
          {rooms.map((item) => {
            const full = item.participants.length >= maxMembers && item.id !== room?.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`room-link${item.id === room?.id ? ' active' : ''}`}
                disabled={full}
                onClick={() => requestJoin(item)}
              >
                <span className="room-link-top">
                  <span className="room-link-name">{item.name}</span>
                  <span style={{ display: 'flex', gap: 6 }}>
                    {item.hasPassword ? <span className="lock-pill" title="비밀번호 방"><Icon name="lock" /></span> : null}
                    <span className="count-pill">{item.participants.length}</span>
                  </span>
                </span>
                <span className="who">{formatWho(item.participants)}</span>
              </button>
            );
          })}
        </div>
        {rooms.length === 0 ? <p className="side-empty">아직 열린 방이 없어요.</p> : null}
        <button id="open-create" className="btn block" type="button" onClick={() => setCreateOpen(true)}>방 만들기</button>
      </aside>

      <main className="main">
        {!online ? <p className="banner error">서버에 연결되지 않았어요. 서버가 켜져 있는지 확인해 주세요.</p> : null}
        {!secure ? <p className="banner">마이크와 화면 공유는 localhost 또는 HTTPS에서만 동작해요.</p> : null}

        {!room ? (
          <section id="lobby">
            <div className="hero">
              <p className="eyebrow">별명만 정하면 바로 시작</p>
              <h1>누가 말하는지 보이는<br />가벼운 보이스 채팅</h1>
              <p className="lede">방을 만들거나 열려 있는 방에 들어가 목소리로 이야기하고, 화면을 공유할 수 있어요. 비밀번호를 걸면 그 방을 잠글 수 있고, 누가 들어와 있는지는 목록에서 보여요.</p>
            </div>
            {rooms.length === 0 ? (
              <div className="empty">
                <div className="empty-mark" aria-hidden="true" />
                <h2>아직 열린 방이 없어요</h2>
                <p>첫 방을 만들면 다른 사람도 이 목록에서 바로 볼 수 있어요.</p>
                <button className="btn" type="button" onClick={() => setCreateOpen(true)}>방 만들기</button>
              </div>
            ) : (
              <div className="room-grid">
                {rooms.map((item) => {
                  const full = item.participants.length >= maxMembers && item.id !== room?.id;
                  return (
                    <article key={item.id} className="room-card">
                      <div className="card-top">
                        <h3>{item.name}</h3>
                        <span style={{ display: 'flex', gap: 6 }}>
                          {item.hasPassword ? <span className="lock-pill" title="비밀번호 방"><Icon name="lock" /></span> : null}
                          <span className="count-pill">{item.participants.length}</span>
                        </span>
                      </div>
                      <p className="who">{item.participants.length}/{maxMembers}명 참여 중</p>
                      <p className="who">{formatWho(item.participants)}</p>
                      <button className="btn" type="button" disabled={full} onClick={() => requestJoin(item)}>
                        {item.id === room?.id ? '참여 중' : full ? '가득 참' : '입장'}
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        ) : (
          <section id="call" className={tiles.length && !stageCollapsed ? 'has-stage' : ''}>
            <header className="call-head">
              <div>
                <p className="eyebrow">{room.hasPassword ? '비밀번호로 잠긴 방' : '공개 방'}</p>
                <h1>{room.name}</h1>
                <p className="lede">{participants.length}명 참여 중 · 최대 {maxMembers}명</p>
              </div>
            </header>
            {micError ? <p className="banner">{micError}</p> : null}
            {tiles.length ? (
              <div className="stage-bar">
                <span>{stageCollapsed ? '화면 공유를 접어 두었어요' : '화면이 공유되고 있어요'}</span>
                <button type="button" onClick={() => setStageCollapsed((value) => !value)}>
                  {stageCollapsed ? '화면 보기' : '화면 접기'}
                </button>
              </div>
            ) : null}
            {tiles.length && !stageCollapsed ? (
              <div className="stage">
                {tiles.map((tile) => (
                  <ScreenVideo key={tile.id} track={tile.track} label={tile.label} muted={tile.muted} />
                ))}
              </div>
            ) : null}
            <div className="members">
              {participants.map((person) => {
                const self = person.id === socketId;
                const view = self ? { ...person, nickname: cleanName(nickname, 16) || person.nickname, muted: me.muted || me.deafened, deafened: me.deafened, sharing: me.sharing } : person;
                const color = hue(view.nickname);
                const status = self ? '' : (connLabel[conn[person.id]] || '');
                return (
                  <article key={person.id} className="member">
                    <div className="avatar" style={{ background: `linear-gradient(160deg, hsl(${color} 85% 62%), hsl(${(color + 36) % 360} 70% 42%))` }}>{initial(view.nickname)}</div>
                    <strong className="member-name">{view.nickname}{self ? <span className="me-badge">나</span> : null}</strong>
                    {status ? <span className="member-status">{status}</span> : null}
                    <div className="flags">
                      {view.muted || view.deafened ? <Icon name="micOff" /> : null}
                      {view.deafened ? <Icon name="headphonesOff" /> : null}
                      {view.sharing ? <Icon name="screen" /> : null}
                    </div>
                  </article>
                );
              })}
            </div>
            <footer className="dock">
              <div className="controls">
                <button className={`ctrl${me.muted || me.deafened ? ' is-danger' : ''}`} type="button" onClick={toggleMute}>
                  <Icon name={me.muted || me.deafened ? 'micOff' : 'mic'} />
                  <span className="ctrl-label">{me.muted || me.deafened ? '마이크 꺼짐' : '마이크 켜짐'}</span>
                </button>
                <button className={`ctrl${me.deafened ? ' is-danger' : ''}`} type="button" onClick={toggleDeafen}>
                  <Icon name={me.deafened ? 'headphonesOff' : 'headphones'} />
                  <span className="ctrl-label">{me.deafened ? '소리 꺼짐' : '소리 켜짐'}</span>
                </button>
                <button className={`ctrl${me.sharing ? ' is-live' : ''}`} type="button" onClick={toggleScreen}>
                  <Icon name="screen" />
                  <span className="ctrl-label">{me.sharing ? '공유 중지' : '화면 공유'}</span>
                </button>
                <button className="ctrl leave" type="button" onClick={() => leaveRoom()}>
                  <Icon name="leave" />
                  <span className="ctrl-label">나가기</span>
                </button>
              </div>
              <p className="hint">M 키로 마이크를 껐다 켤 수 있어요. 에코가 들리면 헤드폰을 써 주세요.</p>
            </footer>
          </section>
        )}
      </main>

      {toast ? <div className="toast" role="status">{toast}</div> : null}

      <dialog ref={createDialog} onClose={() => setCreateOpen(false)}>
        <form
          className="modal"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            createRoom(data.get('name'), data.get('password'));
          }}
        >
          <h2>방 만들기</h2>
          <p className="modal-copy">비밀번호를 비워 두면 누구나 들어올 수 있는 공개 방이 돼요.</p>
          <label>
            <span>방 이름</span>
            <input name="name" maxLength={24} required placeholder="예: 저녁 수다" />
          </label>
          <label>
            <span>비밀번호 (선택)</span>
            <input name="password" maxLength={32} type="password" autoComplete="new-password" placeholder="비워 두면 공개" />
          </label>
          <div className="modal-actions">
            <button className="btn secondary" type="button" onClick={() => setCreateOpen(false)}>취소</button>
            <button className="btn" type="submit">만들고 들어가기</button>
          </div>
        </form>
      </dialog>

      <dialog ref={passwordDialog} onClose={() => setPasswordRoom(null)}>
        <form
          className="modal"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const target = passwordRoom;
            setPasswordRoom(null);
            if (target) joinRoom(target.id, data.get('password'));
          }}
        >
          <h2>비밀번호 입력</h2>
          <p className="modal-copy"><strong>{passwordRoom?.name}</strong> 방에 들어가려면 비밀번호가 필요해요.</p>
          <label>
            <span>비밀번호</span>
            <input name="password" maxLength={32} type="password" autoComplete="current-password" required />
          </label>
          <div className="modal-actions">
            <button className="btn secondary" type="button" onClick={() => setPasswordRoom(null)}>취소</button>
            <button className="btn" type="submit">입장</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
