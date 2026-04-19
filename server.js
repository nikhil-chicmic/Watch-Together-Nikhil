const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 6 * 60 * 60 * 1000);
const rooms = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function createDefaultState() {
  return {
    videoId: "",
    videoUrl: "",
    status: "paused",
    position: 0,
    updatedAt: Date.now(),
    lastActionId: "",
    hostId: ""
  };
}

function roomSnapshot(room) {
  return {
    type: "room-state",
    roomCode: room.code,
    viewers: room.clients.size,
    state: currentState(room)
  };
}

function currentState(room) {
  const state = { ...room.state };
  if (state.status === "playing") {
    state.position += (Date.now() - state.updatedAt) / 1000;
    state.updatedAt = Date.now();
  }
  return state;
}

function updateRoom(room, patch) {
  room.state = {
    ...room.state,
    ...patch,
    updatedAt: Date.now()
  };
}

function broadcast(room, payload, exceptClientId) {
  const encoded = encodeFrame(JSON.stringify(payload));
  for (const client of room.clients.values()) {
    if (client.id !== exceptClientId && client.socket.writable) {
      client.socket.write(encoded);
    }
  }
}

function sendJson(socket, payload) {
  if (socket.writable) {
    socket.write(encodeFrame(JSON.stringify(payload)));
  }
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(content);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, {
      ok: true,
      rooms: rooms.size,
      uptime: Math.round(process.uptime())
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const code = createRoomCode();
    const room = {
      code,
      createdAt: Date.now(),
      clients: new Map(),
      state: createDefaultState()
    };
    rooms.set(code, room);
    json(res, 201, { roomCode: code });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/rooms/")) {
    const code = url.pathname.split("/").pop().toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      json(res, 404, { error: "Room not found" });
      return;
    }
    json(res, 200, { roomCode: code, viewers: room.clients.size, state: currentState(room) });
    return;
  }

  json(res, 404, { error: "API route not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: error.message || "Internal server error" });
  }
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const roomCode = (url.searchParams.get("room") || "").toUpperCase();
  const room = rooms.get(roomCode);
  const key = req.headers["sec-websocket-key"];
  if (!room || !key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const clientId = crypto.randomUUID();
  room.clients.set(clientId, { id: clientId, socket, buffer: Buffer.alloc(0) });
  if (!room.state.hostId) {
    room.state.hostId = clientId;
  }

  sendJson(socket, { type: "connected", clientId, isHost: room.state.hostId === clientId });
  sendJson(socket, roomSnapshot(room));
  broadcast(room, { type: "presence", viewers: room.clients.size }, clientId);

  socket.on("data", (buffer) => {
    const client = room.clients.get(clientId);
    if (!client) return;
    client.buffer = Buffer.concat([client.buffer, buffer]);
    const result = decodeFrames(client.buffer);
    client.buffer = result.remaining;
    const messages = result.messages;
    for (const message of messages) {
      handleWsMessage(room, clientId, socket, message);
    }
  });

  socket.on("close", () => removeClient(room, clientId));
  socket.on("end", () => removeClient(room, clientId));
  socket.on("error", () => removeClient(room, clientId));
});

function removeClient(room, clientId) {
  if (!room.clients.has(clientId)) return;
  room.clients.delete(clientId);

  if (room.state.hostId === clientId) {
    const nextClient = room.clients.keys().next();
    room.state.hostId = nextClient.done ? "" : nextClient.value;
    if (!nextClient.done) {
      sendJson(room.clients.get(nextClient.value).socket, {
        type: "role",
        isHost: true
      });
    }
  }

  if (room.clients.size === 0 && Date.now() - room.createdAt > 5 * 60 * 1000) {
    rooms.delete(room.code);
    return;
  }

  broadcast(room, { type: "presence", viewers: room.clients.size });
}

function handleWsMessage(room, clientId, socket, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    sendJson(socket, { type: "error", message: "Invalid message" });
    return;
  }

  if (message.type === "ping") {
    sendJson(socket, { type: "pong", serverTime: Date.now() });
    return;
  }

  if (message.type === "sync-request") {
    sendJson(socket, roomSnapshot(room));
    return;
  }

  if (message.type !== "control") return;

  const patch = sanitizeControl(message.payload);
  if (patch && patch.error) {
    sendJson(socket, { type: "error", message: patch.error });
    return;
  }

  if (!patch) {
    sendJson(socket, { type: "error", message: "That playback action is not supported." });
    return;
  }

  updateRoom(room, {
    ...patch,
    lastActionId: message.actionId || crypto.randomUUID()
  });

  const payload = {
    type: "control",
    by: clientId,
    actionId: room.state.lastActionId,
    state: currentState(room),
    sentAt: Date.now()
  };

  sendJson(socket, payload);
  broadcast(room, payload, clientId);
}

function sanitizeControl(payload = {}) {
  const position = Number.isFinite(payload.position) ? Math.max(0, payload.position) : undefined;

  if (payload.action === "load") {
    const videoId = extractYouTubeId(String(payload.videoUrl || ""));
    if (!videoId) {
      return { error: "Paste a valid YouTube link or 11-character video ID." };
    }
    return {
      videoId,
      videoUrl: String(payload.videoUrl),
      status: "paused",
      position: 0
    };
  }

  if (payload.action === "play") {
    return {
      status: "playing",
      position: position ?? 0
    };
  }

  if (payload.action === "pause") {
    return {
      status: "paused",
      position: position ?? 0
    };
  }

  if (payload.action === "seek") {
    return {
      status: payload.status === "playing" ? "playing" : "paused",
      position: position ?? 0
    };
  }

  return null;
}

function extractYouTubeId(input) {
  let trimmed = input.trim().replace(/^<|>$/g, "").replace(/&amp;/g, "&");
  if (!trimmed) return "";

  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

  if (/^(www\.youtube\.com|youtube\.com|m\.youtube\.com|youtu\.be)\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }

  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathParts = url.pathname.split("/").filter(Boolean);

    if (hostname === "youtu.be") {
      return validYouTubeId(pathParts[0]);
    }

    if (hostname.endsWith("youtube.com")) {
      const queryId = validYouTubeId(url.searchParams.get("v"));
      if (queryId) return queryId;

      const typedPath = ["embed", "shorts", "live", "v"].find((segment) => pathParts[0] === segment);
      if (typedPath) return validYouTubeId(pathParts[1]);
    }
  } catch {
    const fallback = trimmed.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/|\/v\/)([a-zA-Z0-9_-]{11})/);
    if (fallback) return fallback[1];
  }

  const broadFallback = trimmed.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (broadFallback) return broadFallback[1];

  return "";
}

function validYouTubeId(value) {
  return /^[a-zA-Z0-9_-]{11}$/.test(value || "") ? value : "";
}

function encodeFrame(text) {
  const payload = Buffer.from(text);
  const length = payload.length;

  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), payload]);
  }

  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const frameStart = offset;
    const firstByte = buffer[offset++];
    const secondByte = buffer[offset++];
    const opcode = firstByte & 0x0f;
    const isMasked = Boolean(secondByte & 0x80);
    let length = secondByte & 0x7f;

    if (length === 126) {
      if (offset + 2 > buffer.length) return { messages, remaining: buffer.slice(frameStart) };
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > buffer.length) return { messages, remaining: buffer.slice(frameStart) };
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    let mask;
    if (isMasked) {
      if (offset + 4 > buffer.length) return { messages, remaining: buffer.slice(frameStart) };
      mask = buffer.slice(offset, offset + 4);
      offset += 4;
    }

    if (offset + length > buffer.length) return { messages, remaining: buffer.slice(frameStart) };
    const payload = buffer.slice(offset, offset + length);
    offset += length;

    if (opcode === 0x8) break;
    if (opcode !== 0x1) continue;

    if (isMasked) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    messages.push(payload.toString("utf8"));
  }

  return { messages, remaining: buffer.slice(offset) };
}

server.listen(PORT, () => {
  console.log(`WatchTogether is running at http://localhost:${PORT}`);
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && now - room.createdAt > ROOM_TTL_MS) {
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
