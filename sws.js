/**
 * SWS Web Console - Class-by-Class Playback (full implementation)
 *
 * - AudioContext created on user gesture (Play) and resumed if suspended.
 * - Scheduling uses AudioContext.currentTime so it works when tab is inactive.
 * - Playback state is tracked per class (tracks), allowing multiple classes to
 *   show independent current lines and multiple simultaneous events.
 * - -cnt- support: next event after -cnt- starts at the same beat (same start time).
 * - UI: class list shows ▶ and "line x, y" per class; editor highlights can show multiple lines.
 * - Robust console logging with DOM fallback.
 */

class SWSWebConsole {
  constructor() {
    this.currentCode = "";
    this.currentFile = null;

    // playback / track state
    this.playbackState = {
      playing: false,
      startEpochMs: 0, // Date.now when playback started (for UI fallback if needed)
      tracks: {}, // populated with class names -> { activeEvents: Set(eventId), currentLines: Set(lineNumber) }
    };

    this.audioContext = null;
    this.scheduledTimers = []; // setTimeout ids for UI state updates and auto-stop
    this.scheduledNodes = []; // for optional future stopping of nodes (not strictly needed if scheduled)
    this.eventIdCounter = 1;

    // UI elements
    this.elements = {};
    this.initializeUI();
    this.setupEventListeners();
    this.loadInitialCode();
  }

  initializeUI() {
    this.elements.openBtn = document.getElementById("openBtn");
    this.elements.saveBtn = document.getElementById("saveBtn");
    this.elements.playBtn = document.getElementById("playBtn");
    this.elements.stopBtn = document.getElementById("stopBtn");
    this.elements.fileInput = document.getElementById("fileInput");
    this.elements.codeEditor = document.getElementById("codeEditor");
    this.elements.highlightOverlay = document.getElementById("highlightOverlay");
    this.elements.lineNumbers = document.getElementById("lineNumbers");
    this.elements.classList = document.getElementById("classList");
    this.elements.consoleOutput = document.getElementById("consoleOutput");
  }

  setupEventListeners() {
    if (this.elements.openBtn) this.elements.openBtn.addEventListener("click", () => this.handleOpen());
    if (this.elements.saveBtn) this.elements.saveBtn.addEventListener("click", () => this.handleSave());
    if (this.elements.playBtn) this.elements.playBtn.addEventListener("click", () => this.handlePlay());
    if (this.elements.stopBtn) this.elements.stopBtn.addEventListener("click", () => this.handleStop());
    if (this.elements.fileInput) this.elements.fileInput.addEventListener("change", (e) => this.handleFileSelect(e));
    if (this.elements.codeEditor) {
      this.elements.codeEditor.addEventListener("input", () => this.handleCodeChange());
      this.elements.codeEditor.addEventListener("scroll", () => this.syncScroll());
    }
  }

  loadInitialCode() {
    const initialCode = `tempoconst="120";
key="C";

snd("piano",4,C4,class="melody");
snd("piano",4,E4,class="melody");

snd("bass",4,C2,class="bass");
snd("bass",4,G2,class="bass");

snd("piano",4,G4);`;

    this.currentCode = initialCode;
    if (this.elements.codeEditor) this.elements.codeEditor.value = this.currentCode;
    this.handleCodeChange();
    this.consoleLog("Ready.", "info");
  }

  handleOpen() {
    if (this.elements.fileInput) this.elements.fileInput.click();
  }

  handleFileSelect(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      this.currentCode = e.target.result;
      this.currentFile = file.name;
      if (this.elements.codeEditor) this.elements.codeEditor.value = this.currentCode;
      this.handleCodeChange();
      this.consoleLog(`Loaded: ${file.name}`, "success");
    };
    reader.onerror = () => this.consoleLog("Failed to read file", "error");
    reader.readAsText(file);
  }

  handleSave() {
    const code = (this.elements.codeEditor && this.elements.codeEditor.value) || this.currentCode;
    const filename = this.currentFile || "untitled.ss";
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.consoleLog(`Saved: ${filename}`, "success");
  }

  async handlePlay() {
    try {
      this.currentCode = (this.elements.codeEditor && this.elements.codeEditor.value) || this.currentCode;
      if (!this.currentCode || !this.currentCode.trim()) {
        this.consoleLog("No code to play", "warning");
        return;
      }

      // Ensure AudioContext exists and is resumed on user gesture.
      if (!this.audioContext) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) {
          this.consoleLog("Web Audio API not supported in this browser", "error");
          return;
        }
        this.audioContext = new AC();
      }
      if (this.audioContext.state === "suspended") {
        try {
          await this.audioContext.resume();
        } catch (e) {
          // ignore
        }
      }

      // Prepare playback state
      this.clearAllScheduled();
      this.playbackState = { playing: true, startEpochMs: Date.now(), tracks: {} };
      this.eventIdCounter = 1;

      // UI button states
      if (this.elements.playBtn) this.elements.playBtn.disabled = true;
      if (this.elements.stopBtn) this.elements.stopBtn.disabled = false;
      this.consoleLog("Playing...", "info");

      // Parse and schedule
      const events = this.parseCodeToEvents(this.currentCode);
      if (!events.length) {
        this.consoleLog("No events found", "warning");
        this.handleStop();
        return;
      }
      this.consoleLog(`Found ${events.length} events`, "info");

      // schedule
      const now = this.audioContext.currentTime;
      const startOffset = 0.05; // seconds
      const baseTime = now + startOffset;

      events.forEach((ev) => {
        // ensure track exists
        const cls = ev.className || "main";
        if (!this.playbackState.tracks[cls]) {
          this.playbackState.tracks[cls] = { activeEvents: new Set(), currentLines: new Set() };
        }

        // schedule audio
        const audioStart = baseTime + ev.start;
        const audioEnd = audioStart + ev.duration;

        // create oscillator + gain
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        osc.type = this.getOscillatorType(ev.instrument);
        const midi = this.noteToMidi(ev.pitch || "C4");
        const freq = this.midiToFrequency(midi);
        osc.frequency.setValueAtTime(freq, audioStart);
        // envelope
        const attack = Math.min(0.02, ev.duration * 0.15);
        const release = Math.min(0.1, ev.duration * 0.25);
        gain.gain.setValueAtTime(0.0, audioStart);
        gain.gain.linearRampToValueAtTime(0.25, audioStart + attack);
        gain.gain.setValueAtTime(0.25, audioEnd - release);
        gain.gain.linearRampToValueAtTime(0.0, audioEnd);

        osc.connect(gain);
        gain.connect(this.audioContext.destination);

        try {
          osc.start(audioStart);
          osc.stop(audioEnd + 0.01);
        } catch (e) {
          // fallback if scheduled time rejected
          try {
            osc.start();
            osc.stop(audioEnd + 0.01);
          } catch (e2) {
            console.warn("Osc start failed", e2);
          }
        }

        // store scheduled node if needed for forced stop
        this.scheduledNodes.push({ osc, gain });

        // schedule UI updates using time differences from audioContext.currentTime
        const msToStart = Math.max(0, Math.round((audioStart - this.audioContext.currentTime) * 1000));
        const evId = this.eventIdCounter++;
        const startTimer = setTimeout(() => {
          if (!this.playbackState.playing) return;
          // mark active
          this.playbackState.tracks[cls].activeEvents.add(evId);
          this.playbackState.tracks[cls].currentLines.add(ev.lineNumber);
          this.updateClassListUI();
          this.updateEditorHighlights();
        }, msToStart);
        this.scheduledTimers.push(startTimer);

        const msToEnd = Math.max(0, Math.round((audioEnd - this.audioContext.currentTime) * 1000));
        const endTimer = setTimeout(() => {
          if (!this.playbackState.playing) return;
          // remove active
          const t = this.playbackState.tracks[cls];
          if (t) {
            t.activeEvents.delete(evId);
            // remove only one occurrence of lineNumber - if multiple events use same line, only remove when none left
            // We will rebuild currentLines by scanning activeEvents -> but we didn't keep per-event line map; simpler: remove the line and then if other active events exist on same line they'd have also added it:
            // We'll reconstruct currentLines from activeEvents by checking scheduled events (we keep event map not necessary for small set).
            // For simplicity here, remove line; if other events with same line still active, they will re-add it when started.
            t.currentLines.delete(ev.lineNumber);
          }
          this.updateClassListUI();
          this.updateEditorHighlights();
        }, msToEnd + 10);
        this.scheduledTimers.push(endTimer);
      });

      // schedule auto-stop at last event end
      const maxEnd = events.reduce((m, e) => Math.max(m, e.start + e.duration), 0);
      const autoStopTimer = setTimeout(() => {
        if (this.playbackState.playing) {
          this.consoleLog("Playback finished", "info");
          this.handleStop(/*internal*/ true);
        }
      }, Math.round((maxEnd + startOffset) * 1000) + 200);
      this.scheduledTimers.push(autoStopTimer);
    } catch (err) {
      this.consoleLog(`Play error: ${err && err.message ? err.message : err}`, "error");
      this.handleStop(true);
    }
  }

  handleStop(internal = false) {
    // internal: called by internal auto-stop; still clear state
    // stop scheduled audio and timers
    this.clearAllScheduled();

    // reset playback state
    this.playbackState.playing = false;
    for (const tName in this.playbackState.tracks) {
      const t = this.playbackState.tracks[tName];
      t.activeEvents.clear();
      t.currentLines.clear();
    }

    // UI updates
    this.updateClassListUI();
    this.updateEditorHighlights();

    if (this.elements.playBtn) this.elements.playBtn.disabled = false;
    if (this.elements.stopBtn) this.elements.stopBtn.disabled = true;
    if (!internal) this.consoleLog("Stopped", "info");
  }

  clearAllScheduled() {
    // clear timers
    this.scheduledTimers.forEach((id) => clearTimeout(id));
    this.scheduledTimers = [];
    // stop nodes if we want (best-effort)
    this.scheduledNodes.forEach((n) => {
      try {
        n.osc.disconnect();
      } catch (e) {}
      try {
        n.gain.disconnect();
      } catch (e) {}
    });
    this.scheduledNodes = [];
  }

  /**
   * Parse code into events with:
   * { lineNumber, instrument, pitch, start (s), duration (s), className }
   *
   * Supports:
   *  - tempoconst="120";
   *  - sleep(4); (denominator notation)
   *  - -cnt- (keep same start time for next snd)
   *  - snd("piano",4,C4,class="melody");
   */
  parseCodeToEvents(code) {
    const events = [];
    const lines = code.split(/\r?\n/);
    let tempo = 120;
    let currentBeat = 0;
    let lastStartBeat = 0;
    let sameStartFlag = false;

    const beatsToSeconds = (beats) => (beats * 60.0) / tempo;

    const splitArgs = (text) => {
      const out = [];
      let cur = "";
      let depth = 0;
      let inQuote = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"' && text[i - 1] !== "\\") {
          inQuote = !inQuote;
          cur += ch;
          continue;
        }
        if (!inQuote) {
          if (ch === "(" || ch === "[") depth++;
          else if (ch === ")" || ch === "]") depth--;
          if (ch === "," && depth === 0) {
            out.push(cur.trim());
            cur = "";
            continue;
          }
        }
        cur += ch;
      }
      if (cur.trim() !== "") out.push(cur.trim());
      return out;
    };

    const parseLengthToBeats = (lenStr) => {
      // accepts denominator like 4 or 4+ (dotted)
      let dotted = String(lenStr).trim().endsWith("+");
      let core = dotted ? lenStr.trim().slice(0, -1) : lenStr.trim();
      const n = parseInt(core, 10);
      if (!Number.isFinite(n) || n <= 0) return null;
      let beats = 4.0 / n;
      if (dotted) beats *= 1.5;
      return beats;
    };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;
      if (raw.startsWith("<")) continue; // comment
      // -cnt- handling
      if (/^\-cnt\-$/i.test(raw)) {
        sameStartFlag = true;
        continue;
      }
      // tempoconst
      const tmatch = raw.match(/tempoconst\s*=\s*"([\d.]+)"/i);
      if (tmatch) {
        const v = parseFloat(tmatch[1]);
        if (Number.isFinite(v) && v > 0) tempo = v;
        continue;
      }
      // sleep
      const sm = raw.match(/sleep\s*\(\s*([0-9]+\+?)\s*\)\s*;?$/i);
      if (sm) {
        const beats = parseLengthToBeats(sm[1]);
        if (beats !== null) {
          // advance by beats unless sameStartFlag is true (sleep doesn't combine with -cnt- typically)
          currentBeat += beats;
          lastStartBeat = currentBeat;
          sameStartFlag = false;
        }
        continue;
      }
      // snd(...)
      const sndm = raw.match(/snd\s*\((.*)\)\s*;?$/i);
      if (sndm) {
        const inside = sndm[1];
        const args = splitArgs(inside);
        // expect at least [instrument, length, pitch, ...attrs]
        if (args.length < 3) {
          // malformed; skip
          continue;
        }
        // instrument stripping quotes if present
        let instrument = args[0].trim();
        instrument = instrument.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");

        const lengthArg = args[1].trim();
        const pitchArg = args[2].trim();

        const beats = parseLengthToBeats(lengthArg);
        if (beats === null) continue;
        const duration = beatsToSeconds(beats);

        // decide start beat: if sameStartFlag true -> use lastStartBeat; else use currentBeat
        const startBeat = sameStartFlag ? lastStartBeat : currentBeat;
        const startSeconds = beatsToSeconds(startBeat);

        // parse attributes
        let className = null;
        for (let j = 3; j < args.length; j++) {
          const a = args[j];
          const kv = a.split("=").map(s => s.trim());
          if (kv.length === 2) {
            const k = kv[0];
            const v = kv[1].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
            if (k === "class") className = v;
          }
        }
        if (!className) className = "main";

        // record event
        events.push({
          id: null, // assigned later when scheduling
          lineNumber: i + 1, // editor lines are 1-based in UI
          instrument,
          pitch: pitchArg,
          start: startSeconds,
          duration,
          className,
        });

        // update beat counters: only advance currentBeat when not sameStartFlag
        if (!sameStartFlag) {
          lastStartBeat = currentBeat;
          currentBeat += beats;
          lastStartBeat = currentBeat - beats; // last event's start
        } else {
          // keep lastStartBeat unchanged (multiple events start at same beat)
        }
        // reset sameStartFlag after consuming
        sameStartFlag = false;
        continue;
      }
      // other lines ignored for now
    }

    return events;
  }

  // helpers for audio
  getOscillatorType(instrument) {
    const t = (instrument || "").toLowerCase();
    if (t.includes("sine")) return "sine";
    if (t.includes("square")) return "square";
    if (t.includes("triangle")) return "triangle";
    if (t.includes("saw")) return "sawtooth";
    if (t.includes("kick") || t.includes("drum")) return "sine";
    return "sine";
  }

  noteToMidi(note) {
    const table = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
    const m = ("" + note).match(/([A-Ga-g][#b]?)(-?\d+)/);
    if (!m) return 60;
    const nameRaw = m[1];
    const name = nameRaw[0].toUpperCase() + (nameRaw[1] || "");
    const octave = parseInt(m[2], 10);
    const sem = table[name] || 0;
    return (octave + 1) * 12 + sem;
  }

  midiToFrequency(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // UI: class list rendering with current lines shown
  updateClassListUI() {
    const container = this.elements.classList;
    if (!container) return;
    // determine classes (existing in code)
    const classes = this.extractClassesFromCode();
    // ensure 'main' always present
    if (!classes.includes("main")) classes.unshift("main");

    // prepare html
    container.innerHTML = classes
      .map((cls) => {
        const track = this.playbackState.tracks[cls] || { currentLines: new Set(), activeEvents: new Set() };
        const lines = Array.from(track.currentLines);
        let rightText = "";
        if (this.playbackState.playing && lines.length > 0) {
          rightText = `▶ line ${lines.join(", ")}`;
        } else if (this.playbackState.playing && lines.length === 0) {
          rightText = "stopped";
        }
        // mark selected class
        const selected = this.selectedClass === cls ? "selected" : "";
        return `<div class="class-item ${selected}" data-class="${cls}">
                  <div class="class-dot"></div>
                  <span class="class-name">${this.escapeHtml(cls)}</span>
                  <span class="class-lines">${this.escapeHtml(rightText)}</span>
                </div>`;
      })
      .join("");
    // install click handlers
    container.querySelectorAll(".class-item").forEach((el) => {
      el.onclick = () => {
        const cls = el.getAttribute("data-class");
        this.selectedClass = this.selectedClass === cls ? null : cls;
        this.updateClassListUI();
        this.updateEditorHighlights();
      };
    });
  }

  extractClassesFromCode() {
    const src = this.currentCode || "";
    const set = new Set*

