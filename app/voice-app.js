'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { createRtcSession } from './webrtc';

const NICK_KEY = 'moeim-nickname';
const AUDIO_KEY = 'moeim-audio';
const PEER_KEY = 'moeim-peer-levels';
const SHARE_KEY = 'moeim-share-quality';
const SHARE_CAPTURE = {
  high: { width: 1920, height: 1080, frameRate: 30 },
  medium: { width: 1280, height: 720, frameRate: 24 },
  low: { width: 960, height: 540, frameRate: 12 },
};
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

function loadAudio() {
  const fallback = { micId: '', speakerId: '', micLevel: 100, speakerLevel: 100 };
  try {
    const parsed = JSON.parse(localStorage.getItem(AUDIO_KEY) || '{}');
    return {
      micId: typeof parsed.micId === 'string' ? parsed.micId : '',
      speakerId: typeof parsed.speakerId === 'string' ? parsed.speakerId : '',
      micLevel: clampLevel(parsed.micLevel, 0, 200, 100),
      speakerLevel: clampLevel(parsed.speakerLevel, 0, 100, 100),
    };
  } catch {
    return fallback;
  }
}

function storeAudio(value) {
  try { localStorage.setItem(AUDIO_KEY, JSON.stringify(value)); } catch { /* private mode */ }
}

function loadPeerStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PEER_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const stored = {};
    for (const [name, level] of Object.entries(parsed)) {
      const nick = cleanName(name, 16);
      if (nick) stored[nick] = clampLevel(level, 0, 100, 100);
    }
    return stored;
  } catch {
    return {};
  }
}

function storePeerStore(value) {
  try { localStorage.setItem(PEER_KEY, JSON.stringify(value)); } catch { /* private mode */ }
}

function loadShareQuality() {
  try {
    const saved = localStorage.getItem(SHARE_KEY);
    return SHARE_CAPTURE[saved] ? saved : 'medium';
  } catch {
    return 'medium';
  }
}

function formatClock(stamp) {
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function clampLevel(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function levelOf(analyser) {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const value of data) {
    const sample = (value - 128) / 128;
    sum += sample * sample;
  }
  return Math.sqrt(sum / data.length);
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
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18"/>',
    volume: '<path d="M4 10v4h3.2L12 18V6L7.2 10H4z"/><path d="M15.2 9.2a4 4 0 0 1 0 5.6"/><path d="M17.4 7a7 7 0 0 1 0 10"/>',
    volumeOff: '<path d="M4 10v4h3.2L12 18V6L7.2 10H4z"/><path d="M16 10l5 5"/><path d="M21 10l-5 5"/>',
  };
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: paths[name] }} />
  );
}

function VolumeKnob({ value, name, onChange }) {
  const dial = useRef(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  function levelFromEvent(event) {
    const rect = dial.current.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const deg = Math.atan2(dx, -dy) * (180 / Math.PI);
    if (deg < -140 || deg > 140) return valueRef.current < 50 ? 0 : 100;
    return Math.round(((deg + 140) / 280) * 100);
  }

  function onPointerDown(event) {
    event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 캡처를 지원하지 않는 입력 */ }
    onChange(levelFromEvent(event));
  }

  function onPointerMove(event) {
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    onChange(levelFromEvent(event));
  }

  const angle = -140 + (value / 100) * 280;
  return (
    <div className="peer-knob">
      <button
        type="button"
        className="knob"
        ref={dial}
        style={{ '--fill': `${(value / 100) * 77.8}%` }}
        aria-label={`${name} 소리 크기`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onWheel={(event) => {
          event.preventDefault();
          const step = event.deltaY < 0 ? 5 : -5;
          onChange(clampLevel(valueRef.current + step, 0, 100, valueRef.current));
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
            event.preventDefault();
            onChange(Math.min(100, value + 5));
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
            event.preventDefault();
            onChange(Math.max(0, value - 5));
          }
        }}
      >
        <span className="knob-cap">
          <span className="knob-mark" style={{ transform: `rotate(${angle}deg)` }} />
        </span>
      </button>
      <span className="knob-value">{value}%</span>
    </div>
  );
}

function ScreenVideo({ track, label, muted, quality, onQuality, onFail, allowFull }) {
  const frameRef = useRef(null);
  const videoRef = useRef(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.srcObject = new MediaStream([track]);
    video.play().catch(() => {});
    return () => { video.srcObject = null; };
  }, [track]);
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  async function toggleFull() {
    const node = frameRef.current;
    if (!node?.requestFullscreen) {
      onFail?.();
      return;
    }
    try {
      if (document.fullscreenElement === node) await document.exitFullscreen();
      else await node.requestFullscreen();
    } catch {
      onFail?.();
    }
  }

  return (
    <figure className={`tile${full ? ' is-full' : ''}`} ref={frameRef}>
      <video ref={videoRef} autoPlay playsInline muted={muted} onDoubleClick={allowFull ? toggleFull : undefined} />
      <div className="tile-tools">
        <select aria-label={`${label} 화질`} value={quality} onChange={(event) => onQuality(event.target.value)}>
          <option value="high">선명</option>
          <option value="medium">보통</option>
          <option value="low">가볍게</option>
        </select>
        {allowFull ? <button type="button" onClick={toggleFull}>{full ? '전체화면 종료' : '전체화면'}</button> : null}
      </div>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

export default function VoiceApp() {
  const socketRef = useRef(null);
  const rtcRef = useRef(null);
  const roomRef = useRef(null);
  const meRef = useRef({ muted: false, deafened: false, sharing: false });
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
  const audioSettingsRef = useRef(loadAudio());
  const micGraphRef = useRef(null);
  const settingsOpenRef = useRef(false);
  const speakingRef = useRef({});
  const settingsDialog = useRef(null);
  const roomMetaRef = useRef(null);
  const returnRoomRef = useRef(null);
  const passwordsRef = useRef(new Map());
  const directoryOpenRef = useRef(false);
  const [audioSettings, setAudioSettings] = useState(audioSettingsRef.current);
  const [mics, setMics] = useState([]);
  const [speakers, setSpeakers] = useState([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [micMeter, setMicMeter] = useState(0);
  const [speaking, setSpeaking] = useState({});
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [roomQuery, setRoomQuery] = useState('');
  const [returnRoom, setReturnRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatOpen, setChatOpen] = useState(true);
  const [unread, setUnread] = useState(0);
  const [shareQuality, setShareQuality] = useState('medium');
  const [watchQuality, setWatchQuality] = useState({});
  const chatRoomRef = useRef('');
  const chatOpenRef = useRef(true);
  const chatLogRef = useRef(null);
  const shareQualityRef = useRef('medium');
  const savedPeerRef = useRef(loadPeerStore());
  const peerLevelsRef = useRef({});
  const openVolumeRef = useRef('');
  const [peerLevels, setPeerLevels] = useState({});
  const [openVolumeId, setOpenVolumeId] = useState('');

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
    if (meRef.current.deafened || audioSettingsRef.current.speakerLevel <= 0) return;
    const audio = new Audio(kind === 'join' ? '/sounds/join.mp3' : '/sounds/leave.mp3');
    audio.volume = audioSettingsRef.current.speakerLevel / 100;
    const start = () => audio.play().catch(() => {});
    if (audioSettingsRef.current.speakerId && typeof audio.setSinkId === 'function') {
      audio.setSinkId(audioSettingsRef.current.speakerId).then(start).catch(start);
    } else start();
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
    rememberPeerLevels(sorted);
    for (const person of sorted) {
      if (person.id !== socketRef.current?.id && !person.sharing) remoteVideos.current.delete(person.id);
    }
    setVideoEpoch((value) => value + 1);
  }

  function pushState(next = meRef.current) {
    socketRef.current?.emit('state:update', {
      muted: next.muted,
      deafened: next.deafened,
      sharing: next.sharing,
    });
  }

  function outputVolume() {
    if (meRef.current.deafened) return 0;
    return audioSettingsRef.current.speakerLevel / 100;
  }

  function gainFor(peerId) {
    if (meRef.current.deafened) return 0;
    const master = audioSettingsRef.current.speakerLevel / 100;
    const peer = clampLevel(peerLevelsRef.current[peerId] ?? 100, 0, 100, 100) / 100;
    return master * peer;
  }

  function applyOutput() {
    const speakerId = audioSettingsRef.current.speakerId;
    const ctx = audioCtxRef.current;
    ctx?.resume().catch(() => {});
    if (ctx && speakerId && typeof ctx.setSinkId === 'function' && ctx._sink !== speakerId) {
      ctx._sink = speakerId;
      ctx.setSinkId(speakerId).catch(() => {});
    }
    remoteAudios.current.forEach((audio) => {
      const level = Math.min(1, Math.max(0, gainFor(audio.dataset.peer)));
      if (audio._gain) audio._gain.gain.value = level;
      else audio.volume = level;
      audio.muted = level <= 0;
      if (!audio._gain && speakerId && typeof audio.setSinkId === 'function' && audio._sink !== speakerId) {
        audio._sink = speakerId;
        audio.setSinkId(speakerId).catch(() => {});
      }
      if (level > 0 && audio.paused) audio.play().catch(() => {});
    });
  }

  function rememberPeerLevels(list) {
    const next = {};
    for (const person of list) {
      if (person.id === socketRef.current?.id) continue;
      const current = peerLevelsRef.current[person.id];
      next[person.id] = current == null
        ? clampLevel(savedPeerRef.current[person.nickname], 0, 100, 100)
        : clampLevel(current, 0, 100, 100);
    }
    const prev = peerLevelsRef.current;
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    let changed = prevKeys.length !== nextKeys.length;
    if (!changed) {
      for (const key of nextKeys) {
        if (prev[key] !== next[key]) changed = true;
      }
    }
    peerLevelsRef.current = next;
    if (changed) setPeerLevels(next);
    applyOutput();
  }

  function setOpenVolume(id) {
    openVolumeRef.current = id;
    setOpenVolumeId(id);
  }

  function changePeerLevel(person, value) {
    const level = clampLevel(value, 0, 100, 100);
    const next = { ...peerLevelsRef.current, [person.id]: level };
    peerLevelsRef.current = next;
    setPeerLevels(next);
    const nick = cleanName(person.nickname, 16);
    if (nick) {
      savedPeerRef.current = { ...savedPeerRef.current, [nick]: level };
      storePeerStore(savedPeerRef.current);
    }
    applyOutput();
  }

  function releaseRemoteAudios() {
    remoteAudios.current.forEach((audio) => {
      audio.srcObject = null;
      if (audio._keeper) audio._keeper.srcObject = null;
      try { audio._source?.disconnect(); } catch { /* already stopped */ }
      try { audio._gain?.disconnect(); } catch { /* already stopped */ }
    });
    remoteAudios.current = [];
  }

  function applyMic(stream, flags = meRef.current) {
    stream?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    if (micGraphRef.current) {
      micGraphRef.current.gain.gain.value = flags.muted ? 0 : audioSettingsRef.current.micLevel / 100;
    }
    applyOutput();
  }

  function releaseMicGraph() {
    const graph = micGraphRef.current;
    if (!graph) return;
    micGraphRef.current = null;
    try { graph.source.disconnect(); } catch { /* already stopped */ }
    graph.rawStream.getTracks().forEach((track) => track.stop());
    try { graph.processed.stop(); } catch { /* already stopped */ }
  }

  function attachMicGraph(rawStream) {
    const previous = micGraphRef.current;
    const ctx = ensureContext();
    const source = ctx.createMediaStreamSource(rawStream);
    const gain = ctx.createGain();
    gain.gain.value = audioSettingsRef.current.micLevel / 100;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const destination = ctx.createMediaStreamDestination();
    source.connect(gain);
    source.connect(analyser);
    gain.connect(destination);
    const processed = destination.stream.getAudioTracks()[0];
    micGraphRef.current = { rawStream, source, gain, analyser, processed };
    rtcRef.current.setMicTrack(processed);
    rtcRef.current.localStream = rawStream;
    applyMic(rawStream);
    if (previous && previous !== micGraphRef.current) {
      try { previous.source.disconnect(); } catch { /* already stopped */ }
      previous.rawStream.getTracks().forEach((track) => track.stop());
      try { previous.processed.stop(); } catch { /* already stopped */ }
    }
    return rawStream;
  }

  function unlockAudio() {
    ensureContext();
    const audio = new Audio(SILENT_WAV);
    audio.muted = true;
    audio.play().catch(() => {});
  }

  function ensureContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx && !audioCtxRef.current) audioCtxRef.current = new Ctx();
    audioCtxRef.current?.resume().catch(() => {});
    return audioCtxRef.current;
  }

  async function captureMic(deviceId) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (deviceId) audio.deviceId = { exact: deviceId };
    try {
      return await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (err) {
      if (!deviceId) throw err;
      return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    }
  }

  async function ensureMic() {
    const current = micGraphRef.current?.rawStream;
    if (current?.getAudioTracks().some((track) => track.readyState === 'live')) {
      applyMic(current);
      return current;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicError('이 브라우저는 마이크를 지원하지 않아요. 다른 사람 목소리는 들을 수 있어요.');
      return null;
    }
    try {
      const stream = await captureMic(audioSettingsRef.current.micId);
      attachMicGraph(stream);
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
    roomMetaRef.current = nextRoom;
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

  function closeDirectory() {
    directoryOpenRef.current = false;
    setDirectoryOpen(false);
  }

  function openDirectory() {
    if (roomRef.current) {
      directoryOpenRef.current = true;
      setDirectoryOpen(true);
      return;
    }
    document.getElementById('room-search')?.focus();
  }

  function pinReturnRoom() {
    const id = roomRef.current;
    if (!id || returnRoomRef.current) return;
    const anchor = {
      id,
      name: roomMetaRef.current?.name || '원래 방',
      password: passwordsRef.current.get(id) || '',
    };
    returnRoomRef.current = anchor;
    setReturnRoom(anchor);
  }

  function clearReturnRoom() {
    returnRoomRef.current = null;
    setReturnRoom(null);
  }

  async function leaveRoom({ keepMic = false, notify = true, keepView = false } = {}) {
    if (!keepView) {
      const url = new URL(window.location.href);
      url.searchParams.delete('room');
      window.history.replaceState(null, '', url.pathname);
    }
    stopShare();
    rtcRef.current.closeAll();
    remoteVideos.current.clear();
    releaseRemoteAudios();
    const prev = roomRef.current;
    roomRef.current = null;
    rtcRef.current.setRoom(null);
    if (!keepView) {
      roomMetaRef.current = null;
      setRoom(null);
      applyParticipants([]);
      clearReturnRoom();
      closeDirectory();
    }
    setScreenTrack(null);
    if (!keepView) clearChat();
    if (prev && notify) await emitAck('room:leave');
    if (!keepMic) {
      releaseMicGraph();
      rtcRef.current.setMicTrack(null);
      rtcRef.current.localStream = null;
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
      const res = await emitAck('room:create', { name, password, nickname: nick, holdPrevious: Boolean(roomRef.current) });
      if (!res.ok) {
        showToast(res.message || '방을 만들지 못했어요.');
        return;
      }
      acceptChat(res.room.id, res.messages);
      if (roomRef.current) {
        pinReturnRoom();
        await leaveRoom({ keepMic: true, notify: false, keepView: true });
      }
      passwordsRef.current.set(res.room.id, String(password || ''));
      enterRoom(res.room);
      pushState();
      setCreateOpen(false);
      closeDirectory();
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
      const switching = Boolean(roomRef.current && roomRef.current !== roomId);
      const returning = returnRoomRef.current?.id === roomId;
      const res = await emitAck('room:join', { roomId, password, nickname: nick, holdPrevious: switching });
      if (!res.ok) {
        showToast(res.message || '방에 들어가지 못했어요.');
        return;
      }
      acceptChat(res.room.id, res.messages);
      if (switching) {
        if (!returning) pinReturnRoom();
        await leaveRoom({ keepMic: true, notify: false, keepView: true });
      }
      passwordsRef.current.set(roomId, String(password || ''));
      enterRoom(res.room);
      if (returning) clearReturnRoom();
      pushState();
      closeDirectory();
    } finally {
      busyRef.current = false;
    }
  }

  function requestJoin(target) {
    if (!target || target.id === roomRef.current) return;
    unlockAudio();
    const saved = passwordsRef.current.get(target.id);
    if (!target.hasPassword || saved) {
      joinRoom(target.id, saved || '');
      return;
    }
    setPasswordRoom(target);
  }

  function returnToOriginal() {
    const target = returnRoomRef.current;
    if (!target) return;
    const live = rooms.find((item) => item.id === target.id);
    if (!live) {
      showToast('원래 방이 이미 닫혀 있어요.');
      clearReturnRoom();
      return;
    }
    if (live.participants.length >= maxMembers) {
      showToast('원래 방이 가득 찼어요.');
      return;
    }
    joinRoom(target.id, target.password || '');
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

  function clearChat() {
    chatRoomRef.current = '';
    setMessages([]);
    setUnread(0);
    setChatDraft('');
  }

  function acceptChat(roomId, history) {
    chatRoomRef.current = roomId;
    const incoming = Array.isArray(history) ? history : [];
    setMessages((prev) => {
      const extras = prev.filter((item) => item.roomId === roomId && !incoming.some((message) => message.id === item.id));
      return [...incoming, ...extras].slice(-80);
    });
  }

  async function sendChat(event) {
    event.preventDefault();
    const text = chatDraft.replace(/\s+/g, ' ').trim();
    if (!text || !roomRef.current) return;
    setChatDraft('');
    const res = await emitAck('chat:send', { text });
    if (!res.ok) {
      setChatDraft(text);
      showToast(res.message || '메시지를 보내지 못했어요.');
    }
  }

  function toggleChat() {
    setChatOpen((open) => {
      const next = !open;
      chatOpenRef.current = next;
      if (next) setUnread(0);
      return next;
    });
  }

  async function applyCaptureQuality(track, level) {
    const preset = SHARE_CAPTURE[level] || SHARE_CAPTURE.medium;
    if (!track?.applyConstraints) return;
    try {
      await track.applyConstraints({
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: preset.frameRate, max: preset.frameRate },
      });
    } catch { /* 브라우저가 해상도 변경을 거절할 수 있어요 */ }
  }

  function changeSendQuality(level) {
    if (!SHARE_CAPTURE[level]) return;
    shareQualityRef.current = level;
    setShareQuality(level);
    try { localStorage.setItem(SHARE_KEY, level); } catch { /* private mode */ }
    rtcRef.current?.setOutboundQuality(level);
    if (screenTrack) applyCaptureQuality(screenTrack, level);
  }

  function changeWatchQuality(peerId, level) {
    if (!SHARE_CAPTURE[level] || !peerId) return;
    setWatchQuality((prev) => ({ ...prev, [peerId]: level }));
    socketRef.current?.emit('share:quality', { to: peerId, level });
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
    const capture = SHARE_CAPTURE[shareQualityRef.current] || SHARE_CAPTURE.medium;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: capture.width },
          height: { ideal: capture.height },
          frameRate: { ideal: capture.frameRate, max: capture.frameRate },
        },
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
    if (videoTrack) videoTrack.contentHint = 'detail';
    videoTrack?.addEventListener('ended', () => stopShare());
    rtcRef.current.screenStream = stream;
    rtcRef.current.publishScreen(stream);
    rtcRef.current.setOutboundQuality(shareQualityRef.current);
    setScreenTrack(videoTrack || null);
    const next = patchMe({ sharing: true });
    pushState(next);
  }

  function toggleMute() {
    if (!roomRef.current) return;
    const next = patchMe({ muted: !meRef.current.muted });
    applyMic(micGraphRef.current?.rawStream, next);
    pushState(next);
  }

  function toggleDeafen() {
    if (!roomRef.current) return;
    const next = patchMe({ deafened: !meRef.current.deafened });
    applyOutput();
    pushState(next);
  }

  function saveAudio(partial) {
    const next = { ...audioSettingsRef.current, ...partial };
    audioSettingsRef.current = next;
    setAudioSettings(next);
    storeAudio(next);
    return next;
  }

  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices();
    setMics(list.filter((device) => device.kind === 'audioinput'));
    setSpeakers(list.filter((device) => device.kind === 'audiooutput'));
  }

  async function openSettings() {
    unlockAudio();
    settingsOpenRef.current = true;
    setSettingsOpen(true);
    await ensureMic();
    await refreshDevices();
  }

  async function chooseMic(deviceId) {
    saveAudio({ micId: deviceId });
    if (!micGraphRef.current && !roomRef.current) return;
    try {
      const stream = await captureMic(deviceId);
      attachMicGraph(stream);
      setMicError('');
      await refreshDevices();
    } catch {
      showToast('선택한 마이크로 바꾸지 못했어요.');
    }
  }

  function chooseSpeaker(deviceId) {
    saveAudio({ speakerId: deviceId });
    applyOutput();
  }

  function changeMicLevel(value) {
    saveAudio({ micLevel: clampLevel(value, 0, 200, 100) });
    applyMic(micGraphRef.current?.rawStream);
  }

  function changeSpeakerLevel(value) {
    saveAudio({ speakerLevel: clampLevel(value, 0, 100, 100) });
    applyOutput();
  }

  function testSpeaker() {
    unlockAudio();
    if (audioSettingsRef.current.speakerLevel <= 0) {
      showToast('스피커 크기가 0이라 소리가 나지 않아요.');
      return;
    }
    const audio = new Audio('/sounds/join.mp3');
    audio.volume = audioSettingsRef.current.speakerLevel / 100;
    const start = () => audio.play().catch(() => showToast('스피커 테스트를 재생하지 못했어요.'));
    if (audioSettingsRef.current.speakerId && typeof audio.setSinkId === 'function') {
      audio.setSinkId(audioSettingsRef.current.speakerId).then(start).catch(start);
    } else start();
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
    const savedQuality = loadShareQuality();
    shareQualityRef.current = savedQuality;
    setShareQuality(savedQuality);

    const socket = io({ autoConnect: true });
    socketRef.current = socket;
    const rtc = createRtcSession({
      socket,
      onTrack: (peerId, track) => {
        if (track.kind === 'audio') {
          const stream = new MediaStream([track]);
          const ctx = ensureContext();
          const source = ctx.createMediaStreamSource(stream);
          const gain = ctx.createGain();
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          source.connect(gain);
          gain.connect(ctx.destination);
          const keeper = new Audio();
          keeper.autoplay = true;
          keeper.muted = true;
          keeper.volume = 0;
          keeper.srcObject = stream;
          keeper.play().catch(() => {});
          const playback = {
            dataset: { peer: peerId, analysed: '1' },
            srcObject: stream,
            _source: source,
            _gain: gain,
            _analyser: analyser,
            _keeper: keeper,
            volume: 1,
            muted: false,
            paused: false,
            play() { return ctx.resume().catch(() => {}); },
          };
          remoteAudios.current.push(playback);
          applyOutput();
          track.addEventListener('ended', () => {
            playback.srcObject = null;
            keeper.srcObject = null;
            try { source.disconnect(); } catch { /* already stopped */ }
            try { gain.disconnect(); } catch { /* already stopped */ }
            remoteAudios.current = remoteAudios.current.filter((item) => item !== playback);
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
        releaseRemoteAudios();
        roomRef.current = null;
        roomMetaRef.current = null;
        setRoom(null);
        applyParticipants([]);
        setScreenTrack(null);
        clearReturnRoom();
        closeDirectory();
        clearChat();
        showToast('연결이 끊어져 방에서 나왔어요.');
      }
    });
    socket.on('chat:message', (message) => {
      if (!message?.id || message.roomId !== chatRoomRef.current) return;
      setMessages((prev) => (prev.some((item) => item.id === message.id) ? prev : [...prev, message].slice(-80)));
      if (!chatOpenRef.current && message.from !== socket.id) setUnread((count) => count + 1);
    });
    socket.on('share:quality', ({ from, level } = {}) => {
      rtc.setPeerShareQuality(from, level);
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
      roomMetaRef.current = next;
      setRoom(next);
      applyParticipants(next.participants);
      rtc.sync(next.participants.map((person) => person.id));
    });
    socket.on('share:stop', ({ id }) => {
      clearPeerMedia(id);
    });
    socket.on('signal', (message) => rtc.handleSignal(message));

    const onKey = (event) => {
      if (event.key === 'Escape' && openVolumeRef.current) {
        openVolumeRef.current = '';
        setOpenVolumeId('');
        return;
      }
      if (event.key === 'Escape' && directoryOpenRef.current) {
        directoryOpenRef.current = false;
        setDirectoryOpen(false);
        return;
      }
      if (event.target.matches('input, textarea, select')) return;
      if ((event.key === 'm' || event.key === 'M') && roomRef.current) {
        event.preventDefault();
        toggleMute();
      }
    };
    document.addEventListener('keydown', onKey);
    const onDevices = () => refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', onDevices);
    return () => {
      document.removeEventListener('keydown', onKey);
      navigator.mediaDevices?.removeEventListener('devicechange', onDevices);
      socket.disconnect();
    };
    // Mount once. Handlers read the latest values through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!openVolumeId) return undefined;
    const close = (event) => {
      if (event.target.closest('.peer-sound, .peer-knob')) return;
      setOpenVolume('');
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [openVolumeId]);

  useEffect(() => {
    document.body.dataset.view = room ? 'call' : 'lobby';
    document.body.dataset.online = online ? '1' : '0';
  }, [room, online]);

  useEffect(() => {
    if (!directoryOpen) return undefined;
    document.getElementById('room-search')?.focus();
    return undefined;
  }, [directoryOpen]);

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

  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
    const dialog = settingsDialog.current;
    if (!dialog) return;
    if (settingsOpen && !dialog.open) dialog.showModal();
    if (!settingsOpen && dialog.open) dialog.close();
  }, [settingsOpen]);

  useEffect(() => {
    let frame = 0;
    let last = 0;
    const tick = (now) => {
      frame = window.requestAnimationFrame(tick);
      if (now - last < 80) return;
      last = now;
      const next = {};
      const graph = micGraphRef.current;
      const selfId = socketRef.current?.id;
      if (graph && selfId && !meRef.current.muted && roomRef.current) {
        const level = levelOf(graph.analyser);
        next[selfId] = level > 0.05;
        if (settingsOpenRef.current) {
          const meter = Math.min(100, Math.round(level * 420));
          setMicMeter((prev) => (Math.abs(prev - meter) > 3 ? meter : prev));
        }
      } else if (settingsOpenRef.current) {
        setMicMeter(0);
      }
      const ctx = audioCtxRef.current;
      remoteAudios.current.forEach((audio) => {
        const id = audio.dataset.peer;
        if (!id || !audio.srcObject || !ctx) return;
        if (!audio.dataset.analysed) {
          try {
            const source = ctx.createMediaStreamSource(audio.srcObject);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            source.connect(analyser);
            audio.dataset.analysed = '1';
            audio._analyser = analyser;
          } catch { /* stream already connected */ }
        }
        if (audio._analyser) next[id] = levelOf(audio._analyser) > 0.05;
      });
      const prev = speakingRef.current;
      const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
      let changed = false;
      for (const key of keys) {
        if (Boolean(prev[key]) !== Boolean(next[key])) changed = true;
      }
      if (changed) {
        speakingRef.current = next;
        setSpeaking(next);
      }
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const tiles = useMemo(() => {
    const list = [];
    if (me.sharing && screenTrack && screenTrack.readyState !== 'ended') {
      list.push({ id: 'local', track: screenTrack, label: '내 화면', muted: true, peerId: '' });
    }
    for (const person of participants) {
      if (!person.sharing || person.id === socketId) continue;
      const bucket = remoteVideos.current.get(person.id);
      if (!bucket) continue;
      for (const [trackId, track] of bucket) {
        if (track.readyState === 'ended') continue;
        list.push({
          id: `${person.id}:${trackId}`,
          peerId: person.id,
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

  useEffect(() => {
    const log = chatLogRef.current;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
  }, [messages, chatOpen, room]);

  const connLabel = {
    failed: '연결 실패',
    disconnected: '연결 끊김',
    connecting: '연결 중',
    new: '연결 중',
    checking: '연결 중',
  };

  const query = roomQuery.trim().toLowerCase();
  const visibleRooms = rooms.filter((item) => {
    if (!query) return true;
    if (item.name.toLowerCase().includes(query)) return true;
    return item.participants.some((person) => person.nickname.toLowerCase().includes(query));
  });
  const canReturn = Boolean(returnRoom && returnRoom.id !== room?.id);

  function renderDirectory(overlay) {
    return (
      <section className={overlay ? 'directory directory-overlay' : 'directory'} aria-label="열린 방">
        <div className="directory-head">
          <div>
            {overlay ? <p className="eyebrow">머무른 채로 둘러보기</p> : null}
            <h2>열린 방</h2>
          </div>
          <div className="directory-actions">
            {canReturn ? <button className="btn secondary" type="button" onClick={returnToOriginal}>원래 방으로</button> : null}
            {overlay ? <button className="btn secondary" type="button" onClick={closeDirectory}>대화로 돌아가기</button> : null}
          </div>
        </div>
        <label className="directory-search">
          <span>검색</span>
          <input
            id="room-search"
            value={roomQuery}
            onChange={(event) => setRoomQuery(event.target.value)}
            placeholder="방 이름이나 참여자"
          />
        </label>
        <p className="directory-count">{rooms.length === 0 ? '아직 열린 방이 없어요' : `${visibleRooms.length}개 표시`}</p>
        {rooms.length === 0 ? (
          <div className="empty">
            <div className="empty-mark" aria-hidden="true" />
            <h2>아직 열린 방이 없어요</h2>
            <p>첫 방을 만들면 이 목록에서 바로 찾을 수 있어요.</p>
            <button className="btn" type="button" onClick={() => setCreateOpen(true)}>방 만들기</button>
          </div>
        ) : visibleRooms.length === 0 ? (
          <p className="directory-empty">찾는 방이 없어요.</p>
        ) : (
          <div className="directory-list">
            {visibleRooms.map((item) => {
              const here = item.id === room?.id;
              const full = item.participants.length >= maxMembers && !here;
              return (
                <article key={item.id} className={`directory-row${here ? ' here' : ''}`}>
                  <div>
                    <h3>{item.name}</h3>
                    <p className="who">{item.participants.length}/{maxMembers}명 · {formatWho(item.participants)}</p>
                  </div>
                  <div className="directory-meta">
                    {item.hasPassword ? <span className="lock-pill" title="비밀번호 방"><Icon name="lock" /></span> : null}
                    <span className="count-pill">{item.participants.length}</span>
                    <button className="btn" type="button" disabled={full || here} onClick={() => requestJoin(item)}>
                      {here ? '지금 여기' : full ? '가득 참' : '입장'}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    );
  }

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
        <div className="side-section">
        <label className="nick-field">
          <span>내 별명 <em>눌러서 수정</em></span>
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
        <p className="nick-help">이 칸을 눌러 별명을 바꾸면 바로 적용돼요. 계정은 필요 없어요.</p>
        </div>
        <div className="side-section">
        <button className="btn secondary block" type="button" onClick={openSettings}>소리 설정</button>
        <button className="btn secondary block" type="button" onClick={openDirectory}>방 찾기</button>
        </div>
        <div className="side-section side-rooms">
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
        </div>
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
            {renderDirectory(false)}
          </section>
        ) : (
          <section id="call" className={tiles.length && !stageCollapsed ? 'has-stage' : ''}>
            <header className="call-head">
              <div>
                <p className="eyebrow">{room.hasPassword ? '비밀번호로 잠긴 방' : '공개 방'}</p>
                <h1>{room.name}</h1>
                <p className="lede">{participants.length}명 참여 중 · 최대 {maxMembers}명</p>
              </div>
              <div className="call-actions">
                <button className="btn secondary" type="button" onClick={toggleChat}>
                  {chatOpen ? '채팅 닫기' : `채팅${unread ? ` ${unread}` : ''}`}
                </button>
                <button className="btn secondary" type="button" onClick={openDirectory}>열린 방</button>
              </div>
            </header>
            {canReturn ? (
              <div className="return-bar">
                <span>원래 방 · {returnRoom.name}</span>
                <button type="button" onClick={returnToOriginal}>돌아가기</button>
              </div>
            ) : null}
            {micError ? <p className="banner">{micError}</p> : null}
            <div className={`call-split${chatOpen ? '' : ' chat-closed'}`}>
            <div className="call-main">
            {tiles.length ? (
              <div className="stage-bar">
                <span>{stageCollapsed ? '화면 공유를 접어 두었어요' : '보는 사람만 전체화면으로 볼 수 있어요. 화질은 화면 위에서 바꿀 수 있어요.'}</span>
                <button type="button" onClick={() => setStageCollapsed((value) => !value)}>
                  {stageCollapsed ? '화면 보기' : '화면 접기'}
                </button>
              </div>
            ) : null}
            {tiles.length && !stageCollapsed ? (
              <div className="stage">
                {tiles.map((tile) => (
                  <ScreenVideo
                    key={tile.id}
                    track={tile.track}
                    label={tile.label}
                    muted={tile.muted}
                    allowFull={Boolean(tile.peerId)}
                    quality={tile.peerId ? (watchQuality[tile.peerId] || 'medium') : shareQuality}
                    onQuality={(level) => (tile.peerId ? changeWatchQuality(tile.peerId, level) : changeSendQuality(level))}
                    onFail={() => showToast('이 브라우저에서는 전체화면을 쓸 수 없어요.')}
                  />
                ))}
              </div>
            ) : null}
            <div className="members">
              {participants.map((person) => {
                const self = person.id === socketId;
                const view = self ? { ...person, nickname: cleanName(nickname, 16) || person.nickname, muted: me.muted, deafened: me.deafened, sharing: me.sharing } : person;
                const color = hue(view.nickname);
                const status = self ? '' : (connLabel[conn[person.id]] || '');
                return (
                  <article key={person.id} className={`member${speaking[person.id] ? ' speaking' : ''}`}>
                    <div className="avatar" style={{ background: `linear-gradient(160deg, hsl(${color} 85% 62%), hsl(${(color + 36) % 360} 70% 42%))` }}>{initial(view.nickname)}</div>
                    <div className="member-title">
                      <strong className="member-name">{view.nickname}{self ? <span className="me-badge">나</span> : null}</strong>
                      {self ? null : (
                        <button
                          type="button"
                          className={`peer-sound${(peerLevels[person.id] ?? 100) === 100 ? '' : ' is-custom'}${openVolumeId === person.id ? ' is-open' : ''}`}
                          aria-label={`${view.nickname} 소리 조절`}
                          aria-expanded={openVolumeId === person.id}
                          onClick={() => setOpenVolume(openVolumeId === person.id ? '' : person.id)}
                        >
                          <Icon name={(peerLevels[person.id] ?? 100) <= 0 ? 'volumeOff' : 'volume'} />
                        </button>
                      )}
                      {!self && openVolumeId === person.id ? (
                        <VolumeKnob
                          value={peerLevels[person.id] ?? 100}
                          name={view.nickname}
                          onChange={(level) => changePeerLevel(person, level)}
                        />
                      ) : null}
                    </div>
                    {status ? <span className="member-status">{status}</span> : null}
                    <div className="flags">
                      {view.muted ? <Icon name="micOff" /> : null}
                      {view.deafened ? <Icon name="headphonesOff" /> : null}
                      {view.sharing ? <Icon name="screen" /> : null}
                    </div>
                  </article>
                );
              })}
            </div>
            </div>
            {chatOpen ? (
              <aside className="chat-panel">
                <h2>채팅</h2>
                <div className="chat-log" ref={chatLogRef} role="log" aria-live="polite">
                  {messages.length === 0 ? <p className="chat-empty">아직 메시지가 없어요.</p> : messages.map((message) => (
                    <article key={message.id} className={`chat-line${message.from === socketId ? ' mine' : ''}`}>
                      <strong>{message.nickname}<time dateTime={new Date(message.sentAt).toISOString()}>{formatClock(message.sentAt)}</time></strong>
                      <p>{message.text}</p>
                    </article>
                  ))}
                </div>
                <form className="chat-form" onSubmit={sendChat}>
                  <input
                    maxLength={200}
                    value={chatDraft}
                    placeholder="메시지"
                    aria-label="채팅 메시지"
                    onChange={(event) => setChatDraft(event.target.value)}
                  />
                  <button className="btn" type="submit">보내기</button>
                </form>
              </aside>
            ) : null}
            </div>
            <footer className="dock">
              <div className="controls">
                <button className={`ctrl${me.muted ? ' is-danger' : ''}`} type="button" onClick={toggleMute}>
                  <Icon name={me.muted ? 'micOff' : 'mic'} />
                  <span className="ctrl-label">{me.muted ? '마이크 꺼짐' : '마이크 켜짐'}</span>
                </button>
                <button className={`ctrl${me.deafened ? ' is-danger' : ''}`} type="button" onClick={toggleDeafen}>
                  <Icon name={me.deafened ? 'headphonesOff' : 'headphones'} />
                  <span className="ctrl-label">{me.deafened ? '소리 꺼짐' : '소리 켜짐'}</span>
                </button>
                <button className="ctrl" type="button" onClick={openSettings}>
                  <Icon name="gear" />
                  <span className="ctrl-label">설정</span>
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
              <p className="hint">M 키는 마이크만 껐다 켭니다. 소리 끄기는 듣기만 막고, 내 목소리는 그대로 나갑니다. 이름 옆 소리 아이콘을 누르면 그 사람 소리만 조절할 수 있어요.</p>
            </footer>
          </section>
        )}
        {room && directoryOpen ? renderDirectory(true) : null}
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

      <dialog ref={settingsDialog} onClose={() => { settingsOpenRef.current = false; setSettingsOpen(false); }}>
        <div className="modal">
          <h2>소리 설정</h2>
          <p className="modal-copy">연결해서 쓰고 있는 마이크와 스피커를 고르고, 크기와 테스트를 할 수 있어요.</p>
          <label>
            <span>마이크</span>
            <select value={audioSettings.micId} onChange={(event) => chooseMic(event.target.value)}>
              <option value="">기본 마이크</option>
              {mics.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>{device.label || `마이크 ${index + 1}`}</option>
              ))}
            </select>
          </label>
          <label>
            <span>마이크 크기 {audioSettings.micLevel}%</span>
            <input type="range" min="0" max="200" value={audioSettings.micLevel} onChange={(event) => changeMicLevel(event.target.value)} />
          </label>
          <div className="meter" aria-hidden="true"><span style={{ width: `${micMeter}%` }} /></div>
          <p className="meter-label">말하면 막대가 움직여요. 이게 마이크 테스트예요.</p>
          <label>
            <span>스피커</span>
            <select value={audioSettings.speakerId} onChange={(event) => chooseSpeaker(event.target.value)}>
              <option value="">기본 스피커</option>
              {speakers.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>{device.label || `스피커 ${index + 1}`}</option>
              ))}
            </select>
          </label>
          {speakers.length === 0 ? <p className="meter-label">이 브라우저는 스피커 목록을 보여주지 않을 수 있어요. Chrome에서는 목록이 나와요.</p> : null}
          <label>
            <span>스피커 크기 {audioSettings.speakerLevel}%</span>
            <input type="range" min="0" max="100" value={audioSettings.speakerLevel} onChange={(event) => changeSpeakerLevel(event.target.value)} />
          </label>
          <div className="modal-actions">
            <button className="btn secondary" type="button" onClick={testSpeaker}>스피커 테스트</button>
            <button className="btn" type="button" onClick={() => setSettingsOpen(false)}>닫기</button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
