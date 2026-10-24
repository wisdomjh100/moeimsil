const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const SHARE_PRESETS = {
  high: { maxBitrate: 2500000, maxFramerate: 30, scaleResolutionDownBy: 1, degradationPreference: 'maintain-resolution' },
  medium: { maxBitrate: 1200000, maxFramerate: 24, scaleResolutionDownBy: 1, degradationPreference: 'balanced' },
  low: { maxBitrate: 450000, maxFramerate: 12, scaleResolutionDownBy: 2, degradationPreference: 'maintain-framerate' },
};

export function createRtcSession({ socket, onTrack, onConnection }) {
  const peers = new Map();
  const signalQueue = [];
  let localStream = null;
  let micTrack = null;
  let screenStream = null;
  let outboundQuality = 'medium';
  const peerQuality = new Map();
  let activeRoomId = null;
  let mediaReady = false;

  function send(remoteId, data) {
    if (!socket.connected) return;
    const payload = { to: remoteId };
    if (data.description) {
      payload.description = { type: data.description.type, sdp: data.description.sdp };
    }
    if (data.candidate?.candidate) {
      payload.candidate = {
        candidate: data.candidate.candidate,
        sdpMid: data.candidate.sdpMid ?? null,
        sdpMLineIndex: data.candidate.sdpMLineIndex ?? null,
      };
    }
    if (!payload.description && !payload.candidate) return;
    socket.emit('signal', payload);
  }

  function addStreamTracks(pc, stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      if (track.readyState === 'ended') continue;
      if (!pc.getSenders().some((sender) => sender.track === track)) pc.addTrack(track, stream);
    }
  }

  function createPeer(remoteId) {
    if (!remoteId || remoteId === socket.id || peers.has(remoteId)) return peers.get(remoteId);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const polite = String(socket.id) > String(remoteId);
    const peer = {
      pc,
      closed: false,
      ignoreOffer: false,
      pendingCandidates: [],
      pendingNegotiate: false,
      chain: Promise.resolve(),
    };
    peers.set(remoteId, peer);

    const enqueue = (fn) => {
      peer.chain = peer.chain.then(async () => {
        try { await fn(); } catch (err) { console.warn(err); }
      });
    };

    const negotiate = async () => {
      if (peer.closed || pc.signalingState === 'closed') return;
      if (pc.signalingState !== 'stable') {
        peer.pendingNegotiate = true;
        return;
      }
      peer.pendingNegotiate = false;
      await pc.setLocalDescription();
      send(remoteId, { description: pc.localDescription });
    };

    const flushCandidates = async () => {
      const queued = peer.pendingCandidates.splice(0);
      for (const candidate of queued) {
        try { await pc.addIceCandidate(candidate); } catch (err) {
          if (!peer.ignoreOffer) console.warn(err);
        }
      }
    };

    pc.onnegotiationneeded = () => enqueue(() => negotiate());
    pc.onicecandidate = (event) => {
      if (event.candidate) send(remoteId, { candidate: event.candidate });
    };
    pc.ontrack = (event) => onTrack(remoteId, event.track);
    const publishConn = () => {
      const ice = pc.iceConnectionState;
      const connected = pc.connectionState === 'connected' || ice === 'connected' || ice === 'completed';
      onConnection(remoteId, connected ? 'connected' : pc.connectionState);
      if ((pc.connectionState === 'failed' || ice === 'failed') && !peer.restarted) {
        peer.restarted = true;
        try { pc.restartIce(); } catch (err) { console.warn(err); }
      }
    };
    pc.onconnectionstatechange = publishConn;
    pc.oniceconnectionstatechange = publishConn;

    peer.handleSignal = ({ description, candidate }) => {
      enqueue(async () => {
        if (peer.closed) return;
        if (description) {
          const offerCollision = description.type === 'offer' && pc.signalingState !== 'stable';
          peer.ignoreOffer = !polite && offerCollision;
          if (peer.ignoreOffer) return;
          if (offerCollision) await pc.setLocalDescription({ type: 'rollback' });
          await pc.setRemoteDescription(description);
          await flushCandidates();
          if (description.type === 'offer') {
            await pc.setLocalDescription();
            send(remoteId, { description: pc.localDescription });
          }
          if (peer.pendingNegotiate && pc.signalingState === 'stable') await negotiate();
        } else if (candidate?.candidate) {
          if (!pc.remoteDescription) {
            peer.pendingCandidates.push(candidate);
            return;
          }
          try { await pc.addIceCandidate(candidate); } catch (err) {
            if (!peer.ignoreOffer) console.warn(err);
          }
        }
      });
    };

    addStreamTracks(pc, localStream);
    addStreamTracks(pc, screenStream);
    if (screenStream) {
      const level = peerQuality.get(remoteId) || outboundQuality;
      queueMicrotask(() => applyShareQuality(peer, level));
      setTimeout(() => applyShareQuality(peer, level), 800);
    }
    onConnection(remoteId, 'connecting');
    return peer;
  }

  function screenSender(peer) {
    const video = screenStream?.getVideoTracks().find((track) => track.readyState === 'live');
    if (!video) return null;
    return peer.pc.getSenders().find((sender) => sender.track === video) || null;
  }

  async function applyShareQuality(peer, level) {
    if (!peer || peer.closed) return;
    const preset = SHARE_PRESETS[level] || SHARE_PRESETS.medium;
    const sender = screenSender(peer);
    if (!sender?.getParameters) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = preset.maxBitrate;
    params.encodings[0].maxFramerate = preset.maxFramerate;
    params.encodings[0].scaleResolutionDownBy = preset.scaleResolutionDownBy;
    params.degradationPreference = preset.degradationPreference;
    try {
      await sender.setParameters(params);
    } catch (err) {
      console.warn(err);
    }
  }

  function pushOutboundQuality() {
    for (const [id, peer] of peers) {
      applyShareQuality(peer, peerQuality.get(id) || outboundQuality);
    }
  }

  function closePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    peer.closed = true;
    peer.pc.onnegotiationneeded = null;
    peer.pc.ontrack = null;
    try { peer.pc.close(); } catch (err) { console.warn(err); }
    peers.delete(id);
    peerQuality.delete(id);
  }

  return {
    setLocalStream(stream) { localStream = stream; },
    setMicTrack(track) {
      const previous = micTrack;
      micTrack = track || null;
      localStream = track ? new MediaStream([track]) : null;
      for (const peer of peers.values()) {
        if (peer.closed) continue;
        const sender = previous ? peer.pc.getSenders().find((item) => item.track === previous) : null;
        if (sender) sender.replaceTrack(track).catch((err) => console.warn(err));
        else if (track) addStreamTracks(peer.pc, localStream);
      }
    },
    setScreenStream(stream) { screenStream = stream; },
    setRoom(roomId) { activeRoomId = roomId; },
    setMediaReady(ready) { mediaReady = ready; },
    sync(ids) {
      if (!mediaReady || !activeRoomId || !window.RTCPeerConnection) return;
      const wanted = ids.filter((id) => id && id !== socket.id);
      for (const id of wanted) createPeer(id);
      for (const id of [...peers.keys()]) {
        if (!wanted.includes(id)) closePeer(id);
      }
    },
    handleSignal(message) {
      if (!message?.from || message.from === socket.id) return;
      if (!mediaReady || !activeRoomId) {
        signalQueue.push(message);
        return;
      }
      if (!peers.has(message.from)) createPeer(message.from);
      peers.get(message.from)?.handleSignal(message);
    },
    flushSignals() {
      const queued = signalQueue.splice(0);
      for (const message of queued) this.handleSignal(message);
    },
    publishScreen(stream) {
      screenStream = stream;
      for (const peer of peers.values()) {
        if (!peer.closed) addStreamTracks(peer.pc, stream);
      }
      pushOutboundQuality();
      setTimeout(pushOutboundQuality, 800);
    },
    setOutboundQuality(level) {
      if (!SHARE_PRESETS[level]) return;
      outboundQuality = level;
      peerQuality.clear();
      pushOutboundQuality();
    },
    setPeerShareQuality(remoteId, level) {
      if (!remoteId || !SHARE_PRESETS[level]) return;
      peerQuality.set(remoteId, level);
      const peer = peers.get(remoteId);
      if (peer) applyShareQuality(peer, level);
    },
    stopScreen(stream) {
      const tracks = stream?.getTracks() || [];
      screenStream = null;
      peerQuality.clear();
      for (const peer of peers.values()) {
        if (peer.closed) continue;
        for (const transceiver of peer.pc.getTransceivers()) {
          if (transceiver.sender?.track && tracks.includes(transceiver.sender.track)) {
            try { transceiver.stop(); } catch (err) { console.warn(err); }
          }
        }
      }
      tracks.forEach((track) => track.stop());
    },
    closeAll() {
      for (const id of [...peers.keys()]) closePeer(id);
      signalQueue.splice(0);
      peerQuality.clear();
    },
  };
}
