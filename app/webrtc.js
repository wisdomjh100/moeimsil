const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export function createRtcSession({ socket, onTrack, onConnection }) {
  const peers = new Map();
  const signalQueue = [];
  let localStream = null;
  let screenStream = null;
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
    onConnection(remoteId, 'connecting');
    return peer;
  }

  function closePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    peer.closed = true;
    peer.pc.onnegotiationneeded = null;
    peer.pc.ontrack = null;
    try { peer.pc.close(); } catch (err) { console.warn(err); }
    peers.delete(id);
  }

  return {
    setLocalStream(stream) { localStream = stream; },
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
    },
    stopScreen(stream) {
      const tracks = stream?.getTracks() || [];
      screenStream = null;
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
    },
  };
}
