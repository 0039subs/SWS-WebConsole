(() => {
  "use strict";

  const SAMPLE_RATE = 44100;
  const PPQ = 480;
  const TEMPO_MAX = 999.9;
  const DEFAULT_VOLUME = 100;

  const VALID_INSTRUMENTS = new Set([
    "piano", "grand_piano", "synth", "synth_lead", "synth_bass",
    "bass", "drum", "kick", "hihat", "hi_hat", "snare",
    "sine", "square", "triangle", "saw", "sawtooth", "null"
  ]);

  const NOTE_TABLE = {
    C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3,
    E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8,
    Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11
  };

  const KEY_SCALES = {
    C: [0, 2, 4, 5, 7, 9, 11],
    G: [7, 9, 11, 0, 2, 4, 6],
    D: [2, 4, 6, 7, 9, 11, 1],
    A: [9, 11, 1, 2, 4, 6, 8],
    E: [4, 6, 8, 9, 11, 1, 3],
    B: [11, 1, 3, 4, 6, 8, 10],
    "F#": [6, 8, 10, 11, 1, 3, 5],
    F: [5, 7, 9, 10, 0, 2, 4],
    Bb: [10, 0, 2, 3, 5, 7, 9],
    Eb: [3, 5, 7, 8, 10, 0, 2],
    Ab: [8, 10, 0, 1, 3, 5, 7],
    Db: [1, 3, 5, 6, 8, 10, 0],
    Am: [9, 11, 0, 2, 4, 5, 7],
    Em: [4, 5, 7, 9, 11, 0, 2],
    Bm: [11, 0, 2, 4, 6, 7, 9],
    "F#m": [6, 7, 9, 11, 1, 3, 5],
    "C#m": [1, 2, 4, 6, 8, 9, 11],
    "G#m": [8, 9, 11, 1, 3, 5, 7],
    Dm: [2, 3, 5, 7, 9, 10, 0],
    Gm: [7, 8, 10, 0, 2, 3, 5],
    Cm: [0, 1, 3, 5, 7, 8, 10],
    Fm: [5, 6, 8, 10, 0, 1, 3]
  };

  const DOM = {};
  const state = {
    project: null,
    lastSuccessfulProject: null,
    source: "",
    fileName: "untitled.ss",
    dirty: false,
    selectedTrack: "main",
    playing: false,
    audioContext: null,
    audioNodes: new Set(),
    timers: new Set(),
    plugins: new Map(),
    errorLines: new Set()
  };

  function $(id) {
    return document.getElementById(id);
  }

  function initDom() {
    [
      "fileInput", "openButton", "saveButton", "compileButton",
      "playButton", "stopButton", "midiButton", "wavButton",
      "ustButton", "pluginButton", "themeToggle",
      "trackList", "trackCount", "addTrackButton",
      "renameTrackButton", "deleteTrackButton", "lineNumbers",
      "editorScroll", "highlightLayer", "highlightCode",
      "codeEditor", "editorFileName", "editorStatusText",
      "editorStatusDot", "tempoValue", "keyValue", "cursorValue",
      "compileStatus", "consoleOutput", "clearConsoleButton",
      "errorPanel", "errorLine", "errorType", "errorMessage",
      "exportWavButton", "exportMidiButton", "exportUstButton",
      "exportSsButton", "pluginModal", "pluginFileInput",
      "loadPluginButton", "pluginList", "pluginModalClose"
    ].forEach(id => {
      DOM[id] = $(id);
    });
  }

  class SWSError extends Error {
    constructor(line, type, message, column = null, token = null) {
      super(message);
      this.name = "SWSError";
      this.line = Number(line) || 1;
      this.type = type || "Error";
      this.message = message || "";
      this.column = column;
      this.token = token;
    }
  }

  class NoteData {
    constructor(pitch, options = {}) {
      this.pitch = pitch;
      this.slur = Boolean(options.slur);
      this.keyBypass = Boolean(options.keyBypass);
      this.lyric = options.lyric ?? null;
      this.key = options.key || "C";
      this.midi = options.midi ?? null;
      this.cents = 0;
    }

    toJSON() {
      return {
        pitch: this.pitch,
        slur: this.slur,
        key_bypass: this.keyBypass,
        lyric: this.lyric,
        key: this.key,
        midi: this.midi,
        cents: 0
      };
    }
  }

  class SoundEvent {
    constructor(instrument, start, duration, notes, line, className, volume) {
      this.type = instrument === "null" ? "rest" : "note";
      this.instrument = instrument;
      this.start = start;
      this.duration = duration;
      this.notes = notes;
      this.line = line;
      this.className = className || "main";
      this.volume = volume;
      this.lyric = notes.find(note => note.lyric)?.lyric || null;
      this.source = "";
      this.sourcePosition = { line, className: this.className };
      this.cntGroup = null;
      this.cntRole = null;
    }

    get end() {
      return this.start + this.duration;
    }

    toJSON() {
      return {
        type: this.type,
        instrument: this.instrument,
        start: this.start,
        duration: this.duration,
        notes: this.notes.map(note => note.toJSON()),
        line: this.line,
        class: this.className,
        lyric: this.lyric,
        volume: this.volume,
        source: this.source,
        source_position: this.sourcePosition
      };
    }
  }

  class Track {
    constructor(name) {
      this.id = makeId();
      this.name = name;
      this.className = name;
      this.sourceClassName = name;
      this.color = colorForTrack(name);
      this.cursor = 0;
      this.events = [];
      this.sourceStatements = [];
      this.order = 0;
    }

    addEvent(event) {
      this.events.push(event);
      this.sourceStatements.push({
        line: event.line,
        source: event.source,
        event
      });
    }
  }

  class TempoMap {
    constructor(tempo = 120) {
      validateTempo(tempo, 1);
      this.segments = [{ beat: 0, tempo: Number(tempo) }];
    }

    setTempo(beat, tempo, line = 1) {
      validateTempo(tempo, line);
      this.segments = this.segments.filter(
        segment => segment.beat !== beat
      );
      this.segments.push({ beat, tempo: Number(tempo) });
      this.segments.sort((a, b) => a.beat - b.beat);
    }

    beatToSeconds(beat) {
      if (beat <= 0) return 0;

      let result = 0;

      for (let i = 0; i < this.segments.length; i++) {
        const current = this.segments[i];
        const next = this.segments[i + 1];
        const end = next ? Math.min(beat, next.beat) : beat;

        if (end <= current.beat) continue;

        result += (end - current.beat) * 60 / current.tempo;
        if (end >= beat) break;
      }

      return result;
    }

    tempoAt(beat) {
      let result = this.segments[0].tempo;
      for (const segment of this.segments) {
        if (segment.beat <= beat) result = segment.tempo;
      }
      return result;
    }
  }

  class Project {
    constructor() {
      this.tempo = 120;
      this.key = "C";
      this.tempoMap = new TempoMap(120);
      this.tracks = [];
      this.events = [];
      this.globalEvents = [];
      this.outputRequests = [];
      this.plugins = [];
      this.source = "";
      this.sourceLines = [];
      this.sourceMetadata = {};
      this.mainTrack = this.ensureTrack("main");
    }

    ensureTrack(name) {
      const trackName = normalizeName(name);
      let track = this.tracks.find(item => item.name === trackName);

      if (!track) {
        track = new Track(trackName);
        track.order = this.tracks.length;
        this.tracks.push(track);
      }

      return track;
    }

    getTrack(name) {
      return this.ensureTrack(name || "main");
    }

    addEvent(event) {
      this.events.push(event);
      this.getTrack(event.className).addEvent(event);
    }

    toPluginData() {
      return {
        sws_version: "0.2",
        api_version: 1,
        type: "song",
        project: {
          tempo: this.tempoMap.segments[0]?.tempo || 120,
          key: this.key
        },
        events: this.events.map(event => event.toJSON())
      };
    }
  }

  function makeId() {
    if (globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
    return `sws-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function normalizeName(value) {
    return String(value ?? "").trim() || "main";
  }

  function colorForTrack(name) {
    return {
      main: "#2196f3",
      melody: "#ffb347",
      bass: "#9c6bff",
      drum: "#00c853",
      synth: "#00bcd4"
    }[name] || "#78909c";
  }

  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "0";
    return Number.isInteger(number)
      ? String(number)
      : String(Number(number.toFixed(6)));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeString(value) {
    return String(value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
  }

  function clone(value) {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  }

  function validateTempo(value, line) {
    const tempo = Number(value);

    if (!Number.isFinite(tempo) ||
        tempo <= 0 ||
        tempo > TEMPO_MAX) {
      throw new SWSError(
        line,
        "ValueError",
        `tempo must be greater than 0 and no greater than ${TEMPO_MAX}`
      );
    }
  }

  function parseDuration(value, line) {
    const text = String(value).trim();
    const dotted = text.endsWith("+");
    const denominatorText = dotted ? text.slice(0, -1) : text;

    if (!/^\d+$/.test(denominatorText)) {
      throw new SWSError(
        line,
        "ValueError",
        `invalid note length: ${value}`
      );
    }

    const denominator = Number(denominatorText);

    if (denominator <= 0) {
      throw new SWSError(
        line,
        "ValueError",
        "note length must be greater than 0"
      );
    }

    return 4 / denominator * (dotted ? 1.5 : 1);
  }

  function parseQuoted(value, line, label) {
    const text = String(value).trim();

    if (!text.startsWith('"') || !text.endsWith('"')) {
      throw new SWSError(
        line,
        "SyntaxError",
        `${label} must be written as "value"`
      );
    }

    return text.slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  function parseAssignment(text, name, line) {
    const match = text.match(
      new RegExp(`^${name}\\s*=\\s*"([^"]*)"\\s*$`, "i")
    );

    if (!match) {
      throw new SWSError(
        line,
        "SyntaxError",
        `${name} requires a quoted value`
      );
    }

    return match[1];
  }

  function findMatching(text, openIndex, openChar, closeChar) {
    if (openIndex < 0) return -1;

    let depth = 0;
    let inString = false;

    for (let i = openIndex; i < text.length; i++) {
      const ch = text[i];

      if (ch === '"' && text[i - 1] !== "\\") {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === openChar) depth++;
      if (ch === closeChar) depth--;

      if (depth === 0) return i;
    }

    return -1;
  }

  function splitTopLevel(text, delimiter = ",") {
    const result = [];
    let buffer = "";
    let parentheses = 0;
    let brackets = 0;
    let inString = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (ch === '"' && text[i - 1] !== "\\") {
        inString = !inString;
        buffer += ch;
        continue;
      }

      if (!inString) {
        if (ch === "(") parentheses++;
        if (ch === ")") parentheses--;
        if (ch === "[") brackets++;
        if (ch === "]") brackets--;

        if (
          ch === delimiter &&
          parentheses === 0 &&
          brackets === 0
        ) {
          result.push(buffer.trim());
          buffer = "";
          continue;
        }
      }

      buffer += ch;
    }

    if (buffer.trim()) result.push(buffer.trim());
    return result;
  }

  function splitFirstArguments(text, count) {
    const result = [];
    let buffer = "";
    let parentheses = 0;
    let brackets = 0;
    let inString = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (ch === '"' && text[i - 1] !== "\\") {
        inString = !inString;
        buffer += ch;
        continue;
      }

      if (!inString) {
        if (ch === "(") parentheses++;
        if (ch === ")") parentheses--;
        if (ch === "[") brackets++;
        if (ch === "]") brackets--;

        if (
          ch === "," &&
          parentheses === 0 &&
          brackets === 0 &&
          result.length < count
        ) {
          result.push(buffer.trim());
          buffer = "";
          continue;
        }
      }

      buffer += ch;
    }

    result.push(buffer.trim());
    return result;
  }

  function parseCallArguments(text, name, line) {
    const open = text.indexOf("(");
    const close = findMatching(text, open, "(", ")");

    if (
      open < 0 ||
      close < 0 ||
      text.slice(close + 1).trim()
    ) {
      throw new SWSError(
        line,
        "SyntaxError",
        `invalid ${name} call`
      );
    }

    const body = text.slice(open + 1, close).trim();
    return body ? splitTopLevel(body) : [];
  }

  function removeComments(source) {
    let result = "";
    let inString = false;
    let inComment = false;

    for (let i = 0; i < source.length; i++) {
      const ch = source[i];

      if (ch === '"' && source[i - 1] !== "\\") {
        if (!inComment) inString = !inString;
        result += ch;
        continue;
      }

      if (inString) {
        result += ch;
        continue;
      }

      if (!inComment && ch === "<") {
        inComment = true;
        result += " ";
        continue;
      }

      if (inComment && ch === "<") {
        throw new SWSError(
          source.slice(0, i).split("\n").length,
          "SyntaxError",
          "comment nesting is not allowed"
        );
      }

      if (inComment && ch === ">") {
        inComment = false;
        result += " ";
        continue;
      }

      if (!inComment) {
        result += ch;
      } else if (ch === "\n") {
        result += "\n";
      }
    }

    if (inComment) {
      throw new SWSError(
        source.split("\n").length,
        "SyntaxError",
        "unclosed comment"
      );
    }

    return result;
  }

  function countNewlines(text) {
    return (text.match(/\n/g) || []).length;
  }

  function scanStructure(source) {
    const clean = removeComments(source);
    const statements = [];

    let buffer = "";
    let startLine = 1;
    let line = 1;
    let inString = false;
    let parentheses = 0;
    let brackets = 0;

    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];

      if (ch === "\n") line++;

      if (ch === '"' && clean[i - 1] !== "\\") {
        inString = !inString;
        buffer += ch;
        continue;
      }

      if (inString) {
        buffer += ch;
        continue;
      }

      if (ch === "(") parentheses++;
      if (ch === ")") parentheses--;
      if (ch === "[") brackets++;
      if (ch === "]") brackets--;

      if (parentheses < 0 || brackets < 0) {
        throw new SWSError(
          line,
          "SyntaxError",
          "unmatched bracket"
        );
      }

      if (
        ch === "{" &&
        parentheses === 0 &&
        brackets === 0
      ) {
        const header = buffer.trim();

        if (!header) {
          throw new SWSError(
            line,
            "SyntaxError",
            "unexpected block opening"
          );
        }

        const close = findMatching(clean, i, "{", "}");

        if (close < 0) {
          throw new SWSError(
            line,
            "SyntaxError",
            "unclosed block"
          );
        }

        statements.push({
          type: "block",
          header,
          body: clean.slice(i + 1, close),
          line: startLine
        });

        line += countNewlines(clean.slice(i, close + 1));
        i = close;
        buffer = "";
        startLine = line + 1;
        continue;
      }

      if (
        ch === ";" &&
        parentheses === 0 &&
        brackets === 0
      ) {
        const text = buffer.trim();

        if (text) {
          statements.push({
            type: "statement",
            text,
            line: startLine,
            terminated: true
          });
        }

        buffer = "";
        startLine = line + 1;
        continue;
      }

      buffer += ch;
    }

    const trailing = buffer.trim();

    if (trailing) {
      statements.push({
        type: "statement",
        text: trailing,
        line: startLine,
        terminated: false
      });
    }

    return statements;
  }

  function splitCnt(text) {
    const result = [];
    let buffer = "";
    let inString = false;
    let parentheses = 0;
    let brackets = 0;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (ch === '"' && text[i - 1] !== "\\") {
        inString = !inString;
        buffer += ch;
        continue;
      }

      if (!inString) {
        if (ch === "(") parentheses++;
        if (ch === ")") parentheses--;
        if (ch === "[") brackets++;
        if (ch === "]") brackets--;

        if (
          text.slice(i, i + 5) === "-cnt-" &&
          parentheses === 0 &&
          brackets === 0
        ) {
          result.push(buffer.trim());
          buffer = "";
          i += 4;
          continue;
        }
      }

      buffer += ch;
    }

    if (buffer.trim()) result.push(buffer.trim());
    return result;
  }

  // ============================================================
  // Pitch and attributes
  // ============================================================

  function parsePitch(raw, key, line) {
    let text = String(raw).trim();
    let slur = false;
    let keyBypass = false;

    if (text.endsWith("~!")) {
      slur = true;
      keyBypass = true;
      text = text.slice(0, -2);
    } else if (text.endsWith("!~")) {
      slur = true;
      keyBypass = true;
      text = text.slice(0, -2);
    } else if (text.endsWith("~")) {
      slur = true;
      text = text.slice(0, -1);
    } else if (text.endsWith("!")) {
      keyBypass = true;
      text = text.slice(0, -1);
    }

    /*
     * SWS v0.2 does not implement cents or quarter-tone data.
     * Pitch modifiers are not converted into a cents field.
     */
    const match = text.match(/^([A-Ga-g](?:#|b)?)(-?\d+)$/);

    if (!match) {
      throw new SWSError(
        line,
        "ValueError",
        `invalid pitch: ${raw}`
      );
    }

    let name = match[1];
    const octave = Number(match[2]);
    name = name[0].toUpperCase() + name.slice(1);

    if (!(name in NOTE_TABLE)) {
      throw new SWSError(
        line,
        "ValueError",
        `invalid pitch: ${raw}`
      );
    }

    const base = NOTE_TABLE[name];
    let midi = (octave + 1) * 12 + base;

    if (!keyBypass && KEY_SCALES[key]) {
      const pitchClass = midi % 12;
      const scale = KEY_SCALES[key];

      if (!scale.includes(pitchClass)) {
        const nearest = scale.reduce((best, candidate) => {
          const currentDistance = Math.abs(
            ((candidate - pitchClass + 6) % 12) - 6
          );
          const bestDistance = Math.abs(
            ((best - pitchClass + 6) % 12) - 6
          );

          return currentDistance < bestDistance
            ? candidate
            : best;
        }, scale[0]);

        midi = Math.floor(midi / 12) * 12 + nearest;
      }
    }

    if (midi < 0 || midi > 127) {
      throw new SWSError(
        line,
        "ValueError",
        `pitch out of MIDI range: ${raw}`
      );
    }

    return new NoteData(text, {
      slur,
      keyBypass,
      key,
      midi
    });
  }

  function findAttributeStart(text) {
    let inString = false;
    let brackets = 0;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (ch === '"' && text[i - 1] !== "\\") {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === "[") brackets++;
      if (ch === "]") brackets--;

      if (
        brackets === 0 &&
        /\s/.test(ch) &&
        /^\s*(?:class|Lyric|vol)\s*=/.test(text.slice(i))
      ) {
        return i;
      }
    }

    return -1;
  }

  function parseAttributes(text, line) {
    const attributes = {};
    let index = 0;

    while (index < text.length) {
      while (index < text.length && /\s/.test(text[index])) index++;
      if (index >= text.length) break;

      const nameMatch = text.slice(index).match(
        /^([A-Za-z_][A-Za-z0-9_]*)\s*=/
      );

      if (!nameMatch) {
        throw new SWSError(
          line,
          "SyntaxError",
          `invalid snd attribute: ${text.slice(index)}`
        );
      }

      const name = nameMatch[1];
      index += nameMatch[0].length;

      while (index < text.length && /\s/.test(text[index])) index++;

      let value;

      if (text[index] === '"') {
        index++;
        value = "";
        let closed = false;

        while (index < text.length) {
          const ch = text[index];

          if (ch === '"' && text[index - 1] !== "\\") {
            closed = true;
            index++;
            break;
          }

          value += ch;
          index++;
        }

        if (!closed) {
          throw new SWSError(
            line,
            "SyntaxError",
            `unclosed ${name} attribute`
          );
        }

        value = value
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      } else {
        const valueMatch = text.slice(index).match(/^[^\s]+/);

        if (!valueMatch) {
          throw new SWSError(
            line,
            "SyntaxError",
            `missing value for ${name}`
          );
        }

        value = valueMatch[0];
        index += value.length;
      }

      if (!["class", "Lyric", "vol"].includes(name)) {
        throw new SWSError(
          line,
          "SyntaxError",
          `unknown snd attribute: ${name}`
        );
      }

      if (Object.prototype.hasOwnProperty.call(attributes, name)) {
        throw new SWSError(
          line,
          "SyntaxError",
          `duplicate attribute: ${name}`
        );
      }

      attributes[name] = value;
    }

    if (Object.prototype.hasOwnProperty.call(attributes, "vol")) {
      if (!/^\d+$/.test(attributes.vol)) {
        throw new SWSError(
          line,
          "SyntaxError",
          "vol must be an integer from 0 to 200"
        );
      }

      const volume = Number(attributes.vol);

      if (volume < 0 || volume > 200) {
        throw new SWSError(
          line,
          "SyntaxError",
          "vol must be an integer from 0 to 200"
        );
      }

      attributes.vol = volume;
    }

    return attributes;
  }

  function parsePitchAndAttributes(text, key, line) {
    const attributeStart = findAttributeStart(text);
    const pitchText = attributeStart < 0
      ? text.trim()
      : text.slice(0, attributeStart).trim();
    const attributeText = attributeStart < 0
      ? ""
      : text.slice(attributeStart).trim();

    const attributes = parseAttributes(attributeText, line);
    const className = normalizeName(attributes.class || "main");
    const lyric = Object.prototype.hasOwnProperty.call(
      attributes,
      "Lyric"
    )
      ? attributes.Lyric
      : null;
    const volume = Object.prototype.hasOwnProperty.call(
      attributes,
      "vol"
    )
      ? attributes.vol
      : DEFAULT_VOLUME;

    let notes;

    if (pitchText === "null") {
      notes = [
        new NoteData("null", {
          key,
          midi: null,
          lyric
        })
      ];
    } else if (/^fsn\s*=/.test(pitchText)) {
      const match = pitchText.match(
        /^fsn\s*=\s*\[([\s\S]*)\]$/
      );

      if (!match) {
        throw new SWSError(line, "SyntaxError", "invalid fsn");
      }

      const values = splitTopLevel(match[1]);

      if (values.length < 1 || values.length > 128) {
        throw new SWSError(
          line,
          "ValueError",
          "fsn must contain 1 to 128 notes"
        );
      }

      notes = values.map(value => {
        const note = parsePitch(value, key, line);
        note.lyric = lyric;
        return note;
      });
    } else {
      const note = parsePitch(pitchText, key, line);
      note.lyric = lyric;
      notes = [note];
    }

    return {
      notes,
      className,
      lyric,
      volume
    };
  }

  // ============================================================
  // Compiler
  // ============================================================

  class Compiler {
    constructor(source) {
      this.source = source;
      this.project = new Project();
      this.chips = new Map();
      this.chipStack = new Set();
      this.tempoconstSet = false;
      this.mainCursor = 0;
    }

    compile() {
      const statements = scanStructure(this.source);

      for (const statement of statements) {
        this.compileStatement(statement);
      }

      this.validateSlurs();

      this.project.source = this.source;
      this.project.sourceLines = this.source.split(/\r?\n/);

      this.project.events.sort((a, b) => {
        return a.start - b.start || a.line - b.line;
      });

      for (const track of this.project.tracks) {
        track.events.sort((a, b) => {
          return a.start - b.start || a.line - b.line;
        });
      }

      return this.project;
    }

    compileStatement(statement) {
      if (statement.type === "block") {
        this.compileBlock(statement);
        return;
      }

      const text = statement.text.trim();
      const line = statement.line;

      if (!text) return;

      if (!statement.terminated) {
        throw new SWSError(
          line,
          "SyntaxError",
          "missing semicolon"
        );
      }

      if (/^class(?:\s|=)/.test(text)) {
        throw new SWSError(
          line,
          "SyntaxError",
          'Class declaration is not supported. Use class="..." inside snd().'
        );
      }

      if (/^tempoconst\s*=/.test(text)) {
        this.compileTempoConst(text, line);
        return;
      }

      if (/^newtempo\s*=/.test(text)) {
        this.compileNewTempo(text, line);
        return;
      }

      if (/^key\s*=/.test(text)) {
        this.compileKey(text, line);
        return;
      }

      if (/^sleep\s*\(/.test(text)) {
        this.compileSleep(text, line);
        return;
      }

      if (/^snd\s*\(/.test(text)) {
        this.compileSnd(text, line);
        return;
      }

      if (/^chips\s*\(/.test(text)) {
        this.compileChipsCall(text, line);
        return;
      }

      if (/^output\./.test(text)) {
        this.compileOutput(text, line);
        return;
      }

      if (/^plugin\s*\(/.test(text)) {
        this.compilePlugin(text, line);
        return;
      }

      if (/^index\.class\s*\(/.test(text)) {
        this.compileIndexClass(text, line);
        return;
      }

      throw new SWSError(
        line,
        "SyntaxError",
        `unknown statement: ${text.split(/\s|\(/)[0]}`
      );
    }

    compileBlock(statement) {
      const header = statement.header.trim();
      const line = statement.line;

      const chipMatch = header.match(
        /^chips\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*$/
      );

      if (chipMatch) {
        const name = chipMatch[1];

        if (this.chips.has(name)) {
          throw new SWSError(
            line,
            "NameError",
            `chips '${name}' is already declared`
          );
        }

        this.chips.set(name, {
          name,
          line,
          statements: scanStructure(statement.body)
        });

        return;
      }

      const loopMatch = header.match(
        /^lp\s*\(\s*(\d+)\s*\)\s*$/
      );

      if (loopMatch) {
        const count = Number(loopMatch[1]);

        if (count <= 0) {
          throw new SWSError(
            line,
            "ValueError",
            "lp count must be greater than 0"
          );
        }

        const body = scanStructure(statement.body);

        for (let i = 0; i < count; i++) {
          for (const child of body) {
            this.compileStatement(child);
          }
        }

        return;
      }

      throw new SWSError(
        line,
        "SyntaxError",
        `unknown block: ${header}`
      );
    }

    compileTempoConst(text, line) {
      if (this.tempoconstSet) {
        throw new SWSError(
          line,
          "ValueError",
          "tempoconst can only be set once"
        );
      }

      const tempo = Number(
        parseAssignment(text, "tempoconst", line)
      );

      validateTempo(tempo, line);

      this.tempoconstSet = true;
      this.project.tempo = tempo;
      this.project.tempoMap = new TempoMap(tempo);
    }

    compileNewTempo(text, line) {
      const tempo = Number(
        parseAssignment(text, "newtempo", line)
      );

      validateTempo(tempo, line);

      this.project.tempoMap.setTempo(
        this.mainCursor,
        tempo,
        line
      );

      this.project.globalEvents.push({
        type: "tempo",
        beat: this.mainCursor,
        tempo,
        line
      });
    }

    compileKey(text, line) {
      const key = parseAssignment(text, "key", line);

      if (!Object.prototype.hasOwnProperty.call(KEY_SCALES, key)) {
        throw new SWSError(
          line,
          "ValueError",
          `invalid key: ${key}`
        );
      }

      this.project.key = key;
      this.project.globalEvents.push({
        type: "key",
        key,
        line
      });
    }

    compileSleep(text, line) {
      const args = parseCallArguments(text, "sleep", line);

      if (args.length !== 1) {
        throw new SWSError(
          line,
          "SyntaxError",
          "sleep requires exactly one length"
        );
      }

      this.mainCursor += parseDuration(args[0], line);
    }

    compileOutput(text, line) {
      const match = text.match(
        /^output\.(wav|midi|ust|ss)\s*\(([\s\S]*)\)$/i
      );

      if (!match) {
        throw new SWSError(
          line,
          "SyntaxError",
          "invalid output statement"
        );
      }

      const args = splitTopLevel(match[2]);

      if (args.length !== 1) {
        throw new SWSError(
          line,
          "SyntaxError",
          "output requires exactly one filename"
        );
      }

      this.project.outputRequests.push({
        type: match[1].toLowerCase(),
        filename: parseQuoted(args[0], line, "output filename"),
        line,
        className: null
      });
    }

    compilePlugin(text, line) {
      const args = parseCallArguments(text, "plugin", line);

      if (args.length !== 1) {
        throw new SWSError(
          line,
          "SyntaxError",
          "plugin requires exactly one name"
        );
      }

      const name = parseQuoted(args[0], line, "plugin name");

      if (!/^[A-Za-z0-9_]+$/.test(name)) {
        throw new SWSError(
          line,
          "ValueError",
          `invalid plugin name: ${name}`
        );
      }

      this.project.plugins.push({ name, line });
    }

    compileIndexClass(text, line) {
      const args = parseCallArguments(
        text,
        "index.class",
        line
      );

      if (args.length !== 1) {
        throw new SWSError(
          line,
          "SyntaxError",
          "index.class requires exactly one class name"
        );
      }

      const name = parseQuoted(args[0], line, "class name");
      this.project.ensureTrack(name);
    }

    compileChipsCall(text, line) {
      const args = parseCallArguments(text, "chips", line);

      if (args.length !== 1) {
        throw new SWSError(
          line,
          "SyntaxError",
          "chips requires exactly one name"
        );
      }

      const name = args[0].trim();

      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new SWSError(
          line,
          "SyntaxError",
          "invalid chips name"
        );
      }

      if (!this.chips.has(name)) {
        throw new SWSError(
          line,
          "NameError",
          `chips '${name}' is not declared yet`
        );
      }

      if (this.chipStack.has(name)) {
        throw new SWSError(
          line,
          "RecursionError",
          `chips '${name}' has circular dependency`
        );
      }

      this.chipStack.add(name);

      try {
        for (const child of this.chips.get(name).statements) {
          this.compileStatement(child);
        }
      } finally {
        this.chipStack.delete(name);
      }
    }

    compileSnd(text, line) {
      const parts = splitCnt(text);

      if (parts.length > 1) {
        this.compileCnt(parts, line);
      } else {
        this.compileSingleSnd(text, line);
      }
    }

    parseSnd(text, line) {
      const open = text.indexOf("(");
      const close = findMatching(text, open, "(", ")");

      if (
        open < 0 ||
        close < 0 ||
        text.slice(close + 1).trim()
      ) {
        throw new SWSError(
          line,
          "SyntaxError",
          "invalid snd call"
        );
      }

      const parts = splitFirstArguments(
        text.slice(open + 1, close),
        2
      );

      if (parts.length < 3) {
        throw new SWSError(
          line,
          "SyntaxError",
          "snd requires instrument, length and pitch"
        );
      }

      const instrument = parseQuoted(
        parts[0],
        line,
        "instrument"
      ).toLowerCase();

      if (!VALID_INSTRUMENTS.has(instrument)) {
        throw new SWSError(
          line,
          "ValueError",
          `unknown instrument: ${instrument}`
        );
      }

      const duration = parseDuration(parts[1], line);
      const parsed = parsePitchAndAttributes(
        parts[2],
        this.project.key,
        line
      );

      return {
        instrument,
        duration,
        notes: parsed.notes,
        className: parsed.className,
        volume: parsed.volume,
        source: text
      };
    }

    compileSingleSnd(text, line, options = {}) {
      const parsed = this.parseSnd(text, line);
      const track = this.project.getTrack(parsed.className);
      const start = options.start ?? track.cursor;

      const event = new SoundEvent(
        parsed.instrument,
        start,
        parsed.duration,
        parsed.notes,
        line,
        parsed.className,
        parsed.volume
      );

      event.source = parsed.source;
      event.cntGroup = options.cntGroup || null;
      event.cntRole = options.cntRole || null;

      this.project.addEvent(event);

      if (options.updateCursor !== false) {
        track.cursor = Math.max(track.cursor, event.end);

        if (track.name === "main") {
          this.mainCursor = track.cursor;
        }
      }

      return event;
    }

    compileCnt(parts, line) {
      const groupId = `cnt-${line}-${this.project.events.length}`;
      const left = this.compileSingleSnd(parts[0], line, {
        cntGroup: groupId,
        cntRole: "left"
      });

      const leftTrack = this.project.getTrack(left.className);
      const anchorPitches = eventPitchKeys(left);
      const created = [left];

      for (let i = 1; i < parts.length; i++) {
        const parsed = this.parseSnd(parts[i], line);
        const track = this.project.getTrack(parsed.className);
        let start = track.cursor;

        if (track.name === leftTrack.name) {
          const previous = this.findRelevantSamePitchNode(
            track,
            anchorPitches,
            left
          );

          start = previous
            ? Math.max(left.start, previous.start)
            : left.start;
        }

        const event = new SoundEvent(
          parsed.instrument,
          start,
          parsed.duration,
          parsed.notes,
          line,
          parsed.className,
          parsed.volume
        );

        event.source = parsed.source;
        event.cntGroup = groupId;
        event.cntRole = "right";

        this.project.addEvent(event);
        created.push(event);
      }

      const affectedTracks = new Map();

      for (const event of created) {
        affectedTracks.set(
          event.className,
          this.project.getTrack(event.className)
        );
      }

      for (const track of affectedTracks.values()) {
        const groupEvents = created.filter(
          event => event.className === track.name
        );

        if (!groupEvents.length) continue;

        track.cursor = Math.max(
          track.cursor,
          ...groupEvents.map(event => event.end)
        );

        if (track.name === "main") {
          this.mainCursor = track.cursor;
        }
      }
    }

    findRelevantSamePitchNode(track, pitchKeys, currentEvent) {
      const candidates = track.events
        .filter(event => event !== currentEvent)
        .filter(event => event.start <= currentEvent.start)
        .filter(event => {
          return eventPitchKeys(event).some(
            pitch => pitchKeys.includes(pitch)
          );
        })
        .sort((a, b) => {
          return b.start - a.start || b.line - a.line;
        });

      return candidates[0] || null;
    }

    validateSlurs() {
      for (const event of this.project.events) {
        for (const note of event.notes) {
          if (!note.slur || note.midi === null) continue;

          const target = this.project.events.find(candidate => {
            if (candidate === event) return false;
            if (candidate.className !== event.className) return false;
            if (Math.abs(candidate.start - event.end) > 1e-9) {
              return false;
            }

            return candidate.notes.some(other => {
              return (
                other.midi === note.midi &&
                other.pitch !== "null"
              );
            });
          });

          if (!target) {
            throw new SWSError(
              event.line,
              "SlurError",
              `slur target not found for ${note.pitch}`
            );
          }
        }
      }
    }
  }

  function eventPitchKeys(event) {
    return event.notes
      .filter(note => note.midi !== null)
      .map(note => String(note.midi));
  }

  // ============================================================
  // Syntax highlighting
  // ============================================================

  function removeCommentsForHighlight(source) {
    return removeComments(source);
  }

  function isBlockHeader(text) {
    return (
      /^lp\s*\(\s*\d+\s*\)\s*$/.test(text) ||
      /^chips\s+[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*$/.test(text)
    );
  }

  function findMissingSemicolonLines(source) {
    const clean = removeCommentsForHighlight(source);
    const lines = clean.split(/\r?\n/);
    const errors = new Set();

    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim();

      if (!text) continue;
      if (text === "{" || text === "}") continue;
      if (isBlockHeader(text)) continue;
      if (text.endsWith("{")) continue;
      if (text.endsWith(";")) continue;

      if (
        text.startsWith("snd(") ||
        text.startsWith("sleep(") ||
        text.startsWith("tempoconst") ||
        text.startsWith("newtempo") ||
        text.startsWith("key") ||
        text.startsWith("output.") ||
        text.startsWith("plugin(") ||
        text.startsWith("chips(") ||
        text.startsWith("index.class")
      ) {
        errors.add(i + 1);
      }

      if (/^class(?:\s|=)/.test(text)) {
        errors.add(i + 1);
      }
    }

    return errors;
  }

  function tokenizeHighlightLine(line) {
    const tokens = [];
    let index = 0;

    while (index < line.length) {
      const ch = line[index];

      if (ch === "<") {
        const end = line.indexOf(">", index + 1);

        if (end >= 0) {
          tokens.push({
            className: "syn-comment",
            value: line.slice(index, end + 1)
          });
          index = end + 1;
          continue;
        }
      }

      if (ch === '"') {
        let end = index + 1;

        while (end < line.length) {
          if (line[end] === '"' && line[end - 1] !== "\\") {
            end++;
            break;
          }
          end++;
        }

        tokens.push({
          className: "syn-string",
          value: line.slice(index, end)
        });

        index = end;
        continue;
      }

      const match = line.slice(index).match(
        /^(?:[A-Za-z_][A-Za-z0-9_]*|[A-Ga-g](?:#|b)?-?\d+(?:~!?|!~?)?|\d+(?:\.\d+)?|[=(),[\]{}.;~!])/
      );

      if (!match) {
        tokens.push({ className: "syn-text", value: ch });
        index++;
        continue;
      }

      const value = match[0];
      const lower = value.toLowerCase();
      let className = "syn-text";

      if ([
        "snd", "sleep", "lp", "chips", "tempoconst",
        "newtempo", "key", "output", "plugin", "index"
      ].includes(lower)) {
        className = "syn-command";
      } else if ([
        "class", "lyric", "vol", "fsn", "null"
      ].includes(lower)) {
        className = "syn-keyword";
      } else if (
        /^[A-Ga-g](?:#|b)?-?\d+(?:~!?|!~?)?$/.test(value)
      ) {
        className = "syn-pitch";
      } else if (/^\d/.test(value)) {
        className = "syn-number";
      } else if (/^[=(),[\]{}.;~!]$/.test(value)) {
        className = "syn-operator";
      }

      tokens.push({ className, value });
      index += value.length;
    }

    return tokens;
  }

  function updateLineNumbers() {
    if (!DOM.lineNumbers || !DOM.codeEditor) return;

    const count = Math.max(
      1,
      DOM.codeEditor.value.split("\n").length
    );

    const fragment = document.createDocumentFragment();

    for (let i = 1; i <= count; i++) {
      const span = document.createElement("span");
      span.className = "line-number";
      span.textContent = String(i);
      fragment.appendChild(span);
    }

    DOM.lineNumbers.replaceChildren(fragment);
  }

  function updateHighlight() {
    if (!DOM.codeEditor || !DOM.highlightCode) return;

    const lines = DOM.codeEditor.value.split(/\r?\n/);
    const missing = findMissingSemicolonLines(
      DOM.codeEditor.value
    );

    DOM.highlightCode.innerHTML = lines.map((line, index) => {
      const content = tokenizeHighlightLine(line)
        .map(token => {
          return `<span class="${token.className}">${escapeHtml(token.value)}</span>`;
        })
        .join("") || " ";

      return missing.has(index + 1)
        ? `<span class="syn-error">${content}</span>`
        : content;
    }).join("\n");

    DOM.codeEditor.style.color = "transparent";
    DOM.codeEditor.style.webkitTextFillColor = "transparent";
    DOM.codeEditor.style.caretColor = "var(--text)";
  }

  function syncEditorScroll() {
    if (!DOM.editorScroll) return;

    if (DOM.highlightLayer) {
      DOM.highlightLayer.scrollTop = DOM.editorScroll.scrollTop;
      DOM.highlightLayer.scrollLeft = DOM.editorScroll.scrollLeft;
    }

    if (DOM.codeEditor) {
      DOM.codeEditor.scrollTop = DOM.editorScroll.scrollTop;
      DOM.codeEditor.scrollLeft = DOM.editorScroll.scrollLeft;
    }

    if (DOM.lineNumbers) {
      DOM.lineNumbers.scrollTop = DOM.editorScroll.scrollTop;
    }
  }

  function refreshEditor() {
    updateLineNumbers();
    updateHighlight();
    syncEditorScroll();
  }

  // ============================================================
  // Compile, track UI and files
  // ============================================================

  function compileSource(source, commit = true) {
    clearError();

    try {
      const compiler = new Compiler(source);
      const project = compiler.compile();

      if (commit) {
        state.lastSuccessfulProject = project;
        state.project = project;
        state.source = source;
        state.dirty = false;

        updateProjectInfo(project);
        renderTracks(project);
        setStatus("Compiled", false);
      }

      return project;
    } catch (error) {
      reportError(error);
      if (DOM.compileStatus) DOM.compileStatus.textContent = "Compile failed";
      setStatus("Error", false);
      return null;
    }
  }

  function compileCurrent() {
    if (!DOM.codeEditor) return null;

    const project = compileSource(
      DOM.codeEditor.value,
      true
    );

    if (!project) return null;

    if (DOM.compileStatus) {
      DOM.compileStatus.textContent = "Compile success";
    }

    log(
      `Compile success: Found ${project.events.length} events`,
      "success"
    );

    for (const event of project.events) {
      const pitch = event.notes.length > 1
        ? `[${event.notes.map(note => note.pitch).join(", ")}]`
        : event.notes[0]?.pitch || "null";

      log(
        `sound success:${event.line},${pitch},${formatNumber(event.duration)} beat`,
        "success"
      );
    }

    runPlugins(project);
    return project;
  }

  function updateProjectInfo(project) {
    const main = project.tracks.find(
      track => track.name === "main"
    );

    if (DOM.tempo) {
      DOM.tempo.textContent = String(
        project.tempoMap.segments[0].tempo
      );
    }

    if (DOM.key) DOM.key.textContent = project.key;

    if (DOM.cursor) {
      DOM.cursor.textContent =
        `${formatNumber(main?.cursor || 0)} beat`;
    }
  }

  function renderTracks(project) {
    if (!DOM.trackList || !project) return;

    DOM.trackList.replaceChildren();

    for (const track of project.tracks) {
      const item = document.createElement("div");
      item.className = "track-item";
      item.dataset.trackName = track.name;
      item.dataset.className = track.className;
      item.setAttribute("role", "option");
      item.setAttribute(
        "aria-selected",
        state.selectedTrack === track.name
          ? "true"
          : "false"
      );

      if (state.selectedTrack === track.name) {
        item.classList.add("selected");
      }

      const dot = document.createElement("span");
      dot.className = "track-dot";
      dot.style.background = track.color;

      const info = document.createElement("span");
      info.className = "track-info";

      const name = document.createElement("span");
      name.className = "track-name";
      name.textContent = track.name;

      const meta = document.createElement("span");
      meta.className = "track-meta";
      meta.textContent =
        `class: ${track.className} · cursor: ${formatNumber(track.cursor)} beat`;

      const status = document.createElement("span");
      status.className = "track-state";
      status.dataset.trackState = track.name;
      status.textContent = "idle";

      info.append(name, meta);
      item.append(dot, info, status);
      DOM.trackList.appendChild(item);

      item.addEventListener("click", () => {
        state.selectedTrack = track.name;
        renderTracks(project);
        showTrackSource(project, track.name);
      });
    }

    if (DOM.trackCount) {
      DOM.trackCount.textContent =
        `${project.tracks.length} track${project.tracks.length === 1 ? "" : "s"}`;
    }
  }

  function showTrackSource(project, name) {
    const track = project.tracks.find(item => item.name === name);

    if (!track || !track.sourceStatements.length) return;

    const globals = project.source
      .split(/\r?\n/)
      .filter(line => {
        const text = line.trim();

        return (
          text.startsWith("tempoconst") ||
          text.startsWith("newtempo") ||
          text.startsWith("key") ||
          text.startsWith("output.") ||
          text.startsWith("plugin") ||
          text.startsWith("index.class")
        );
      });

    DOM.codeEditor.value = [
      ...globals,
      ...track.sourceStatements
        .sort((a, b) => a.line - b.line)
        .map(item => item.source)
    ].join("\n");

    refreshEditor();
  }

  function openFile(file) {
    const reader = new FileReader();

    reader.onload = () => {
      try {
        const text = String(reader.result || "");

        if (file.name.toLowerCase().endsWith(".ust")) {
          DOM.codeEditor.value = ustToSs(text);
          log("UST translated to SS", "success");
        } else {
          DOM.codeEditor.value = text;
          log("Loaded .ss", "success");
        }

        state.fileName = file.name;
        state.source = DOM.codeEditor.value;
        state.dirty = false;

        if (DOM.editorFileName) {
          DOM.editorFileName.textContent = file.name;
        }

        refreshEditor();
        compileCurrent();
      } catch (error) {
        reportError(error);
      }
    };

    reader.onerror = () => {
      reportError(new SWSError(
        1,
        "FileError",
        "failed to read file"
      ));
    };

    reader.readAsText(file);
  }

  function saveSs() {
    const source = DOM.codeEditor?.value || state.source;
    const filename = ensureExtension(
      state.fileName || "song",
      ".ss"
    );

    downloadBlob(
      new Blob([source], {
        type: "text/plain;charset=utf-8"
      }),
      filename
    );

    log(`output success:ss,${filename}`, "success");
  }

  // ============================================================
  // UST
  // ============================================================

  function midiToPitch(midi) {
    const names = [
      "C", "C#", "D", "D#", "E", "F",
      "F#", "G", "G#", "A", "A#", "B"
    ];

    return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
  }

  function ustToSs(text) {
    const lines = String(text).split(/\r?\n/);
    const notes = [];
    let current = null;
    let tempo = 120;

    for (const raw of lines) {
      const line = raw.trim();

      if (!line) continue;

      if (line.startsWith("Tempo=")) {
        tempo = Number(line.slice(6)) || tempo;
        continue;
      }

      if (/^\[#\d+\]$/.test(line)) {
        if (current) notes.push(current);
        current = {};
        continue;
      }

      if (line === "[#TRACKEND]") {
        if (current) notes.push(current);
        current = null;
        break;
      }

      if (current && line.includes("=")) {
        const index = line.indexOf("=");
        current[line.slice(0, index)] =
          line.slice(index + 1);
      }
    }

    const result = [`tempoconst="${tempo.toFixed(2)}";`, ""];

    for (const note of notes) {
      const length = Number(note.Length || 480);
      const beats = length / 480;
      const denominator = 4 / beats;
      const duration = Number.isInteger(denominator)
        ? String(denominator)
        : String(Math.round(denominator));
      const lyric = note.Lyric || "R";

      if (!note.NoteNum || lyric.toUpperCase() === "R") {
        result.push(`sleep(${duration});`);
      } else {
        result.push(
          `snd("synth",${duration},${midiToPitch(Number(note.NoteNum))} Lyric="${escapeString(lyric)}");`
        );
      }
    }

    return result.join("\n");
  }

  function exportUst(project = state.project || compileCurrent()) {
    if (!project) return;

    const request = project.outputRequests.find(
      item => item.type === "ust"
    );

    const className = request?.className || null;
    const events = project.events
      .filter(event => !className || event.className === className)
      .slice()
      .sort((a, b) => a.start - b.start || a.line - b.line);

    const lines = [
      "[#VERSION]",
      "UST Version1.2",
      "",
      "[#SETTING]",
      `Tempo=${project.tempoMap.segments[0].tempo.toFixed(2)}`,
      "Tracks=1",
      "ProjectName=SoundWavScript",
      "VoiceDir=%VOICE%uta",
      "OutFile=",
      "CacheDir=sample.cache",
      "Tool1=wavtool.exe",
      "Tool2=resampler.exe",
      "Mode2=True",
      ""
    ];

    let index = 0;
    let cursor = 0;

    for (const event of events) {
      if (event.start > cursor) {
        appendUstRest(
          lines,
          index++,
          event.start - cursor
        );
      }

      const notes = event.notes.filter(
        note => note.midi !== null
      );

      if (!notes.length) {
        appendUstRest(lines, index++, event.duration);
        cursor = event.end;
        continue;
      }

      const lowest = Math.min(
        ...notes.map(note => note.midi)
      );

      const lyric = notes.length > 1
        ? notes
          .slice()
          .sort((a, b) => a.midi - b.midi)
          .map(note => midiToPitch(note.midi))
          .join("")
        : notes[0].lyric || "R";

      lines.push(
        `[#${String(index++).padStart(4, "0")}]`,
        `Length=${Math.round(event.duration * 480)}`,
        `Lyric=${lyric}`,
        `NoteNum=${lowest}`,
        "Intensity=100",
        "Modulation=0",
        ""
      );

      cursor = event.end;
    }

    lines.push("[#TRACKEND]", "");

    const filename = ensureExtension(
      request?.filename || "song",
      ".ust"
    );

    downloadBlob(
      new Blob([lines.join("\n")], {
        type: "text/plain;charset=utf-8"
      }),
      filename
    );

    log(`output success:ust,${filename}`, "success");
  }

  function appendUstRest(lines, index, beats) {
    lines.push(
      `[#${String(index).padStart(4, "0")}]`,
      `Length=${Math.round(beats * 480)}`,
      "Lyric=R",
      "Intensity=100",
      "Modulation=0",
      ""
    );
  }

  // ============================================================
  // MIDI
  // ============================================================

  function writeVariableLength(value) {
    let buffer = value & 0x7f;
    const result = [];

    while ((value >>= 7)) {
      buffer <<= 8;
      buffer |= (value & 0x7f) | 0x80;
    }

    while (true) {
      result.push(buffer & 0xff);

      if (buffer & 0x80) {
        buffer >>= 8;
      } else {
        break;
      }
    }

    return result;
  }

  function exportMidi(project = state.project || compileCurrent()) {
    if (!project) return;

    const queue = [];

    for (const segment of project.tempoMap.segments) {
      const tick = Math.round(segment.beat * PPQ);
      const micros = Math.round(60000000 / segment.tempo);

      queue.push({
        tick,
        priority: 0,
        bytes: [
          0xff,
          0x51,
          0x03,
          (micros >> 16) & 0xff,
          (micros >> 8) & 0xff,
          micros & 0xff
        ]
      });
    }

    for (const event of project.events) {
      const start = Math.round(event.start * PPQ);
      const end = Math.round(event.end * PPQ);
      const velocity = Math.max(
        0,
        Math.min(127, Math.round(event.volume * 1.27))
      );

      for (const note of event.notes) {
        if (note.midi === null) continue;

        queue.push({
          tick: end,
          priority: 1,
          bytes: [0x80, note.midi, 0]
        });

        queue.push({
          tick: start,
          priority: 2,
          bytes: [0x90, note.midi, velocity]
        });
      }
    }

    queue.sort((a, b) => {
      return a.tick - b.tick || a.priority - b.priority;
    });

    const track = [];
    let current = 0;

    for (const item of queue) {
      track.push(
        ...writeVariableLength(item.tick - current),
        ...item.bytes
      );
      current = item.tick;
    }

    track.push(0, 0xff, 0x2f, 0);

    const header = [
      0x4d, 0x54, 0x68, 0x64,
      0, 0, 0, 6,
      0, 0,
      0, 1,
      1, 0xe0
    ];

    const trackHeader = [
      0x4d, 0x54, 0x72, 0x6b,
      (track.length >> 24) & 0xff,
      (track.length >> 16) & 0xff,
      (track.length >> 8) & 0xff,
      track.length & 0xff
    ];

    downloadBlob(
      new Blob([
        new Uint8Array([
          ...header,
          ...trackHeader,
          ...track
        ])
      ], { type: "audio/midi" }),
      "song.mid"
    );

    log("output success:midi,song.mid", "success");
  }

  // ============================================================
  // WAV and Web Audio
  // ============================================================

  function synthWave(instrument, frequency, time) {
    const phase = 2 * Math.PI * frequency * time;
    const name = String(instrument).toLowerCase();

    if (name === "square") {
      return Math.sin(phase) >= 0 ? 1 : -1;
    }

    if (name === "triangle") {
      return 2 / Math.PI * Math.asin(Math.sin(phase));
    }

    if (name === "saw" || name === "sawtooth") {
      return 2 * ((frequency * time) % 1) - 1;
    }

    if (name === "synth" || name === "synth_lead") {
      return Math.sin(phase) + 0.35 * Math.sin(phase * 2);
    }

    if (name === "bass" || name === "synth_bass") {
      return Math.sin(phase) + 0.35 * Math.sin(phase / 2);
    }

    if (name === "piano" || name === "grand_piano") {
      return (
        Math.sin(phase) +
        0.45 * Math.sin(phase * 2) +
        0.25 * Math.sin(phase * 3) +
        0.12 * Math.sin(phase * 4)
      ) * Math.exp(-1.8 * time);
    }

    if (name === "kick") {
      const shifted = frequency *
        (1 + 4 * Math.exp(-25 * time));

      return Math.sin(
        2 * Math.PI * shifted * time
      ) * Math.exp(-10 * time);
    }

    if (name === "snare") {
      return (
        Math.sin(2 * Math.PI * 200 * time) +
        Math.sin(2 * Math.PI * 300 * time)
      ) * Math.exp(-8 * time);
    }

    if (name === "hihat" || name === "hi_hat") {
      return (
        Math.sin(2 * Math.PI * 8000 * time) +
        Math.sin(2 * Math.PI * 12000 * time)
      ) * Math.exp(-20 * time);
    }

    if (name === "drum") {
      const shifted = frequency *
        (1 + 3 * Math.exp(-20 * time));

      return Math.sin(
        2 * Math.PI * shifted * time
      ) * Math.exp(-8 * time);
    }

    return Math.sin(phase);
  }

  function envelope(time, duration) {
    if (duration <= 0) return 0;

    const attack = Math.min(0.02, duration * 0.15);
    const release = Math.min(0.1, duration * 0.25);

    if (time < attack) return time / attack;
    if (time > duration - release) {
      return Math.max(0, (duration - time) / release);
    }

    return 1;
  }

  function noteFrequency(note) {
    return 440 * Math.pow(2, (note.midi - 69) / 12);
  }

  function exportWav(project = state.project || compileCurrent()) {
    if (!project) return;

    const totalBeat = project.events.length
      ? Math.max(...project.events.map(event => event.end))
      : 0;
    const totalSeconds = project.tempoMap.beatToSeconds(totalBeat);
    const sampleCount = Math.max(
      1,
      Math.ceil(totalSeconds * SAMPLE_RATE)
    );
    const samples = new Float32Array(sampleCount);

    for (const event of project.events) {
      const start = project.tempoMap.beatToSeconds(event.start);
      const end = project.tempoMap.beatToSeconds(event.end);
      const duration = end - start;
      const offset = Math.floor(start * SAMPLE_RATE);
      const count = Math.floor(duration * SAMPLE_RATE);
      const volume = event.volume / 100;

      for (const note of event.notes) {
        if (note.midi === null) continue;

        const frequency = noteFrequency(note);

        for (let i = 0; i < count; i++) {
          const index = offset + i;
          if (index >= samples.length) break;

          const time = i / SAMPLE_RATE;

          samples[index] +=
            synthWave(event.instrument, frequency, time) *
            envelope(time, duration) *
            0.18 *
            volume;
        }
      }
    }

    let peak = 0;
    for (const sample of samples) {
      peak = Math.max(peak, Math.abs(sample));
    }

    const scale = peak > 0.95 ? 0.95 / peak : 1;
    const pcm = new Int16Array(samples.length);

    for (let i = 0; i < samples.length; i++) {
      const value = Math.max(
        -1,
        Math.min(1, samples[i] * scale)
      );
      pcm[i] = Math.round(value * 32767);
    }

    downloadBlob(
      makeWavBlob(pcm, SAMPLE_RATE),
      "song.wav"
    );

    log("output success:wav,song.wav", "success");
  }

  function makeWavBlob(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    function writeText(offset, text) {
      for (let i = 0; i < text.length; i++) {
        view.setUint8(offset + i, text.charCodeAt(i));
      }
    }

    writeText(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, samples.length * 2, true);

    for (let i = 0; i < samples.length; i++) {
      view.setInt16(44 + i * 2, samples[i], true);
    }

    return new Blob([buffer], { type: "audio/wav" });
  }

  function instrumentWaveType(instrument) {
    if (instrument === "square") return "square";
    if (instrument === "triangle") return "triangle";
    if (instrument === "saw" || instrument === "sawtooth") {
      return "sawtooth";
    }
    return "sine";
  }

  async function playProject(project = state.project || compileCurrent()) {
    if (!project) return;

    stopPlayback();

    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      reportError(new SWSError(
        1,
        "AudioError",
        "Web Audio API is not supported"
      ));
      return;
    }

    state.audioContext = new AudioContextClass();
    await state.audioContext.resume();

    state.playing = true;

    if (DOM.playButton) DOM.playButton.disabled = true;
    if (DOM.stopButton) DOM.stopButton.disabled = false;

    setStatus("Playing", false);
    log("Playing...", "success");

    const base = state.audioContext.currentTime + 0.05;

    for (const event of project.events) {
      const start = project.tempoMap.beatToSeconds(event.start);
      const end = project.tempoMap.beatToSeconds(event.end);
      const duration = Math.max(0.001, end - start);
      const timer = setTimeout(() => {
        updatePlaybackTrack(event.className, event.line);
      }, start * 1000);

      state.timers.add(timer);

      for (const note of event.notes) {
        if (note.midi === null) continue;

        const oscillator = state.audioContext.createOscillator();
        const gain = state.audioContext.createGain();
        const volume = Math.max(
          0,
          Math.min(2, event.volume / 100)
        );

        oscillator.type = instrumentWaveType(event.instrument);
        oscillator.frequency.value = noteFrequency(note);

        const absoluteStart = base + start;
        const absoluteEnd = base + end;

        gain.gain.setValueAtTime(
          0.001,
          absoluteStart
        );
        gain.gain.linearRampToValueAtTime(
          0.16 * volume,
          absoluteStart + Math.min(0.02, duration * 0.15)
        );
        gain.gain.linearRampToValueAtTime(
          0,
          absoluteEnd
        );

        oscillator.connect(gain);
        gain.connect(state.audioContext.destination);
        oscillator.start(absoluteStart);
        oscillator.stop(absoluteEnd + 0.02);

        state.audioNodes.add(oscillator);
        oscillator.addEventListener("ended", () => {
          state.audioNodes.delete(oscillator);
        });
      }
    }

    const totalBeat = project.events.length
      ? Math.max(...project.events.map(event => event.end))
      : 0;

    const finish = setTimeout(() => {
      stopPlayback();
    }, project.tempoMap.beatToSeconds(totalBeat) * 1000 + 300);

    state.timers.add(finish);
  }

  function updatePlaybackTrack(trackName, line) {
    document.querySelectorAll("[data-track-state]").forEach(element => {
      const active = element.dataset.trackState === trackName;
      element.classList.toggle("playing", active);
      element.textContent = active ? `▶ line ${line}` : "idle";
    });
  }

  function stopPlayback() {
    for (const timer of state.timers) {
      clearTimeout(timer);
    }

    state.timers.clear();

    for (const node of state.audioNodes) {
      try {
        node.stop();
      } catch (_) {
        // The node may already be stopped.
      }
    }

    state.audioNodes.clear();

    if (state.audioContext) {
      state.audioContext.close().catch(() => {});
      state.audioContext = null;
    }

    state.playing = false;

    if (DOM.playButton) DOM.playButton.disabled = false;
    if (DOM.stopButton) DOM.stopButton.disabled = true;

    document.querySelectorAll("[data-track-state]").forEach(element => {
      element.classList.remove("playing");
      element.textContent = "idle";
    });

    setStatus("Ready", state.dirty);
    log("Stopped", "info");
  }

  // ============================================================
  // Plugins
  // ============================================================

  function loadPluginFile(file) {
    const reader = new FileReader();

    reader.onload = () => {
      const name = file.name.replace(/\.js$/i, "");

      if (!/^[A-Za-z0-9_]+$/.test(name)) {
        reportError(new SWSError(
          1,
          "ValueError",
          `invalid plugin name: ${name}`
        ));
        return;
      }

      state.plugins.set(name, String(reader.result || ""));

      if (DOM.pluginList) {
        const item = document.createElement("div");
        item.textContent = `${name} loaded`;
        DOM.pluginList.appendChild(item);
      }

      log(`Plugin loaded: ${name}`, "success");
    };

    reader.onerror = () => {
      reportError(new SWSError(
        1,
        "FileError",
        "failed to read plugin"
      ));
    };

    reader.readAsText(file);
  }

  function runPlugins(project) {
    for (const request of project.plugins) {
      const source = state.plugins.get(request.name);
      if (!source) continue;

      try {
        const plugin = new Function(
          "SWS",
          `"use strict";\n${source}`
        );

        plugin(clone(project.toPluginData()));
        log(`Plugin executed: ${request.name}`, "success");
      } catch (error) {
        reportError(new SWSError(
          request.line,
          "RuntimeError",
          `plugin '${request.name}' failed: ${error.message || error}`
        ));
      }
    }
  }

  // ============================================================
  // Events and initialization
  // ============================================================

  function bindEditorEvents() {
    if (!DOM.codeEditor) return;

    DOM.codeEditor.addEventListener("input", () => {
      state.dirty = true;
      setStatus("Modified", true);
      refreshEditor();
    });

    DOM.codeEditor.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;

      event.preventDefault();

      const start = DOM.codeEditor.selectionStart;
      const end = DOM.codeEditor.selectionEnd;
      const value = DOM.codeEditor.value;

      DOM.codeEditor.value =
        value.slice(0, start) +
        "  " +
        value.slice(end);

      DOM.codeEditor.selectionStart = start + 2;
      DOM.codeEditor.selectionEnd = start + 2;

      state.dirty = true;
      setStatus("Modified", true);
      refreshEditor();
    });

    DOM.editorScroll?.addEventListener(
      "scroll",
      syncEditorScroll
    );
  }

  function bindToolbarEvents() {
    DOM.openButton?.addEventListener("click", () => {
      DOM.fileInput?.click();
    });

    DOM.fileInput?.addEventListener("change", event => {
      const file = event.target.files?.[0];
      if (file) openFile(file);
      event.target.value = "";
    });

    DOM.saveButton?.addEventListener("click", saveSs);
    DOM.compileButton?.addEventListener("click", compileCurrent);

    DOM.playButton?.addEventListener("click", () => {
      playProject(state.project || compileCurrent());
    });

    DOM.stopButton?.addEventListener("click", stopPlayback);

    DOM.midiButton?.addEventListener("click", () => {
      exportMidi(state.project || compileCurrent());
    });

    DOM.wavButton?.addEventListener("click", () => {
      exportWav(state.project || compileCurrent());
    });

    DOM.ustButton?.addEventListener("click", () => {
      exportUst(state.project || compileCurrent());
    });

    DOM.exportMidiButton?.addEventListener("click", () => {
      exportMidi(state.project || compileCurrent());
    });

    DOM.exportWavButton?.addEventListener("click", () => {
      exportWav(state.project || compileCurrent());
    });

    DOM.exportUstButton?.addEventListener("click", () => {
      exportUst(state.project || compileCurrent());
    });

    DOM.exportSsButton?.addEventListener("click", saveSs);

    DOM.clearConsoleButton?.addEventListener("click", () => {
      DOM.consoleOutput?.replaceChildren();
      clearError();
    });

    DOM.themeToggle?.addEventListener("click", event => {
      document.body.classList.toggle("light");
      event.currentTarget.textContent =
        document.body.classList.contains("light")
          ? "☾ Dark"
          : "☀ Light";
    });

    DOM.pluginButton?.addEventListener("click", () => {
      DOM.pluginModal?.classList.add("active");
    });

    DOM.pluginModalClose?.addEventListener("click", () => {
      DOM.pluginModal?.classList.remove("active");
    });

    DOM.loadPluginButton?.addEventListener("click", () => {
      DOM.pluginFileInput?.click();
    });

    DOM.pluginFileInput?.addEventListener("change", event => {
      const file = event.target.files?.[0];
      if (file) loadPluginFile(file);
      event.target.value = "";
    });
  }

  function initializeEditor() {
    if (!DOM.codeEditor) return;

    if (!DOM.codeEditor.value.trim()) {
      DOM.codeEditor.value = [
        'tempoconst="120";',
        'key="C";',
        "",
        'snd("piano",4,C4);',
        'snd("piano",4,E4);',
        'snd("piano",4,G4);'
      ].join("\n");
    }

    refreshEditor();
  }

  function initialize() {
    initDom();
    initializeEditor();
    bindEditorEvents();
    bindToolbarEvents();

    const project = compileSource(
      DOM.codeEditor?.value || "",
      true
    );

    if (project) {
      renderTracks(project);
      log("SWS Web Console ready", "info");
    }
  }

  globalThis.SWSJS = {
    SWSError,
    NoteData,
    SoundEvent,
    Track,
    TempoMap,
    Project,
    Compiler,
    scanStructure,
    compileCurrent,
    exportMidi,
    exportWav,
    exportUst,
    saveSs,
    playProject,
    stopPlayback,
    ustToSs,
    state
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, {
      once: true
    });
  } else {
    initialize();
  }
})();
