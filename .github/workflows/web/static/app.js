// web/static/app.js
// Frontend logic for SWS Web Console
// Responsibilities:
// - Upload .ss/.ust files to backend and request run
// - Stream console logs (SSE preferred, fallback to polling)
// - Download generated WAV and play it (robust to autoplay restrictions)
// - Display logs in console area and keep them scroll-locked

(() => {
  "use strict";

  // Configurable endpoints; adjust to backend routing if different.
  const API_RUN = "/api/run";         // POST: form-data file or JSON { filename, content } -> returns { session_id }
  const API_LOGS = "/api/logs";       // GET: ?session=ID -> SSE or ?session=ID&since=TIMESTAMP -> JSON [{time,msg}]
  const API_AUDIO = "/api/audio";     // GET: ?session=ID -> returns audio/wav blob
  const API_UPLOAD = "/api/upload";   // optional: POST file content; fallback to /api/run if not present

  // UI elements
  const fileInput = document.querySelector("#sws-file");
  const runButton = document.querySelector("#btn-run");
  const playButton = document.querySelector("#btn-play");
  const consoleEl = document.querySelector("#sws-console");
  const statusEl = document.querySelector("#sws-status");

  // State
  let currentSession = null;
  let eventSource = null;
  let pollTimer = null;
  let lastLogTime = 0;
  let audioBlobUrl = null;
  let lastLogs = [];

  function appendLog(text, kind = "info") {
    // Add a timestamped line and auto-scroll
    const time = new Date().toISOString();
    const line = `[${time}] ${text}`;
    lastLogs.push(line);
    // Keep last N logs in memory to avoid memory explosion
    if (lastLogs.length > 2000) lastLogs.splice(0, lastLogs.length - 2000);

    // Use a <pre> area; append with newline
    consoleEl.textContent += line + "\n";
    // keep scroll at bottom
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function enableUI(enabled) {
    if (runButton) runButton.disabled = !enabled;
    if (fileInput) fileInput.disabled = !enabled;
    if (!enabled) {
      setStatus("Running...");
    } else {
      setStatus("Idle");
    }
  }

  async function uploadAndRun() {
    if (!fileInput || fileInput.files.length === 0) {
      appendLog("No file selected", "error");
      return;
    }

    enableUI(false);
    appendLog("Preparing file upload...");

    const file = fileInput.files[0];
    const form = new FormData();
    form.append("file", file, file.name);

    try {
      // Try to call /api/run directly with file upload. Backend may accept or not.
      // Fallback strategies can be added if backend expects raw JSON.
      appendLog(`Uploading and requesting run for ${file.name}...`);
      const resp = await fetch(API_RUN, {
        method: "POST",
        body: form,
      });

      if (!resp.ok) {
        // Try /api/upload then /api/run by filename
        appendLog(`/api/run returned ${resp.status}. Trying /api/upload fallback...`, "warn");
        const upResp = await fetch(API_UPLOAD, {
          method: "POST",
          body: form,
        });
        if (!upResp.ok) {
          const txt = await upResp.text();
          appendLog(`/api/upload failed: ${upResp.status} ${txt}`, "error");
          enableUI(true);
          return;
        }
        const upJson = await upResp.json();
        // assume backend returns { filename }
        const runResp = await fetch(API_RUN, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: upJson.filename })
        });
        if (!runResp.ok) {
          appendLog(`/api/run failed after upload: ${runResp.status}`, "error");
          enableUI(true);
          return;
        }
        const runJson = await runResp.json();
        currentSession = runJson.session_id || runJson.session || runJson.id;
      } else {
        const data = await resp.json();
        currentSession = data.session_id || data.session || data.id;
      }

      if (!currentSession) {
        appendLog("Failed to obtain session id from server response.", "error");
        enableUI(true);
        return;
      }

      appendLog(`Session started: ${currentSession}`);

      // Start log streaming
      startLogStream(currentSession);

      // Also attempt to poll for audio when finished
      pollForAudioAndPlay(currentSession);

    } catch (err) {
      appendLog(`Upload / run error: ${err}`, "error");
      enableUI(true);
      stopLogStream();
    }
  }

  function startLogStream(session) {
    stopLogStream(); // ensure previous closed
    lastLogTime = 0;
    appendLog("Attempting to connect to server logs via SSE (EventSource)...");
    try {
      const sseUrl = `${API_LOGS}?session=${encodeURIComponent(session)}`;
      eventSource = new EventSource(sseUrl, { withCredentials: true });

      eventSource.onopen = () => {
        appendLog("Connected to SSE log stream.");
      };

      eventSource.onmessage = (ev) => {
        // The server may send plain text lines or JSON
        try {
          const data = ev.data;
          if (!data) return;
          // If server sends JSON with { time, msg }, try to parse
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (_) {
            // not JSON
          }
          if (parsed && parsed.msg) {
            appendLog(parsed.msg);
            if (parsed.time) {
              lastLogTime = Math.max(lastLogTime, parsed.time);
            }
          } else {
            appendLog(data);
          }
        } catch (e) {
          appendLog("Error parsing SSE message: " + e, "error");
        }
      };

      eventSource.onerror = (e) => {
        appendLog("SSE error or closed; switching to poll fallback.", "warn");
        // Close and fallback to polling
        stopLogStream();
        startPollingLogs(session);
      };
    } catch (e) {
      appendLog("EventSource construction failed, falling back to polling: " + e, "warn");
      startPollingLogs(session);
    }
  }

  function startPollingLogs(session) {
    stopLogStream(); // ensure none
    appendLog("Starting polling logs fallback every 1s...");
    pollTimer = setInterval(async () => {
      try {
        const url = `${API_LOGS}?session=${encodeURIComponent(session)}&since=${lastLogTime || 0}`;
        const r = await fetch(url, { method: "GET" });
        if (!r.ok) {
          // non-200 - log and continue
          appendLog(`Log poll returned ${r.status}`, "warn");
          return;
        }
        const j = await r.json(); // expect array [{time,msg}, ...] or { logs: [...] }
        let items = [];
        if (Array.isArray(j)) items = j;
        else if (Array.isArray(j.logs)) items = j.logs;
        else if (j.msg) items = [j];
        for (const it of items) {
          if (typeof it === "string") {
            appendLog(it);
          } else if (it.msg) {
            appendLog(it.msg);
            if (it.time) lastLogTime = Math.max(lastLogTime, it.time);
          } else {
            appendLog(JSON.stringify(it));
          }
        }
      } catch (e) {
        appendLog("Log poll error: " + e, "error");
      }
    }, 1000);
  }

  function stopLogStream() {
    if (eventSource) {
      try { eventSource.close(); } catch (_) {}
      eventSource = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollForAudioAndPlay(session) {
    // Poll server to check whether audio is ready; endpoint may return 204 while processing, 200 with blob once ready
    appendLog("Polling for generated audio...");
    const maxAttempts = 120; // e.g., up to 2 minutes
    let attempt = 0;
    while (attempt++ < maxAttempts) {
      try {
        const url = `${API_AUDIO}?session=${encodeURIComponent(session)}`;
        const resp = await fetch(url, { method: "GET" });
        if (!resp.ok) {
          // If backend returns 404/202/204 while working, wait
          if (resp.status === 202 || resp.status === 204) {
            await sleep(500);
            continue;
          }
          // If 404, maybe no audio requested; break.
          if (resp.status === 404) {
            appendLog("No audio produced for this session (server returned 404).", "warn");
            break;
          }
          appendLog(`Audio fetch returned ${resp.status}`, "warn");
          await sleep(500);
          continue;
        }

        // If we reach here: we have a response with body; assume audio blob
        const contentType = resp.headers.get("Content-Type") || "";
        const blob = await resp.blob();

        if (!blob || blob.size === 0) {
          appendLog("Received empty audio blob.", "warn");
          break;
        }

        appendLog(`Received audio (${blob.size} bytes, ${contentType}). Attempting to play...`);
        await playBlobAudio(blob);
        break;
      } catch (e) {
        appendLog("Error while downloading/playing audio: " + e, "error");
        await sleep(500);
      }
    }

    appendLog("Audio polling finished.");
    enableUI(true);
    stopLogStream();
  }

  async function playBlobAudio(blob) {
    try {
      if (audioBlobUrl) {
        try { URL.revokeObjectURL(audioBlobUrl); } catch (_) {}
        audioBlobUrl = null;
      }
      audioBlobUrl = URL.createObjectURL(blob);
      const audio = new Audio();
      audio.src = audioBlobUrl;
      audio.controls = true;
      audio.preload = "auto";
      audio.autoplay = false;

      // Add audio element to the page so user can control it
      const audioContainer = document.querySelector("#audio-container");
      if (audioContainer) {
        // clear previous
        audioContainer.innerHTML = "";
        audioContainer.appendChild(audio);
      }

      // Try to play immediately; if blocked, show a play button
      try {
        await audio.play();
        appendLog("Audio playback started.");
      } catch (err) {
        appendLog("Autoplay blocked by browser; showing manual play button.", "warn");
        // Show play button to user
        showManualPlay(audio);
      }
    } catch (e) {
      appendLog("Failed to play audio: " + e, "error");
    }
  }

  function showManualPlay(audio) {
    const audioContainer = document.querySelector("#audio-container");
    if (!audioContainer) return;
    // Remove existing controls and add manual play UI
    const btn = document.createElement("button");
    btn.textContent = "Play audio (click to allow)";
    btn.className = "manual-play";
    btn.onclick = async () => {
      try {
        await audio.play();
        appendLog("Manual audio playback started.");
        btn.remove();
      } catch (e) {
        appendLog("Manual play failed: " + e, "error");
      }
    };
    audioContainer.appendChild(btn);
  }

  function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }

  // Wire UI
  function attachHandlers() {
    if (runButton) {
      runButton.addEventListener("click", (ev) => {
        ev.preventDefault();
        // Clear console optionally
        // consoleEl.textContent = "";
        uploadAndRun();
      });
    }

    if (playButton) {
      playButton.addEventListener("click", (ev) => {
        ev.preventDefault();
        // If audio element exists and is paused, play; else attempt to download latest audio again
        const audioEl = document.querySelector("#audio-container audio");
        if (audioEl) {
          audioEl.play().then(() => appendLog("Playback started via Play button.")).catch((e) => appendLog("Play error: " + e, "error"));
        } else if (currentSession) {
          pollForAudioAndPlay(currentSession);
        } else {
          appendLog("No session/audio available to play.", "warn");
        }
      });
    }
  }

  function setupElements() {
    // Ensure console element is present and visible
    if (!consoleEl) {
      console.error("Console element (#sws-console) not found in DOM");
      return;
    }
    // initialize status
    if (statusEl) statusEl.textContent = "Idle";
  }

  // Initialize on DOM ready
  document.addEventListener("DOMContentLoaded", () => {
    setupElements();
    attachHandlers();
    appendLog("SWS Web Console connected.");
  });

})();
