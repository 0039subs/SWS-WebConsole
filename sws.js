/**
 * SWS Web Console - Main Controller
 * v0.1
 */

class SWSWebConsole {
    constructor() {
        this.currentCode = '';
        this.currentFile = null;
        this.classes = ['main'];
        this.selectedClass = null;
        this.playingLine = null;

        this.initializeUI();
        this.setupEventListeners();
        this.loadInitialCode();
    }

    /**
     * Initialize UI elements
     */
    initializeUI() {
        this.elements = {
            // Buttons
            openBtn: document.getElementById('openBtn'),
            saveBtn: document.getElementById('saveBtn'),
            playBtn: document.getElementById('playBtn'),
            stopBtn: document.getElementById('stopBtn'),

            // File input
            fileInput: document.getElementById('fileInput'),

            // Editor
            codeEditor: document.getElementById('codeEditor'),
            highlightOverlay: document.getElementById('highlightOverlay'),
            lineNumbers: document.getElementById('lineNumbers'),

            // Classes
            classList: document.getElementById('classList'),

            // Console
            consoleOutput: document.getElementById('consoleOutput'),
        };
    }

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Buttons
        this.elements.openBtn.addEventListener('click', () => this.handleOpen());
        this.elements.saveBtn.addEventListener('click', () => this.handleSave());
        this.elements.playBtn.addEventListener('click', () => this.handlePlay());
        this.elements.stopBtn.addEventListener('click', () => this.handleStop());

        // File input
        this.elements.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

        // Editor
        this.elements.codeEditor.addEventListener('input', () => this.handleCodeChange());
        this.elements.codeEditor.addEventListener('scroll', () => this.syncScroll());
    }

    /**
     * Load initial SWS code
     */
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

    /**
     * Handle Open button
     */
    handleOpen() {
        this.elements.fileInput.click();
    }

    /**
     * Handle file selection
     */
    handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            this.currentCode = e.target.result;
            this.currentFile = file.name;
            this.elements.codeEditor.value = this.currentCode;
            this.handleCodeChange();
            this.consoleLog(`Loaded: ${file.name}`, 'success');
        };

        reader.onerror = () => {
            this.consoleLog('Failed to read file', 'error');
        };

        reader.readAsText(file);
    }

    /**
     * Handle Save button
     */
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

    /**
     * Handle Play button
     */
    handlePlay() {
        try {
            this.currentCode = this.elements.codeEditor.value;

            if (!this.currentCode.trim()) {
                this.consoleLog('No code to play', 'warning');
                return;
            }

            this.elements.playBtn.disabled = true;
            this.elements.stopBtn.disabled = false;
            this.consoleLog('Playing...', 'info');

            // TODO: Connect to Web Audio Renderer
            // playSWS(this.currentCode);
        } catch (error) {
            this.consoleLog(`Play error: ${error.message}`, 'error');
            this.elements.playBtn.disabled = false;
            this.elements.stopBtn.disabled = true;
        }
    }

    /**
     * Handle Stop button
     */
    handleStop() {
        this.elements.playBtn.disabled = false;
        this.elements.stopBtn.disabled = true;
        this.consoleLog('Stopped', 'info');
        this.clearPlayHighlight();

        // TODO: Connect to Web Audio Renderer
        // stopSWS();
    }

    /**
     * Handle code change
     */
    handleCodeChange() {
        this.currentCode = this.elements.codeEditor.value;
        this.updateLineNumbers();
        this.detectClasses();
        this.highlightCode();
    }

    /**
     * Update line numbers
     */
    updateLineNumbers() {
        const lines = this.currentCode.split('\n');
        const lineNumbersDiv = this.elements.lineNumbers;

        lineNumbersDiv.innerHTML = lines
            .map((_, i) => `<div>${i + 1}</div>`)
            .join('');
    }

    /**
     * Detect classes from code
     */
    detectClasses() {
        const classSet = new Set(['main']);
        const classMatches = this.currentCode.matchAll(/class="([^"]+)"/g);

        for (const match of classMatches) {
            if (match[1]) {
                classSet.add(match[1]);
            }
        }

        this.classes = Array.from(classSet).sort();
        this.renderClassList();
    }

    /**
     * Render class list
     */
    renderClassList() {
        const classList = this.elements.classList;
        classList.innerHTML = this.classes
            .map((className) => {
                const isSelected = className === this.selectedClass;
                return `
                    <div class="class-item ${isSelected ? 'selected' : ''}" data-class="${className}">
                        <div class="class-dot"></div>
                        <span>${className}</span>
                    </div>
                `;
            })
            .join('');

        // Add click listeners
        classList.querySelectorAll('.class-item').forEach((item) => {
            item.addEventListener('click', () => {
                const className = item.getAttribute('data-class');
                this.selectClass(className);
            });
        });
    }

    /**
     * Select class
     */
    selectClass(className) {
        this.selectedClass = className === this.selectedClass ? null : className;
        this.renderClassList();
        this.highlightCode();
    }

    /**
     * Highlight code based on selected class
     */
    highlightCode() {
        const lines = this.currentCode.split('\n');
        let html = '';

        if (this.selectedClass) {
            const classLines = this.getClassLines(this.selectedClass);
            lines.forEach((line, idx) => {
                if (classLines.includes(idx)) {
                    const lineClass = idx === this.playingLine ? 'highlight-line current' : 'highlight-line';
                    html += `<div class="${lineClass}">${this.escapeHtml(line)}\n</div>`;
                } else {
                    const lineClass = idx === this.playingLine ? 'highlight-line current' : '';
                    html += `<div class="${lineClass}">${this.escapeHtml(line)}\n</div>`;
                }
            });
        } else {
            lines.forEach((line, idx) => {
                const lineClass = idx === this.playingLine ? 'highlight-line current' : '';
                html += `<div class="${lineClass}">${this.escapeHtml(line)}\n</div>`;
            });
        }

        this.elements.highlightOverlay.innerHTML = html;
    }

    /**
     * Get line numbers for a class
     */
    getClassLines(className) {
        const lines = this.currentCode.split('\n');
        const lineNumbers = [];

        if (className === 'main') {
            lines.forEach((line, idx) => {
                if (line.includes('snd(') && !line.includes('class=')) {
                    lineNumbers.push(idx);
                }
            });
        } else {
            lines.forEach((line, idx) => {
                if (line.includes(`class="${className}"`)) {
                    lineNumbers.push(idx);
                }
            });
        }

        return lineNumbers;
    }

    /**
     * Sync scroll between editor and highlight
     */
    syncScroll() {
        this.elements.highlightOverlay.scrollTop = this.elements.codeEditor.scrollTop;
        this.elements.highlightOverlay.scrollLeft = this.elements.codeEditor.scrollLeft;
        this.elements.lineNumbers.scrollTop = this.elements.codeEditor.scrollTop;
    }

    /**
     * Set playing line (for Play position highlight)
     */
    setPlayingLine(lineNumber) {
        this.playingLine = lineNumber;
        this.highlightCode();
    }

    /**
     * Clear play highlight
     */
    clearPlayHighlight() {
        this.playingLine = null;
        this.highlightCode();
    }

    /**
     * Add message to console
     */
    consoleLog(message, type = 'info') {
        const consoleOutput = this.elements.consoleOutput;
        const line = document.createElement('div');
        line.className = `console-line ${type}`;
        line.textContent = message;
        consoleOutput.appendChild(line);
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }

    /**
     * Escape HTML special characters
     */
    escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;',
        };
        return text.replace(/[&<>"']/g, (m) => map[m]);
    }
}

/**
 * Initialize SWS Web Console on DOM ready
 */
document.addEventListener('DOMContentLoaded', () => {
    window.swsConsole = new SWSWebConsole();
    console.log('SWS Web Console initialized');
});
