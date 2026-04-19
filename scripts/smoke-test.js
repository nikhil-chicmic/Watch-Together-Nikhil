const { spawn } = require("child_process");

const port = 3456;
const baseUrl = `http://localhost:${port}`;
const server = spawn(process.execPath, ["server.js"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
server.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

async function waitForHealth() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Server did not become healthy. Output: ${output}`);
}

async function main() {
  await waitForHealth();

  const page = await fetch(baseUrl);
  assert(page.status === 200, "Homepage should return 200");

  const created = await fetch(`${baseUrl}/api/rooms`, { method: "POST" }).then((response) => response.json());
  assert(/^[A-Z0-9]{6}$/.test(created.roomCode), "Room code should be 6 uppercase characters");

  const room = await fetch(`${baseUrl}/api/rooms/${created.roomCode}`).then((response) => response.json());
  assert(room.roomCode === created.roomCode, "Created room should be joinable");

  await assertWebSocketSync(created.roomCode);
  await assertVideoLoad("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ");
  await assertVideoLoad("https://youtu.be/dQw4w9WgXcQ?si=test", "dQw4w9WgXcQ");
  await assertVideoLoad("www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ");
  await assertVideoLoad("https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ");
  console.log("Smoke test passed.");
}

function assertWebSocketSync(roomCode) {
  return new Promise((resolve, reject) => {
    const a = new WebSocket(`ws://localhost:${port}/ws?room=${roomCode}`);
    const b = new WebSocket(`ws://localhost:${port}/ws?room=${roomCode}`);
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for control sync")), 4000);

    b.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "control") {
        clearTimeout(timeout);
        a.close();
        b.close();
        assert(message.state.status === "playing", "Control message should broadcast playing state");
        assert(Math.round(message.state.position) === 12, "Control message should preserve playback position");
        resolve();
      }
    };

    a.onopen = () => {
      setTimeout(() => {
        a.send(
          JSON.stringify({
            type: "control",
            actionId: "smoke-action",
            payload: { action: "play", position: 12 }
          })
        );
      }, 200);
    };

    a.onerror = reject;
    b.onerror = reject;
  });
}

async function assertVideoLoad(videoUrl, expectedVideoId) {
  const created = await fetch(`${baseUrl}/api/rooms`, { method: "POST" }).then((response) => response.json());
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${port}/ws?room=${created.roomCode}`);
    const timeout = setTimeout(() => reject(new Error(`Timed out loading ${videoUrl}`)), 4000);

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "error") {
        clearTimeout(timeout);
        socket.close();
        reject(new Error(`${videoUrl} was rejected: ${message.message}`));
      }

      if (message.type === "control") {
        clearTimeout(timeout);
        socket.close();
        assert(message.state.videoId === expectedVideoId, `${videoUrl} should extract ${expectedVideoId}`);
        assert(message.state.status === "paused", "Loaded videos should start paused");
        resolve();
      }
    };

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "control",
          actionId: `load-${expectedVideoId}`,
          payload: { action: "load", videoUrl }
        })
      );
    };

    socket.onerror = reject;
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill();
  });
