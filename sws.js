/**
 * SWS Web Console - Main Controller (fixed)
 * - Ensure AudioContext is created after user gesture and resumed
 * - Schedule oscillators using AudioContext.currentTime (accurate even when tab inactive)
 * - Robust console logging with DOM fallback
 * - Improved parsing for snd/tempoconst/sleep and attribute handling
 */

class SWSWebConsole {
    constructor() {
        this.currentCode = '';
        this.currentFile = null;
        this.classes = ['main'];
        this.selectedClass = null;
        this.playingLine = null;
        this.audioContext = null;
        this.isPlaying = false;
        this.scheduledTimers = [];

        this.initializeUI();
        this.setupEventListeners();
        this.loadInitialCode();
    }

    initializeUI() {
        this.elements = {
            openBtn: document.getElementById('openBtn'),
            saveBtn: document.getElementById('saveBtn'),
            playBtn: document.getElementById('playBtn'),
            stopBtn: document.getElementById('stopBtn'),
            fileInput: document.getElementById('fileInput'),
            codeEditor: document.getElementById('codeEditor'),
            highlightOverlay: document.getElementById('highlightOverlay'),
            lineNumbers: document.getElementById('lineNumbers'),
            classList: document.getElementById('classList'),
            consoleOutput: document.getElementById('consoleOutput'),
        };
    }

    setupEventListeners() {
        this.elements.openBtn.addEventListener('click', () => this.handleOpen());
        this.elements.saveBtn.addEventListener('click', () => this.handleSave());
        this.elements.playBtn.addEventListener('click', () => this.handlePlay());
        this.elements.stopBtn.addEventListener('click', () => this.handleStop());
        this.elements.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        this.elements.codeEditor.addEventListener('input', () => this.handleCodeChange());
        this.elements.codeEditor.addEventListener('scroll', () => this.syncScroll());
    }

    loadInitialCode() {
        const initialCode = `tempoconst="120";
key="C";

snd("piano",4,C4,class="melody");
snd("piano",4,E4,class="melody");
snd("bass",4,C2,class="bass");
snd("piano",4,G4);`;

        this.currentCode = initialCode;
        this.elements.codeEditor.value = this.currentCode;
        this.handleCodeChange();
        this.consoleLog('Ready.', 'info');
    }

    handleOpen() { this.elements.fileInput.click(); }

    handleFileSelect(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            this.currentCode = e.target.result;
            this.currentFile = file.name;
            this.elements.codeEditor.value = this.currentCode;
            this.handleCodeChange();
            this.consoleLog(`Loaded: ${file.name}`, 'success');
        };
        reader.onerror = () => this.consoleLog('Failed to read file', 'error');
        reader.readAsText(file);
    }

    handleSave() {
        const code = this.elements.codeEditor.value;
        const filename = this.currentFile || 'untitled.ss';
        const blob = new Blob([code], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        this.consoleLog(`Saved: ${filename}`, 'success');
    }

    async handlePlay() {
        try {
            this.currentCode = this.elements.codeEditor.value;
            if (!this.currentCode.trim()) { this.consoleLog('No code to play', 'warning'); return; }

            // Ensure AudioContext exists and is resumed on user gesture
            if (!this.audioContext) {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (!AudioContext) {
                    this.consoleLog('Web Audio API not supported in this browser', 'error');
                    return;
                }
                this.audioContext = new AudioContext();
            }

            if (this.audioContext.state === 'suspended') {
                try { await this.audioContext.resume(); } catch (e) { /* ignore */ }
            }

            this.elements.playBtn.disabled = true;
            this.elements.stopBtn.disabled = false;
            this.consoleLog('Playing...', 'info');

            this.playSWS();
        } catch (error) {
            this.consoleLog(`Play error: ${error.message}`, 'error');
            this.elements.playBtn.disabled = false;
            this.elements.stopBtn.disabled = true;
        }
    }

    handleStop() {
        this.elements.playBtn.disabled = false;
        this.elements.stopBtn.disabled = true;
        this.consoleLog('Stopped', 'info');
        this.clearPlayHighlight();
        this.stopPlayback();
    }

    playSWS() {
        try {
            this.isPlaying = true;
            // Clear any previously scheduled timers
            this.scheduledTimers.forEach(id => clearTimeout(id));
            this.scheduledTimers = [];

            const events = this.parseCode(this.currentCode);
            if (events.length === 0) { this.consoleLog('No events found', 'warning'); this.handleStop(); return; }
            this.consoleLog(`Found ${events.length} events`, 'info');

            // We'll schedule audio using AudioContext.currentTime
            const now = this.audioContext.currentTime;
            const startOffset = 0.05; // start slightly in future to ensure scheduling
            const baseTime = now + startOffset;

            // For UI highlighting we use setTimeout relative to Date.now()
            const startEpoch = Date.now() + Math.floor(startOffset * 1000);

            events.forEach((event) => {
                if (!this.isPlaying) return;

                const audioStart = baseTime + event.startTime;
                const audioEnd = audioStart + event.duration;

                // create oscillator and schedule start/stop
                const osc = this.audioContext.createOscillator();
                const gain = this.audioContext.createGain();
                osc.type = this.getOscillatorType(event.instrument);
                const midi = this.noteToMidi(event.pitch || 'C4');
                const freq = this.midiToFrequency(midi);
                osc.frequency.setValueAtTime(freq, audioStart);

                // envelope
                const attack = Math.min(0.02, event.duration * 0.15);
                const release = Math.min(0.1, event.duration * 0.25);
                gain.gain.setValueAtTime(0.0, audioStart);
                gain.gain.linearRampToValueAtTime(0.3, audioStart + attack);
                gain.gain.setValueAtTime(0.3, audioEnd - release);
                gain.gain.linearRampToValueAtTime(0.0, audioEnd);

                osc.connect(gain);
                gain.connect(this.audioContext.destination);

                try {
                    osc.start(audioStart);
                    osc.stop(audioEnd + 0.01);
                } catch (e) {
                    // Older browsers may throw if times are in the past
                    try { osc.start(); osc.stop(audioEnd + 0.01); } catch (e2) { /* ignore */ }
                }

                // Highlight line when note starts
                const msDelay = Math.max(0, Math.floor((audioStart - this.audioContext.currentTime) * 1000));
                const timerId = setTimeout(() => {
                    if (!this.isPlaying) return;
                    this.setPlayingLine(event.lineNumber);
                }, msDelay);
                this.scheduledTimers.push(timerId);

                // Clear highlight when note ends
                const endDelay = Math.max(0, Math.floor((audioEnd - this.audioContext.currentTime) * 1000));
                const endTimer = setTimeout(() => {
                    if (!this.isPlaying) return;
                    this.clearPlayHighlight();
                }, endDelay + 20);
                this.scheduledTimers.push(endTimer);
            });

            // Auto stop after max end
            const maxEnd = events.reduce((m, e) => Math.max(m, e.startTime + e.duration), 0);
            const stopTimer = setTimeout(() => { if (this.isPlaying) this.handleStop(); }, Math.floor((maxEnd + startOffset + 1) * 1000));
            this.scheduledTimers.push(stopTimer);

        } catch (error) {
            this.consoleLog(`Parse error: ${error.message}`, 'error');
            this.handleStop();
        }
    }

    parseCode(code) {
        // Returns events: {lineNumber, instrument, pitch, startTime (s), duration (s)}
        const events = [];
        const lines = code.split(/\r?\n/);
        let currentBeat = 0;
        let tempo = 120;

        const toSeconds = (beats) => (beats * 60) / tempo;

        const splitArgs = (text) => {
            const res = [];
            let cur = '';
            let depth = 0; let inQuote = false;
            for (let i=0;i<text.length;i++){
                const ch = text[i];
                if (ch === '"') { inQuote = !inQuote; cur += ch; continue; }
                if (!inQuote) {
                    if (ch === '[' || ch === '(') depth++;
                    else if (ch === ']' || ch === ')') depth--;
                    if (ch === ',' && depth === 0) { res.push(cur.trim()); cur = ''; continue; }
                }
                cur += ch;
            }
            if (cur.trim()!=='') res.push(cur.trim());
            return res;
        };

        for (let i=0;i<lines.length;i++){
            let raw = lines[i].trim();
            if (!raw) continue;
            if (raw.startsWith('<')) continue; // comment

            // tempoconst
            let m = raw.match(/tempoconst\s*=\s*"([\d.]+)"/);
            if (m) { tempo = parseFloat(m[1]) || tempo; continue; }

            // sleep
            m = raw.match(/sleep\s*\(\s*([0-9]+\+?)\s*\)\s*;?$/);
            if (m) {
                // convert length to beats: denominator notation
                const denom = m[1];
                let dotted = denom.endsWith('+');
                let d = parseInt(dotted ? denom.slice(0,-1) : denom,10);
                if (isNaN(d) || d<=0) continue;
                let beats = 4.0 / d; if (dotted) beats *= 1.5;
                currentBeat += beats;
                continue;
            }

            // snd(...)
            m = raw.match(/snd\s*\((.*)\)\s*;?$/);
            if (m) {
                const inside = m[1];
                const args = splitArgs(inside);
                if (args.length < 3) continue;
                const instrument = args[0].trim().replace(/^"|\"$/g,'').replace(/^"|"$/g,'').replace(/^"|"$/g,'').replace(/^"|"$/g,'').replace(/^"|"$/g,'').replace(/^"|"$/g,'').replace(/^"|"$/g,''); // safe strip
                const lengthArg = args[1].trim();
                const pitchArg = args[2].trim();

                // length to beats
                let dotted = lengthArg.endsWith('+');
                let denom = parseInt(dotted ? lengthArg.slice(0,-1) : lengthArg,10);
                if (isNaN(denom) || denom<=0) continue;
                let beats = 4.0/denom; if (dotted) beats *= 1.5;
                let duration = toSeconds(beats);
                let startTime = toSeconds(currentBeat);

                // attributes
                let className = null;
                for (let j=3;j<args.length;j++){
                    const a = args[j];
                    const kv = a.split('=',2);
                    if (kv.length!==2) continue;
                    const key = kv[0].trim();
                    const val = kv[1].trim();
                    if (key==='class') {
                        className = val.replace(/^\"|\"$/g,'');
                    }
                }

                // pitch handling: simple single pitch only for now
                const pitch = pitchArg;

                events.push({ lineNumber: i, instrument, pitch, startTime, duration, className });

                currentBeat += beats;
                continue;
            }
        }

        return events;
    }

    playNote(event) {
        // unused: scheduling handled in playSWS
    }

    stopPlayback() {
        this.isPlaying = false;
        this.scheduledTimers.forEach(id => clearTimeout(id));
        this.scheduledTimers = [];
        // Note: scheduled AudioNodes will stop automatically as they were scheduled.
    }

    noteToMidi(note) {
        const table = { 'C':0,'C#':1,'Db':1,'D':2,'D#':3,'Eb':3,'E':4,'F':5,'F#':6,'Gb':6,'G':7,'G#':8,'Ab':8,'A':9,'A#':10,'Bb':10,'B':11 };
        const m = (''+note).match(/([A-Ga-g][#b]?)(-?\d+)/);
        if (!m) return 60;
        const name = m[1][0].toUpperCase() + (m[1][1]||'');
        const octave = parseInt(m[2],10);
        const sem = table[name]||0;
        return (octave+1)*12 + sem;
    }

    midiToFrequency(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

    getOscillatorType(instrument) {
        const t = (instrument||'').toLowerCase();
        if (t.includes('sine')) return 'sine';
        if (t.includes('square')) return 'square';
        if (t.includes('triangle')) return 'triangle';
        if (t.includes('saw')) return 'sawtooth';
        return 'sine';
    }

    handleCodeChange() {
        this.currentCode = this.elements.codeEditor.value;
        this.updateLineNumbers();
        this.detectClasses();
        this.highlightCode();
    }

    updateLineNumbers() {
        const lines = this.currentCode.split(/\r?\n/);
        this.elements.lineNumbers.innerHTML = lines.map((_,i)=>`<div>${i+1}</div>`).join('');
    }

    detectClasses() {
        const set = new Set(['main']);
        const re = /class\s*=\s*"([^"]+)"/g;
        let m;
        while ((m=re.exec(this.currentCode))!==null) set.add(m[1]);
        this.classes = Array.from(set).sort();
        this.renderClassList();
    }

    renderClassList() {
        const container = this.elements.classList;
        container.innerHTML = this.classes.map(name=>`<div class="class-item" data-class="${name}"><div class="class-dot"></div><span>${name}</span></div>`).join('');
        container.querySelectorAll('.class-item').forEach(item=>item.addEventListener('click',()=>{
            this.selectClass(item.getAttribute('data-class'));
        }));
    }

    selectClass(name) { this.selectedClass = this.selectedClass===name ? null : name; this.renderClassList(); this.highlightCode(); }

    highlightCode() {
        const lines = this.currentCode.split(/\r?\n/);
        let html = '';
        for (let i=0;i<lines.length;i++){
            const line = this.escapeHtml(lines[i]);
            const isPlaying = (i===this.playingLine);
            const classNames = isPlaying ? 'highlight-line current' : (this.selectedClass ? 'highlight-line' : '');
            html += `<div class="${classNames}">${line}\n</div>`;
        }
        this.elements.highlightOverlay.innerHTML = html;
    }

    getClassLines(className) {
        const lines = this.currentCode.split(/\r?\n/);
        const res = [];
        for (let i=0;i<lines.length;i++){
            if (className==='main') {
                if (lines[i].includes('snd(') && !lines[i].includes('class=')) res.push(i);
            } else {
                if (lines[i].includes(`class=\"${className}\"`)) res.push(i);
            }
        }
        return res;
    }

    syncScroll() {
        this.elements.highlightOverlay.scrollTop = this.elements.codeEditor.scrollTop;
        this.elements.highlightOverlay.scrollLeft = this.elements.codeEditor.scrollLeft;
        this.elements.lineNumbers.scrollTop = this.elements.codeEditor.scrollTop;
    }

    setPlayingLine(n) { this.playingLine = n; this.highlightCode(); }
    clearPlayHighlight() { this.playingLine = null; this.highlightCode(); }

    consoleLog(message, type='info'){
        const out = this.elements.consoleOutput;
        if (out) {
            const line = document.createElement('div');
            line.className = `console-line ${type}`;
            line.textContent = message;
            out.appendChild(line);
            out.scrollTop = out.scrollHeight;
        } else {
            // fallback
            if (type==='error') console.error(message); else console.log(message);
        }
    }

    escapeHtml(text){
        const map = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#039;"};
        return (''+text).replace(/[&<>"']/g,m=>map[m]);
    }
}

// Init
document.addEventListener('DOMContentLoaded', ()=>{ window.swsConsole = new SWSWebConsole(); console.log('SWS Web Console initialized (fixed)'); });
