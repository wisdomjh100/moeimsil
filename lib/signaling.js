import crypto from 'crypto';

const MAX_MEMBERS = 8;
const MAX_ROOMS = 50;
const NICK_MAX = 16;
const ROOM_MAX = 24;
const PASSWORD_MAX = 32;

const rooms = new Map();

function cleanName(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}

function passwordMatches(room, password) {
  if (!room.passwordHash) return true;
  const given = hashPassword(String(password || '').trim());
  const a = Buffer.from(given);
  const b = Buffer.from(room.passwordHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function makeRoomId() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let id = '';
  do {
    id = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(id));
  return id;
}

function publicParticipant(participant) {
  return {
    id: participant.id,
    nickname: participant.nickname,
    muted: participant.muted,
    deafened: participant.deafened,
    sharing: participant.sharing,
    joinedAt: participant.joinedAt,
  };
}

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    hasPassword: Boolean(room.passwordHash),
    createdAt: room.createdAt,
    participants: [...room.participants.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map(publicParticipant),
  };
}

export function attachSignaling(io) {
  function lobbyPayload() {
    return {
      rooms: [...rooms.values()].sort((a, b) => b.createdAt - a.createdAt).map(publicRoom),
      maxMembers: MAX_MEMBERS,
    };
  }

  function broadcastLobby() {
    io.emit('rooms', lobbyPayload());
  }

  function roomOf(socket) {
    const roomId = socket.data.roomId;
    if (!roomId) return null;
    return rooms.get(roomId) || null;
  }

  function leave(socket) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    socket.data.roomId = null;
    socket.leave(roomId);
    if (!room) {
      broadcastLobby();
      return;
    }
    room.participants.delete(socket.id);
    if (room.participants.size === 0) rooms.delete(roomId);
    else io.to(roomId).emit('room:state', publicRoom(room));
    broadcastLobby();
  }

  function addParticipant(socket, nickname) {
    return {
      id: socket.id,
      nickname,
      muted: false,
      deafened: false,
      sharing: false,
      joinedAt: Date.now(),
    };
  }

  async function createRoom(socket, payload = {}) {
    const nickname = cleanName(payload.nickname, NICK_MAX);
    const name = cleanName(payload.name, ROOM_MAX);
    const password = String(payload.password || '').trim();
    if (!nickname) return { ok: false, message: '별명을 입력해 주세요.' };
    if (!name) return { ok: false, message: '방 이름을 입력해 주세요.' };
    if (password.length > PASSWORD_MAX) {
      return { ok: false, message: `비밀번호는 ${PASSWORD_MAX}자까지 가능해요.` };
    }
    if (rooms.size >= MAX_ROOMS) return { ok: false, message: '지금은 더 이상 방을 만들 수 없어요.' };

    leave(socket);
    const room = {
      id: makeRoomId(),
      name,
      passwordHash: password ? hashPassword(password) : '',
      createdAt: Date.now(),
      participants: new Map(),
    };
    rooms.set(room.id, room);
    socket.data.nickname = nickname;
    socket.data.roomId = room.id;
    room.participants.set(socket.id, addParticipant(socket, nickname));
    await socket.join(room.id);
    const snapshot = publicRoom(room);
    io.to(room.id).emit('room:state', snapshot);
    broadcastLobby();
    return { ok: true, room: snapshot };
  }

  async function joinRoom(socket, payload = {}) {
    const nickname = cleanName(payload.nickname, NICK_MAX);
    const roomId = String(payload.roomId || '');
    if (!nickname) return { ok: false, message: '별명을 입력해 주세요.' };
    const room = rooms.get(roomId);
    if (!room) return { ok: false, message: '방을 찾을 수 없어요. 목록을 다시 확인해 주세요.' };
    if (!passwordMatches(room, payload.password)) {
      return { ok: false, message: '비밀번호가 올바르지 않아요.' };
    }

    if (socket.data.roomId === room.id && room.participants.has(socket.id)) {
      room.participants.get(socket.id).nickname = nickname;
      socket.data.nickname = nickname;
      const snapshot = publicRoom(room);
      io.to(room.id).emit('room:state', snapshot);
      broadcastLobby();
      return { ok: true, room: snapshot };
    }

    if (room.participants.size >= MAX_MEMBERS) {
      return { ok: false, message: `방이 가득 찼어요. 최대 ${MAX_MEMBERS}명까지 들어갈 수 있어요.` };
    }

    leave(socket);
    socket.data.nickname = nickname;
    socket.data.roomId = room.id;
    room.participants.set(socket.id, addParticipant(socket, nickname));
    await socket.join(room.id);
    const snapshot = publicRoom(room);
    io.to(room.id).emit('room:state', snapshot);
    broadcastLobby();
    return { ok: true, room: snapshot };
  }

  function updateNickname(socket, nickname) {
    const name = cleanName(nickname, NICK_MAX);
    if (!name) return { ok: false, message: '별명을 입력해 주세요.' };
    socket.data.nickname = name;
    const room = roomOf(socket);
    if (room) {
      const participant = room.participants.get(socket.id);
      if (participant) participant.nickname = name;
      io.to(room.id).emit('room:state', publicRoom(room));
    }
    broadcastLobby();
    return { ok: true, nickname: name };
  }

  function updateState(socket, patch = {}) {
    const room = roomOf(socket);
    if (!room || !patch || typeof patch !== 'object') return;
    const participant = room.participants.get(socket.id);
    if (!participant) return;
    const wasSharing = participant.sharing;
    if ('muted' in patch) participant.muted = Boolean(patch.muted);
    if ('deafened' in patch) participant.deafened = Boolean(patch.deafened);
    if ('sharing' in patch) participant.sharing = Boolean(patch.sharing);
    const snapshot = publicRoom(room);
    io.to(room.id).emit('room:state', snapshot);
    if (wasSharing && !participant.sharing) {
      io.to(room.id).emit('share:stop', { id: socket.id });
    }
    broadcastLobby();
  }

  function isDescription(value) {
    return Boolean(
      value &&
        typeof value === 'object' &&
        (value.type === 'offer' || value.type === 'answer' || value.type === 'pranswer') &&
        typeof value.sdp === 'string' &&
        value.sdp.length < 200000
    );
  }

  function relaySignal(socket, payload = {}) {
    const room = roomOf(socket);
    if (!room) return;
    const to = String(payload.to || '');
    if (!room.participants.has(to) || to === socket.id) return;
    const message = { from: socket.id };
    if (isDescription(payload.description)) {
      message.description = { type: payload.description.type, sdp: payload.description.sdp };
    }
    if (payload.candidate && typeof payload.candidate === 'object' && payload.candidate.candidate) {
      message.candidate = {
        candidate: String(payload.candidate.candidate),
        sdpMid: payload.candidate.sdpMid ?? null,
        sdpMLineIndex: Number.isInteger(payload.candidate.sdpMLineIndex)
          ? payload.candidate.sdpMLineIndex
          : null,
      };
    }
    if (!message.description && !message.candidate) return;
    io.to(to).emit('signal', message);
  }

  function withAck(handler) {
    return async (payload, cb) => {
      try {
        const result = await handler(payload);
        if (typeof cb === 'function') cb(result);
      } catch (err) {
        console.error(err);
        if (typeof cb === 'function') cb({ ok: false, message: '서버에서 문제가 생겼어요.' });
      }
    };
  }

  io.on('connection', (socket) => {
    socket.data.roomId = null;
    socket.data.nickname = '';
    socket.emit('rooms', lobbyPayload());
    socket.on('room:create', withAck((payload) => createRoom(socket, payload)));
    socket.on('room:join', withAck((payload) => joinRoom(socket, payload)));
    socket.on('room:leave', withAck(() => {
      leave(socket);
      return { ok: true };
    }));
    socket.on('nickname:update', withAck((nickname) => updateNickname(socket, nickname)));
    socket.on('state:update', (patch) => updateState(socket, patch));
    socket.on('signal', (payload) => relaySignal(socket, payload));
    socket.on('disconnect', () => leave(socket));
  });
}
