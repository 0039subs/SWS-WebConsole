/**
 * SWS Web Core - Sound Wav Script JavaScript Core
 * v0.1
 */

// ============================================================
// CONFIGURATION
// ============================================================

const SWS_CONFIG = {
    DEFAULT_TEMPO: 120.0,
    DEFAULT_KEY: "C",
    DEFAULT_INSTRUMENT: "synth",
    SAMPLE_RATE: 44100,
    DEFAULT_UST_INSTRUMENT: "synth",
    COLORS: [
        { name: "Blue", hex: "#2196F3" },
        { name: "Red", hex: "#F44336" },
        { name: "Green", hex: "#4CAF50" },
        { name: "Purple", hex: "#9C27B0" },
        { name: "Orange", hex: "#FF9800" },
        { name: "Cyan", hex: "#00BCD4" },
        { name: "Pink", hex: "#E91E63" },
        { name: "Yellow", hex: "#FFC107" },
    ]
};

// ============================================================
// NOTES & KEY SCALES
// ============================================================

const NOTE_TABLE = {
    "C": 0, "C#": 1, "Db": 1,
    "D": 2, "D#": 3, "Eb": 3,
    "E": 4, "F": 5, "F#": 6,
    "Gb": 6, "G": 7, "G#": 8,
    "Ab": 8, "A": 9, "A#": 10,
    "Bb": 10, "B": 11,
};

const KEY_SCALES = {
    "C": [0, 2, 4, 5, 7, 9, 11],
    "G": [7, 9, 11, 0, 2, 4, 6],
    "D": [2, 4, 6, 7, 9, 11, 1],
    "A": [9, 11, 1, 2, 4, 6, 8],
    "E": [4, 6, 8, 9, 11, 1, 3],
    "B": [11, 1, 3, 4, 6, 8, 10],
    "F#": [6, 8, 10, 11, 1, 3, 5],
    "F": [5, 7, 9, 10, 0, 2, 4],
    "Bb": [10, 0, 2, 3, 5, 7, 9],
    "Eb": [3, 5, 7, 8, 10, 0, 2],
    "Ab": [8, 10, 0, 1, 3, 5, 7],
    "Db": [1, 3, 5, 6, 8, 10, 0],
    "Am": [9, 11, 0, 2, 4, 5, 7],
    "Em": [4, 5, 7, 9, 11, 0, 2],
    "Bm": [11, 0, 2, 4, 6, 7, 9],
    "F#m": [6, 7, 9, 11, 1, 3, 5],
    "C#m": [1, 2, 4, 6, 8, 9, 11],
    "G#m": [8, 9, 11, 1, 3, 5, 7],
    "Dm": [2, 3, 5, 7, 9, 10, 0],
    "Gm": [7, 8, 10, 0, 2, 3, 5],
    "Cm": [0, 1, 3, 5, 7, 8, 10],
    "Fm": [5, 6, 8, 10, 0, 1, 3],
};

const VALID_INSTRUMENTS = {
    "piano": true, "grand_piano": true,
    "synth": true, "synth_lead": true, "synth_bass": true,
    "bass": true,
    "drum": true, "kick": true, "hihat": true, "hi_hat": true, "snare": true,
    "sine": true, "square": true, "triangle": true, "saw": true, "sawtooth": true,
    "null": true
};

// ============================================================
// NOTE DATA
// ============================================================

class NoteData {
    constructor(pitch, slur = false, keyBypass = false, lyric = null, key = "C") {
        this.pitch = pitch;
        this.slur = slur;
        this.keyBypass = keyBypass;
        this.lyric = lyric;
        this.key = key;
    }
}

// ============================================================
// SOUND EVENT
// ============================================================

class SoundEvent {
    constructor(instrument, start, duration, notes, line, className = null) {
        this.instrument = instrument;
        this.start = start;
        this.duration = duration;
        this.notes = notes;
        this.line = line;
        this.className = className;
    }

    get end() {
        return this.start + this.duration;
    }
}

// ============================================================
// TEMPO MAP
// ============================================================

class TempoMap {
    constructor(initialTempo = 120.0) {
        if (initialTempo <= 0 || !isFinite(initialTempo)) {
            throw new Error("tempo must be greater than 0 and finite");
        }
        this.segments = [[0.0, initialTempo]];
        this.tempoConstSet = true;
    }

    setTempoConst(tempo) {
        if (!this.tempoConstSet) {
            throw new Error("tempoconst can only be set once");
        }
        if (tempo <= 0 || !isFinite(tempo)) {
            throw new Error("tempo must be greater than 0 and finite");
        }
        this.segments = [[0.0, tempo]];
        this.tempoConstSet = false;
    }

    setTempo(beatPosition, tempo) {
        if (tempo <= 0 || !isFinite(tempo)) {
            throw new Error("tempo must be greater than 0 and finite");
        }
        this.segments = this.segments.filter(([b, t]) => b !== beatPosition);
        this.segments.push([beatPosition, tempo]);
        this.segments.sort((a, b) => a[0] - b[0]);
    }

    beatToSeconds(beatPosition) {
        if (beatPosition < 0) return 0.0;

        let totalSeconds = 0.0;

        for (let i = 0; i < this.segments.length; i++) {
            const [segmentBeat, tempo] = this.segments[i];

            if (beatPosition <= segmentBeat) break;

            let beatsInSegment;
            if (i + 1 < this.segments.length) {
                const nextBeat = this.segments[i + 1][0];
                beatsInSegment = Math.min(nextBeat - segmentBeat, beatPosition - segmentBeat);
            } else {
                beatsInSegment = beatPosition - segmentBeat;
            }

            const secondsInSegment = (beatsInSegment * 60.0) / tempo;
            totalSeconds += secondsInSegment;
        }

        return totalSeconds;
    }

    getCurrentTempo(beatPosition) {
        for (let i = this.segments.length - 1; i >= 0; i--) {
            const [segBeat, tempo] = this.segments[i];
            if (beatPosition >= segBeat) return tempo;
        }
        return this.segments[0][1];
    }
}

// ============================================================
// NOTE UTILITIES
// ============================================================

function noteToMidi(note, key = "C", bypass = false) {
    const match = note.trim().match(/([A-Ga-g](?:#|b)?)(-?\d+)/);
    if (!match) throw new Error(`invalid pitch: ${note}`);

    let name = match[1];
    const octave = parseInt(match[2]);
    name = name[0].toUpperCase() + (name.length > 1 ? name[1] : "");

    if (!NOTE_TABLE.hasOwnProperty(name)) {
        throw new Error(`invalid pitch: ${note}`);
    }

    const baseMidi = NOTE_TABLE[name];
    let midiValue = (octave + 1) * 12 + baseMidi;

    if (!bypass && KEY_SCALES[key]) {
        const scale = KEY_SCALES[key];
        const semitoneInOctave = baseMidi % 12;

        if (!scale.includes(semitoneInOctave)) {
            const bestNote = scale.reduce((prev, curr) =>
                Math.abs(curr - semitoneInOctave) < Math.abs(prev - semitoneInOctave) ? curr : prev
            );
            midiValue = (octave + 1) * 12 + bestNote;
        }
    }

    if (midiValue < 0 || midiValue > 127) {
        throw new Error(`pitch out of MIDI range: ${note}`);
    }

    return midiValue;
}

function midiToNote(midiNum) {
    const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const octave = Math.floor(midiNum / 12) - 1;
    const note = noteNames[midiNum % 12];
    return `${note}${octave}`;
}

function midiToFrequency(midi) {
    return 440.0 * Math.pow(2.0, (midi - 69) / 12.0);
}

function lengthToBeats(value) {
    const str = value.toString().trim();
    const dotted = str.endsWith("+");
    const denominator = parseInt(dotted ? str.slice(0, -1) : str);

    if (isNaN(denominator) || denominator <= 0) {
        throw new Error(`invalid note length: ${value}`);
    }

    let beats = 4.0 / denominator;
    if (dotted) beats *= 1.5;

    return beats;
}

function ustLengthToBeats(ustLength) {
    const length = parseInt(ustLength);
    if (isNaN(length) || length <= 0) {
        throw new Error(`invalid UST Length: ${ustLength}`);
    }
    return length / 480.0;
}

// ============================================================
// SWS PARSER
// ============================================================

class SWSParser {
    constructor() {
        this.tempoMap = new TempoMap(SWS_CONFIG.DEFAULT_TEMPO);
        this.events = [];
        this.mainCursor = 0.0;
        this.trackCursors = {};
        this.chips = {};
        this.chipsLine = {};
        this.key = SWS_CONFIG.DEFAULT_KEY;
        this.recursionStack = new Set();
        this.tempoConstCount = 0;
    }

    parse(code) {
        const lines = code.split('\n').map((line, idx) => ({
            number: idx + 1,
            text: this.removeComments(line, idx + 1)
        })).filter(line => line.text.trim());

        this.compileLines(lines);
        return this.events;
    }

    removeComments(line, lineNumber) {
        let result = "";
        let inString = false;
        let i = 0;

        while (i < line.length) {
            const char = line[i];

            if (char === '"') {
                inString = !inString;
                result += char;
                i++;
                continue;
            }

            if (!inString && char === "<") {
                i++;
                let foundClose = false;
                while (i < line.length) {
                    if (line[i] === "<") {
                        throw new Error(`line ${lineNumber}: comment nesting not allowed`);
                    }
                    if (line[i] === ">") {
                        foundClose = true;
                        i++;
                        break;
                    }
                    i++;
                }
                if (!foundClose) {
                    throw new Error(`line ${lineNumber}: unclosed comment`);
                }
                continue;
            }

            result += char;
            i++;
        }

        return result.trim();
    }

    compileLines(lines) {
        let i = 0;

        while (i < lines.length) {
            const { number: lineNumber, text: line } = lines[i];
            const stripped = line.trim();

            if (!stripped) {
                i++;
                continue;
            }

            // tempoconst
            let match = stripped.match(/tempoconst\s*=\s*"([^"]+)"\s*;/);
            if (match) {
                this.tempoConstCount++;
                if (this.tempoConstCount > 1) {
                    throw new Error(`line ${lineNumber}: tempoconst can only be set once`);
                }
                const tempo = parseFloat(match[1]);
                if (isNaN(tempo) || tempo <= 0 || !isFinite(tempo)) {
                    throw new Error(`line ${lineNumber}: invalid tempo`);
                }
                if (tempo > 500) {
                    throw new Error(`line ${lineNumber}: tempo too high (max 500 BPM)`);
                }
                this.tempoMap.setTempoConst(tempo);
                i++;
                continue;
            }

            // newtempo
            match = stripped.match(/newtempo\s*=\s*"([^"]+)"\s*;/);
            if (match) {
                const tempo = parseFloat(match[1]);
                if (isNaN(tempo) || tempo <= 0 || !isFinite(tempo)) {
                    throw new Error(`line ${lineNumber}: invalid tempo`);
                }
                if (tempo > 500) {
                    throw new Error(`line ${lineNumber}: tempo too high (max 500 BPM)`);
                }
                this.tempoMap.setTempo(this.mainCursor, tempo);
                i++;
                continue;
            }

            // key
            match = stripped.match(/key\s*=\s*"([^"]+)"\s*;/);
            if (match) {
                const keyName = match[1];
                if (!KEY_SCALES[keyName]) {
                    throw new Error(`line ${lineNumber}: invalid key: ${keyName}`);
                }
                this.key = keyName;
                i++;
                continue;
            }

            // chips declaration
            match = stripped.match(/chips\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{/);
            if (match) {
                const name = match[1];
                if (this.chips[name]) {
                    throw new Error(`line ${lineNumber}: chips '${name}' already declared at line ${this.chipsLine[name]}`);
                }

                const block = [];
                let depth = 1;
                i++;

                while (i < lines.length) {
                    const n = lines[i].number;
                    const l = lines[i].text.trim();

                    if (l.endsWith("{")) depth++;
                    if (l === "}") {
                        depth--;
                        if (depth === 0) break;
                    }

                    block.push(lines[i]);
                    i++;
                }

                if (depth !== 0) {
                    throw new Error(`line ${lineNumber}: chips block not closed`);
                }

                this.chips[name] = block;
                this.chipsLine[name] = lineNumber;
                i++;
                continue;
            }

            // lp
            match = stripped.match(/lp\s*\(\s*(\d+)\s*\)\s*\{/);
            if (match) {
                const count = parseInt(match[1]);
                if (count <= 0 || count > 10000) {
                    throw new Error(`line ${lineNumber}: invalid lp count`);
                }

                const block = [];
                let depth = 1;
                i++;

                while (i < lines.length) {
                    const n = lines[i].number;
                    const l = lines[i].text.trim();

                    if (l.endsWith("{")) depth++;
                    if (l === "}") {
                        depth--;
                        if (depth === 0) break;
                    }

                    block.push(lines[i]);
                    i++;
                }

                if (depth !== 0) {
                    throw new Error(`line ${lineNumber}: lp block not closed`);
                }

                for (let _ = 0; _ < count; _++) {
                    this.compileLines(block);
                }

                i++;
                continue;
            }

            // chips call
            match = stripped.match(/chips\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*;/);
            if (match) {
                const name = match[1];
                if (!this.chips[name]) {
                    throw new Error(`line ${lineNumber}: chips '${name}' not declared yet`);
                }
                if (this.recursionStack.has(name)) {
                    throw new Error(`line ${lineNumber}: circular dependency in chips '${name}'`);
                }

                this.recursionStack.add(name);
                try {
                    this.compileLines(this.chips[name]);
                } finally {
                    this.recursionStack.delete(name);
                }

                i++;
                continue;
            }

            // sleep
            match = stripped.match(/sleep\s*\(\s*([0-9]+\+?)\s*\)\s*;/);
            if (match) {
                const beats = lengthToBeats(match[1]);
                this.mainCursor += beats;
                i++;
                continue;
            }

            // snd
            if (stripped.startsWith("snd(")) {
                if (!stripped.endsWith(";")) {
                    throw new Error(`line ${lineNumber}: missing ';'`);
                }
                this.compileSndExpression(lineNumber, stripped.slice(0, -1).trim());
                i++;
                continue;
            }

            throw new Error(`line ${lineNumber}: unknown statement: ${stripped}`);
        }

        return this.events;
    }

    compileSndExpression(lineNumber, expression) {
        const parts = this.safeSplitCnt(expression);

        if (parts.length === 1) {
            const event = this.parseSnd(lineNumber, parts[0]);
            this.events.push(event);

            if (event.className === null) {
                this.mainCursor = event.end;
            } else {
                this.trackCursors[event.className] = event.end;
            }
            return;
        }

        // cnt group
        const cntGroup = [];
        for (const part of parts) {
            const event = this.parseSnd(lineNumber, part);
            cntGroup.push(event);
        }

        this.events.push(...cntGroup);

        // Update cursors
        const classEnds = {};
        let mainEnd = null;

        for (const event of cntGroup) {
            if (event.className === null) {
                mainEnd = mainEnd === null ? event.end : Math.max(mainEnd, event.end);
            } else {
                if (!classEnds[event.className]) {
                    classEnds[event.className] = event.end;
                } else {
                    classEnds[event.className] = Math.max(classEnds[event.className], event.end);
                }
            }
        }

        if (mainEnd !== null) this.mainCursor = mainEnd;

        for (const [className, endPos] of Object.entries(classEnds)) {
            this.trackCursors[className] = endPos;
        }
    }

    safeSplitCnt(text) {
        const result = [];
        let current = "";
        let bracketDepth = 0;
        let inQuote = false;
        let i = 0;

        while (i < text.length) {
            const char = text[i];

            if (char === '"' && (i === 0 || text[i - 1] !== '\\')) {
                inQuote = !inQuote;
                current += char;
                i++;
                continue;
            }

            if (!inQuote) {
                if (char === '[') bracketDepth++;
                else if (char === ']') bracketDepth--;

                if (text.substr(i, 6) === "-cnt-" && bracketDepth === 0) {
                    if (current.trim()) result.push(current.trim());
                    current = "";
                    i += 6;
                    continue;
                }
            }

            current += char;
            i++;
        }

        if (current.trim()) result.push(current.trim());
        return result;
    }

    parseSnd(lineNumber, expression) {
        if (!expression.startsWith("snd(") || !expression.endsWith(")")) {
            throw new Error(`line ${lineNumber}: invalid snd()`);
        }

        const inside = expression.slice(4, -1);
        const args = this.splitArguments(inside);

        if (args.length < 3) {
            throw new Error(`line ${lineNumber}: snd() requires at least 3 arguments`);
        }

        // instrument
        let match = args[0].trim().match(/"([^"]+)"/);
        if (!match) {
            throw new Error(`line ${lineNumber}: instrument must be "name"`);
        }
        const instrument = match[1].toLowerCase();
        if (!VALID_INSTRUMENTS[instrument]) {
            throw new Error(`line ${lineNumber}: unknown instrument: ${instrument}`);
        }

        // duration
        const duration = lengthToBeats(args[1]);

        // pitch
        const pitchArg = args[2].trim();
        let notes = [];

        if (pitchArg === "null") {
            notes = [];
        } else if (pitchArg.startsWith("fsn=")) {
            const value = pitchArg.slice(4).trim();
            if (!value.startsWith("[") || !value.endsWith("]")) {
                throw new Error(`line ${lineNumber}: invalid fsn`);
            }

            const content = value.slice(1, -1).trim();
            if (!content) {
                throw new Error(`line ${lineNumber}: fsn cannot be empty`);
            }

            const rawNotes = content.split(",").map(n => n.trim());
            if (rawNotes.length > 128) {
                throw new Error(`line ${lineNumber}: fsn has too many notes (max 128)`);
            }

            for (const rawNote of rawNotes) {
                if (rawNote === "null") {
                    throw new Error(`line ${lineNumber}: null not allowed in fsn`);
                }
                notes.push(this.parseNote(rawNote, lineNumber));
            }
        } else {
            notes.push(this.parseNote(pitchArg, lineNumber));
        }

        // attributes
        let className = null;
        let lyric = null;
        const seenAttrs = new Set();

        for (let i = 3; i < args.length; i++) {
            const arg = args[i];
            if (!arg.includes("=")) {
                throw new Error(`line ${lineNumber}: invalid attribute: ${arg}`);
            }

            const [attrName, attrValue] = arg.split("=", 2).map(s => s.trim());

            if (seenAttrs.has(attrName)) {
                throw new Error(`line ${lineNumber}: duplicate attribute: ${attrName}`);
            }
            seenAttrs.add(attrName);

            if (attrName === "class") {
                match = attrValue.match(/"([^"]*)"/);
                if (!match) {
                    throw new Error(`line ${lineNumber}: class must be "name"`);
                }
                className = match[1];
                if (!className) {
                    throw new Error(`line ${lineNumber}: class name cannot be empty`);
                }
            } else if (attrName === "Lyric") {
                match = attrValue.match(/"([^"]*)"/);
                if (!match) {
                    throw new Error(`line ${lineNumber}: Lyric must be "text"`);
                }
                lyric = match[1];
            } else {
                throw new Error(`line ${lineNumber}: unknown attribute: ${attrName}`);
            }
        }

        // Apply lyric
        if (lyric !== null) {
            for (const note of notes) {
                if (note instanceof NoteData) {
                    note.lyric = lyric;
                }
            }
        }

        // Determine start position
        let start;
        if (className !== null) {
            if (!this.trackCursors[className]) {
                this.trackCursors[className] = this.mainCursor;
            }
            start = this.trackCursors[className];
        } else {
            start = this.mainCursor;
        }

        return new SoundEvent(instrument, start, duration, notes, lineNumber, className);
    }

    parseNote(rawNote, lineNumber) {
        let note = rawNote;
        let slur = false;
        let keyBypass = false;

        if (note.endsWith("~!") || note.endsWith("!~")) {
            slur = true;
            keyBypass = true;
            note = note.slice(0, -2);
        } else if (note.endsWith("~")) {
            slur = true;
            note = note.slice(0, -1);
        } else if (note.endsWith("!")) {
            keyBypass = true;
            note = note.slice(0, -1);
        }

        if (note !== "null") {
            try {
                noteToMidi(note, this.key, keyBypass);
            } catch (e) {
                throw new Error(`line ${lineNumber}: ${e.message}`);
            }
        }

        return new NoteData(note, slur, keyBypass, null, this.key);
    }

    splitArguments(text) {
        const result = [];
        let current = "";
        let bracketDepth = 0;
        let parenDepth = 0;
        let inQuote = false;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            if (char === '"' && (i === 0 || text[i - 1] !== '\\')) {
                inQuote = !inQuote;
                current += char;
                continue;
            }

            if (!inQuote) {
                if (char === "[") bracketDepth++;
                else if (char === "]") bracketDepth--;
                else if (char === "(") parenDepth++;
                else if (char === ")") parenDepth--;

                if (char === "," && bracketDepth === 0 && parenDepth === 0) {
                    if (current.trim()) result.push(current.trim());
                    current = "";
                    continue;
                }
            }

            current += char;
        }

        if (current.trim()) result.push(current.trim());
        return result;
    }
}

// ============================================================
// UST PARSER
// ============================================================

class USTParser {
    parse(content) {
        const events = [];
        let currentBeat = 0.0;
        let tempo = SWS_CONFIG.DEFAULT_TEMPO;

        const lines = content.split('\n').map(l => l.trim()).filter(l => l);
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];

            if (line === "[#SETTING]") {
                i++;
                while (i < lines.length && !lines[i].startsWith("[")) {
                    const settingLine = lines[i];
                    if (settingLine.startsWith("Tempo=")) {
                        tempo = parseFloat(settingLine.split("=")[1]);
                    }
                    i++;
                }
                continue;
            }

            if (line.startsWith("[#NOTE")) {
                i++;
                const noteData = {};

                while (i < lines.length && !lines[i].startsWith("[")) {
                    const dataLine = lines[i];
                    if (dataLine.includes("=")) {
                        const [key, value] = dataLine.split("=", 2);
                        noteData[key] = value;
                    }
                    i++;
                }

                try {
                    this.processNote(noteData, events, currentBeat);
                    const length = parseInt(noteData.Length || "480");
                    currentBeat += length / 480.0;
                } catch (e) {
                    throw new Error(`UST parse error: ${e.message}`);
                }
                continue;
            }

            if (line === "[#TRACKEND]") {
                break;
            }

            i++;
        }

        return { events, tempo };
    }

    processNote(noteData, events, currentBeat) {
        const lyric = (noteData.Lyric || "").trim();
        const noteNum = parseInt(noteData.NoteNum || "60");
        const length = parseInt(noteData.Length || "480");

        if (isNaN(noteNum) || noteNum < 0 || noteNum > 127) {
            throw new Error(`invalid NoteNum: ${noteNum}`);
        }

        if (isNaN(length) || length <= 0) {
            throw new Error(`invalid Length: ${length}`);
        }

        const beats = length / 480.0;
        const isRest = lyric.toUpperCase() === "R";

        let instrument, notes;

        if (isRest) {
            instrument = "null";
            notes = [];
        } else {
            instrument = SWS_CONFIG.DEFAULT_UST_INSTRUMENT;
            const pitch = midiToNote(noteNum);
            const noteData = new NoteData(pitch, false, true, lyric || null, "C");
            notes = [noteData];
        }

        const event = new SoundEvent(
            instrument,
            currentBeat,
            beats,
            notes,
            1,
            "main"
        );

        events.push(event);
    }
}

// ============================================================
// CLASS DETECTOR
// ============================================================

class ClassDetector {
    static detect(code) {
        const classSet = new Set(["main"]);
        const classMatches = code.matchAll(/class\s*=\s*"([^"]+)"/g);

        for (const match of classMatches) {
            const className = match[1];
            if (className) classSet.add(className);
        }

        return Array.from(classSet).sort();
    }

    static getClassLines(code, className) {
        const lines = code.split('\n');
        const lineNumbers = [];

        if (className === "main") {
            // Lines without class attribute
            lines.forEach((line, idx) => {
                if (line.includes('snd(') && !line.includes('class=')) {
                    lineNumbers.push(idx);
                }
            });
        } else {
            // Lines with specific class
            lines.forEach((line, idx) => {
                if (line.includes(`class="${className}"`)) {
                    lineNumbers.push(idx);
                }
            });
        }

        return lineNumbers;
    }
}

// ============================================================
// WEB AUDIO RENDERER
// ============================================================

class WebAudioRenderer {
    constructor() {
        this.audioContext = null;
        this.isPlaying = false;
        this.currentTime = 0;
        this.playbackStartTime = 0;
        this.scheduledNotes = [];
        this.playStartCallback = null;
        this.playEndCallback = null;
        this.lineCallback = null;
    }

    initialize() {
        if (!this.audioContext) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioContext();
        }
        return this.audioContext;
    }

    stop() {
        if (this.isPlaying) {
            this.isPlaying = false;
            for (const note of this.scheduledNotes) {
                if (note.oscillator) note.oscillator.stop();
                if (note.gainNode) note.gainNode.disconnect();
            }
            this.scheduledNotes = [];
        }
    }

    play(events, tempoMap, onLine) {
        this.initialize();
        this.stop();

        if (!events || events.length === 0) {
            throw new Error("No events to play");
        }

        this.isPlaying = true;
        this.playbackStartTime = this.audioContext.currentTime;
        this.lineCallback = onLine;

        const totalBeats = Math.max(...events.map(e => e.end));
        const totalSeconds = tempoMap.beatToSeconds(totalBeats);

        // Schedule all events
        for (const event of events) {
            if (!event.notes || event.notes.length === 0) continue;

            const startSeconds = tempoMap.beatToSeconds(event.start);
            const endSeconds = tempoMap.beatToSeconds(event.end);
            const durationSeconds = endSeconds - startSeconds;

            if (durationSeconds <= 0) continue;

            for (const note of event.notes) {
                if (note.pitch === "null") continue;

                try {
                    const midi = noteToMidi(note.pitch, note.key, note.keyBypass);
                    const frequency = midiToFrequency(midi);

                    this.scheduleNote(frequency, startSeconds, durationSeconds, event.instrument, event.line);
                } catch (e) {
                    console.warn(`Failed to play note: ${e.message}`);
                }
            }
        }

        // Schedule end callback
        setTimeout(() => {
            if (this.isPlaying) {
                this.isPlaying = false;
                if (this.playEndCallback) this.playEndCallback();
            }
        }, totalSeconds * 1000);

        // Monitor playback progress
        this.monitorPlayback(events, tempoMap);
    }

    scheduleNote(frequency, startTime, duration, instrument, line) {
        const scheduleTime = this.playbackStartTime + startTime;

        setTimeout(() => {
            if (!this.isPlaying) return;

            const now = this.audioContext.currentTime;
            const osc = this.audioContext.createOscillator();
            const gain = this.audioContext.createGain();

            osc.connect(gain);
            gain.connect(this.audioContext.destination);

            osc.frequency.value = frequency;
            osc.type = this.getOscillatorType(instrument);

            // Envelope
            const attack = Math.min(0.02, duration * 0.15);
            const release = Math.min(0.1, duration * 0.25);

            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(0.3, now + attack);
            gain.gain.setValueAtTime(0.3, now + duration - release);
            gain.gain.linearRampToValueAtTime(0, now + duration);

            osc.start(now);
            osc.stop(now + duration);

            this.scheduledNotes.push({ oscillator: osc, gainNode: gain });
        }, (startTime - (this.audioContext.currentTime - this.playbackStartTime)) * 1000);
    }

    getOscillatorType(instrument) {
        const type = instrument.toLowerCase();
        if (type.includes("sine")) return "sine";
        if (type.includes("square")) return "square";
        if (type.includes("triangle")) return "triangle";
        if (type.includes("saw")) return "sawtooth";
        return "sine";
    }

    monitorPlayback(events, tempoMap) {
        const updateInterval = setInterval(() => {
            if (!this.isPlaying) {
                clearInterval(updateInterval);
                return;
            }

            const elapsedTime = this.audioContext.currentTime - this.playbackStartTime;

            // Find current event
            for (const event of events) {
                const startTime = tempoMap.beatToSeconds(event.start);
                const endTime = tempoMap.beatToSeconds(event.end);

                if (elapsedTime >= startTime && elapsedTime < endTime) {
                    if (this.lineCallback) {
                        this.lineCallback(event.line);
                    }
                    break;
                }
            }
        }, 50);
    }
}

// ============================================================
// EXPORTS
// ============================================================

window.SWSParser = SWSParser;
window.USTParser = USTParser;
window.ClassDetector = ClassDetector;
window.WebAudioRenderer = WebAudioRenderer;
window.SoundEvent = SoundEvent;
window.NoteData = NoteData;
window.TempoMap = TempoMap;