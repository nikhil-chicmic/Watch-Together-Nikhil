const { useEffect, useMemo, useRef, useState } = React;
const h = React.createElement;

const playerStates = {
  [-1]: "Idle",
  0: "Ended",
  1: "Playing",
  2: "Paused",
  3: "Buffering",
  5: "Ready"
};

const emptyRoomState = {
  videoId: "",
  videoUrl: "",
  status: "paused",
  position: 0,
  updatedAt: Date.now()
};

function isVercelHost() {
  return window.location.hostname.endsWith(".vercel.app");
}

function App() {
  const urlRoom = (new URLSearchParams(window.location.search).get("room") || "").toUpperCase();
  const [roomCode, setRoomCode] = useState("");
  const [joinCode, setJoinCode] = useState(urlRoom);
  const [clientId, setClientId] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [viewers, setViewers] = useState(0);
  const [notice, setNotice] = useState(urlRoom ? "Checking invite link..." : "Create or join a room to begin.");
  const [noticeTone, setNoticeTone] = useState("neutral");
  const [videoUrl, setVideoUrl] = useState("");
  const [playerReady, setPlayerReady] = useState(false);
  const [playerState, setPlayerState] = useState("Loading");
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [pendingUnlock, setPendingUnlock] = useState(null);
  const [roomState, setRoomState] = useState(emptyRoomState);

  const socketRef = useRef(null);
  const playerRef = useRef(null);
  const suppressPlayerEventsRef = useRef(false);
  const lastActionRef = useRef("");
  const roomStateRef = useRef(emptyRoomState);

  const hasRoom = Boolean(roomCode);
  const hasVideo = Boolean(roomState.videoId);

  const shareUrl = useMemo(() => {
    if (!roomCode) return "";
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomCode);
    return url.toString();
  }, [roomCode]);

  useEffect(() => {
    window.onYouTubeIframeAPIReady = () => setPlayerReady(true);
    if (window.YT && window.YT.Player) setPlayerReady(true);
  }, []);

  useEffect(() => {
    roomStateRef.current = roomState;
  }, [roomState]);

  useEffect(() => {
    if (!urlRoom) return;
    joinRoomByCode(urlRoom, true);
  }, []);

  useEffect(() => {
    if (!playerReady || playerRef.current) return;

    playerRef.current = new YT.Player("player", {
      width: "100%",
      height: "100%",
      playerVars: {
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        origin: window.location.origin
      },
      events: {
        onReady: () => setPlayerState("Ready"),
        onError: () => showNotice("This video cannot be embedded or played here. Try another YouTube link.", "error"),
        onStateChange: (event) => {
          setPlayerState(playerStates[event.data] || "Idle");
          if (event.data === YT.PlayerState.PLAYING) {
            setPendingUnlock(null);
          }
          if (suppressPlayerEventsRef.current || !socketRef.current || !roomCode) return;

          const current = getCurrentTime();
          if (event.data === YT.PlayerState.PLAYING) sendControl("play", { position: current });
          if (event.data === YT.PlayerState.PAUSED) sendControl("pause", { position: current });
        }
      }
    });
  }, [playerReady, roomCode]);

  useEffect(() => {
    if (!roomCode) return undefined;

    setConnecting(true);
    setConnected(false);
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws?room=${roomCode}`);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setConnecting(false);
      setConnected(true);
      showNotice("Room is live. Playback controls are shared.", "success");
    });

    socket.addEventListener("close", () => {
      setConnecting(false);
      setConnected(false);
      if (socketRef.current === socket) {
        showNotice(
          isVercelHost()
            ? "Vercel cannot host this WebSocket sync server. Deploy this project on Render, Railway, Fly.io, or another Node server host."
            : "Sync connection closed. Refresh or rejoin if controls stop updating.",
          "error"
        );
      }
    });

    socket.addEventListener("error", () => {
      setConnecting(false);
      showNotice(
        isVercelHost()
          ? "Vercel deployments do not support the persistent WebSocket server required for room sync."
          : "Could not open the sync channel for this room.",
        "error"
      );
    });

    socket.addEventListener("message", (event) => {
      try {
        handleSocketMessage(JSON.parse(event.data));
      } catch {
        showNotice("Received an unreadable sync message.", "error");
      }
    });

    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, [roomCode]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const player = playerRef.current;
      if (!player || typeof player.getCurrentTime !== "function") return;
      setPosition(player.getCurrentTime() || 0);
      setDuration(player.getDuration() || 0);
    }, 400);
    return () => window.clearInterval(timer);
  }, []);

  function showNotice(message, tone = "neutral") {
    setNotice(message);
    setNoticeTone(tone);
  }

  function handleSocketMessage(message) {
    if (message.type === "connected") {
      setClientId(message.clientId);
      setIsHost(message.isHost);
      return;
    }

    if (message.type === "role") {
      setIsHost(message.isHost);
      return;
    }

    if (message.type === "presence") {
      setViewers(message.viewers);
      return;
    }

    if (message.type === "error") {
      showNotice(message.message || "Sync server rejected that action.", "error");
      return;
    }

    if (message.type === "room-state") {
      setViewers(message.viewers);
      applyRemoteState(message.state, true);
      return;
    }

    if (message.type === "control") {
      applyRemoteState(message.state, false, message.by === clientId);
    }
  }

  async function createRoom() {
    showNotice("Creating room...", "neutral");
    try {
      const response = await fetch("/api/rooms", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to create room.");

      setRoomCode(payload.roomCode);
      setJoinCode(payload.roomCode);
      window.history.replaceState(null, "", `?room=${payload.roomCode}`);
      showNotice("Room created. Share the key or invite link.", "success");
    } catch (error) {
      showNotice(error.message || "Unable to create room.", "error");
    }
  }

  async function joinRoom(event) {
    event.preventDefault();
    await joinRoomByCode(joinCode);
  }

  async function joinRoomByCode(rawCode, fromInvite = false) {
    const code = rawCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      showNotice("Enter the 6-character room key.", "error");
      return;
    }

    showNotice(fromInvite ? "Opening invite..." : "Joining room...", "neutral");
    try {
      const response = await fetch(`/api/rooms/${code}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Room not found.");

      setRoomCode(code);
      setJoinCode(code);
      window.history.replaceState(null, "", `?room=${code}`);
      showNotice("Joined room. You can control playback from this screen.", "success");
    } catch (error) {
      setRoomCode("");
      window.history.replaceState(null, "", window.location.pathname);
      showNotice(error.message || "That room key was not found.", "error");
    }
  }

  function leaveRoom() {
    setRoomCode("");
    setConnected(false);
    setViewers(0);
    setIsHost(false);
    setClientId("");
    setRoomState(emptyRoomState);
    setPosition(0);
    window.history.replaceState(null, "", window.location.pathname);
    if (playerRef.current?.stopVideo) playerRef.current.stopVideo();
    showNotice("Left room.", "neutral");
  }

  function loadVideo(event) {
    event.preventDefault();
    if (!videoUrl.trim()) {
      showNotice("Paste a YouTube link first.", "error");
      return;
    }
    sendControl("load", { videoUrl: videoUrl.trim() });
  }

  function sendControl(action, payload = {}) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      showNotice("Join a room before controlling playback.", "error");
      return;
    }

    const actionId = newActionId();
    lastActionRef.current = actionId;
    socket.send(JSON.stringify({ type: "control", actionId, payload: { action, ...payload } }));
  }

  function applyRemoteState(state, immediate, fromLocal = false) {
    setRoomState(state);
    if (state.videoUrl) setVideoUrl(state.videoUrl);

    const player = playerRef.current;
    if (!player || typeof player.loadVideoById !== "function") return;

    const targetPosition =
      state.status === "playing" ? state.position + (Date.now() - state.updatedAt) / 1000 : state.position;

    suppressPlayerEventsRef.current = true;
    const previousVideoId = roomStateRef.current.videoId;

    if (state.videoId && previousVideoId !== state.videoId) {
      if (state.status === "playing") {
        player.loadVideoById(state.videoId, targetPosition);
      } else {
        player.cueVideoById(state.videoId, targetPosition);
      }
      if (state.status === "paused") {
        window.setTimeout(() => player.pauseVideo(), 150);
      }
    } else if (state.videoId) {
      const current = player.getCurrentTime?.() || 0;
      const drift = Math.abs(current - targetPosition);
      if (immediate || drift > 0.55) player.seekTo(targetPosition, true);
      if (state.status === "playing" && player.getPlayerState?.() !== YT.PlayerState.PLAYING) {
        player.playVideo();
      }
      if (state.status === "paused" && player.getPlayerState?.() !== YT.PlayerState.PAUSED) player.pauseVideo();
    }

    if (state.status === "playing") {
      window.setTimeout(() => {
        const playerStateCode = player.getPlayerState?.();
        if (playerStateCode !== YT.PlayerState.PLAYING && roomStateRef.current.status === "playing") {
          setPendingUnlock({
            videoId: state.videoId,
            position: targetPosition,
            fromLocal
          });
          if (!fromLocal) {
            showNotice("Your device needs one tap to start synced playback.", "neutral");
          }
        }
      }, fromLocal ? 350 : 900);
    } else {
      setPendingUnlock(null);
    }

    window.setTimeout(() => {
      suppressPlayerEventsRef.current = false;
    }, 500);
  }

  function getCurrentTime() {
    const player = playerRef.current;
    if (!player || typeof player.getCurrentTime !== "function") return 0;
    return player.getCurrentTime() || 0;
  }

  function playPause() {
    const player = playerRef.current;
    const current = getCurrentTime();
    const state = player?.getPlayerState?.();
    if (state === YT.PlayerState.PLAYING) {
      applyLocalPause(current);
      sendControl("pause", { position: current });
    } else {
      applyLocalPlay(current);
      sendControl("play", { position: current });
    }
  }

  function seekBy(seconds) {
    const next = Math.max(0, getCurrentTime() + seconds);
    const isPlaying = playerRef.current?.getPlayerState?.() === YT.PlayerState.PLAYING;
    applyLocalSeek(next, isPlaying);
    sendControl("seek", { position: next, status: isPlaying ? "playing" : "paused" });
  }

  function scrub(event) {
    const next = Number(event.target.value);
    const isPlaying = playerRef.current?.getPlayerState?.() === YT.PlayerState.PLAYING;
    applyLocalSeek(next, isPlaying);
    sendControl("seek", { position: next, status: isPlaying ? "playing" : "paused" });
  }

  function applyLocalPlay(targetPosition) {
    const player = playerRef.current;
    if (!player || !hasVideo) return;
    suppressPlayerEventsRef.current = true;
    player.seekTo(targetPosition, true);
    player.playVideo();
    setPendingUnlock(null);
    setPlayerState("Playing");
    window.setTimeout(() => {
      suppressPlayerEventsRef.current = false;
    }, 500);
  }

  function applyLocalPause(targetPosition) {
    const player = playerRef.current;
    if (!player || !hasVideo) return;
    suppressPlayerEventsRef.current = true;
    player.seekTo(targetPosition, true);
    player.pauseVideo();
    setPendingUnlock(null);
    setPlayerState("Paused");
    window.setTimeout(() => {
      suppressPlayerEventsRef.current = false;
    }, 500);
  }

  function applyLocalSeek(targetPosition, shouldKeepPlaying) {
    const player = playerRef.current;
    if (!player || !hasVideo) return;
    suppressPlayerEventsRef.current = true;
    player.seekTo(targetPosition, true);
    if (shouldKeepPlaying) {
      player.playVideo();
    }
    setPosition(targetPosition);
    window.setTimeout(() => {
      suppressPlayerEventsRef.current = false;
    }, 500);
  }

  function unlockSyncedPlayback() {
    const state = roomStateRef.current;
    if (!state.videoId) return;
    const targetPosition =
      state.status === "playing" ? state.position + (Date.now() - state.updatedAt) / 1000 : state.position;

    suppressPlayerEventsRef.current = true;
    const player = playerRef.current;
    if (player) {
      if (player.getVideoData?.().video_id !== state.videoId) {
        player.loadVideoById(state.videoId, targetPosition);
      } else {
        player.seekTo(targetPosition, true);
      }
      player.playVideo();
    }
    setPendingUnlock(null);
    setPlayerState("Playing");
    sendControl("play", { position: targetPosition });
    window.setTimeout(() => {
      suppressPlayerEventsRef.current = false;
    }, 500);
  }

  async function copy(text, label) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showNotice(`${label} copied.`, "success");
    } catch {
      showNotice("Copy failed. Select the text and copy it manually.", "error");
    }
  }

  return h(
    "main",
    { className: "app" },
    h(
      "header",
      { className: "topbar" },
      h("div", { className: "brand" }, h("div", { className: "brand-mark", "aria-hidden": "true" }, "WT"), h("span", null, "WatchTogether")),
      h("div", { className: "topbar-meta" },
        h("span", { className: `pill ${connected ? "pill-live" : connecting ? "pill-wait" : ""}` }, connected ? "Live sync" : connecting ? "Connecting" : "Offline"),
        h("span", { className: "viewer-count" }, `${viewers} viewer${viewers === 1 ? "" : "s"}`)
      )
    ),
    h(
      "section",
      { className: "workspace" },
      h(
        "section",
        { className: "watch-area" },
        h(
          "div",
          { className: "player-shell" },
          h("div", { id: "player" }),
          !hasVideo &&
            h(
              "div",
              { className: "empty-player" },
              h("div", { className: "play-badge" }, "SYNC"),
              h("h1", null, "Watch in the same moment."),
              h("p", null, "Create a room, invite a friend, and load a YouTube video.")
            ),
          pendingUnlock &&
            h(
              "div",
              { className: "play-unlock" },
              h("div", null,
                h("strong", null, "Tap to start synced playback"),
                h("span", null, "Mobile browsers need one tap before video can play.")
              ),
              h("button", { className: "primary-button", onClick: unlockSyncedPlayback }, "Start synced video")
            )
        ),
        h(
          "div",
          { className: "transport" },
          h("button", { className: "icon-button", title: "Back 10 seconds", onClick: () => seekBy(-10), disabled: !hasRoom || !hasVideo }, "-10"),
          h("button", { className: "play-button", onClick: playPause, disabled: !hasRoom || !hasVideo }, playerState === "Playing" ? "Pause" : "Play"),
          h(
            "div",
            { className: "timeline" },
            h("span", null, formatTime(position)),
            h("input", {
              type: "range",
              min: "0",
              max: Math.max(1, Math.floor(duration)),
              value: Math.min(Math.floor(position), Math.floor(duration || 0)),
              onChange: scrub,
              disabled: !hasRoom || !hasVideo,
              "aria-label": "Playback position"
            }),
            h("span", null, formatTime(duration))
          ),
          h("button", { className: "icon-button", title: "Forward 10 seconds", onClick: () => seekBy(10), disabled: !hasRoom || !hasVideo }, "+10")
        )
      ),
      h(
        "aside",
        { className: "control-panel" },
        h(
          "section",
          { className: "panel hero-panel" },
          h("p", { className: "eyebrow" }, "Free watch party system"),
          h("h2", null, "Shared rooms. Shared controls. No paid backend."),
          h("div", { className: `notice notice-${noticeTone}`, role: "status" }, notice)
        ),
        h(
          "section",
          { className: "panel" },
          h("div", { className: "section-title" }, h("span", null, "1"), h("h3", null, "Room")),
          hasRoom
            ? h(
                "div",
                { className: "room-card" },
                h("div", { className: "room-code" }, h("strong", null, roomCode), h("button", { className: "ghost-button", onClick: () => copy(roomCode, "Room key") }, "Copy")),
                h("div", { className: "copy-row" },
                  h("input", { className: "field", value: shareUrl, readOnly: true, "aria-label": "Invite link" }),
                  h("button", { className: "ghost-button", onClick: () => copy(shareUrl, "Invite link") }, "Copy link")
                ),
                h("button", { className: "quiet-button", onClick: leaveRoom }, "Leave room")
              )
            : h(
                "div",
                { className: "room-actions" },
                h("button", { className: "primary-button", onClick: createRoom }, "Create room"),
                h("form", { className: "join-form", onSubmit: joinRoom },
                  h("input", {
                    className: "field",
                    placeholder: "Room key",
                    value: joinCode,
                    onChange: (event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "")),
                    maxLength: 6,
                    "aria-label": "Room key"
                  }),
                  h("button", { className: "secondary-button" }, "Join")
                )
              )
        ),
        h(
          "section",
          { className: "panel" },
          h("div", { className: "section-title" }, h("span", null, "2"), h("h3", null, "Video")),
          h("form", { className: "url-form", onSubmit: loadVideo },
            h("input", {
              className: "field",
              placeholder: "YouTube URL or video ID",
              value: videoUrl,
              onChange: (event) => setVideoUrl(event.target.value),
              "aria-label": "YouTube URL"
            }),
            h("button", { className: "primary-button", disabled: !hasRoom }, "Load video")
          )
        ),
        h(
          "section",
          { className: "status-strip" },
          h("div", { className: "stat" }, h("span", null, "Role"), h("strong", null, isHost ? "Host" : hasRoom ? "Participant" : "None")),
          h("div", { className: "stat" }, h("span", null, "Player"), h("strong", null, playerState)),
          h("div", { className: "stat" }, h("span", null, "Sync"), h("strong", null, connected ? "Active" : "Inactive"))
        )
      )
    )
  );
}

function newActionId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = String(safe % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App));
