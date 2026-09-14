/**
 * SWS Web Console UI Controller
 * v0.1
 */

class SWSWebConsole {
    constructor() {
        this.currentCode = "";
        this.currentFile = null;
        this.classes = [];
        this.selectedClass = null;
        this.classColors = this.loadClassColors();
        this.renderer = new WebAudioRenderer();
        this.parser = new SWSParser();
        this.events = [];
        this.tempoMap = null;

        this.setupEventListeners();
        this.initializeUI();
    }

    setupEventListeners() {
        // File operations
        document.getElementById("openBtn").addEventListener("click", () => this.openFile());
        document.getElementById("saveBtn").addEventListener("click", () => this.saveFile());
        document.getElementById("fileInput").addEventListener("change", (e) => this.handleFileSelect(e));

        // Playback
        document.getElementById("playBtn").addEventListener("click", () => this.play());
        document.getElementById("stopBtn").addEventListener("click", () => this.stop());

        // Code editor
        const editor = document.getElementById("codeEditor");
        editor.addEventListener("input", () => this.onCodeChange());
        editor.addEventListener("scroll", () => this.syncScroll());
    }

    initializeUI() {
        this.currentCode = 'tempoconst="120";\nkey="C";\n\nsnd("piano",4,C4);\n';
        document.getElementById("codeEditor").value = this.currentCode;
        this.onCodeChange();
        this.updateConsole("Ready.", "info");
    }

    openFile() {
        document.getElementById("fileInput").click();
    }

    handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            this.currentFile = file.name;
            this.currentCode = e.target.result;
            document.getElementById("codeEditor").value = this.currentCode;
            this.onCodeChange();
            this.updateConsole(`Loaded: ${file.name}`, "success");
        };

        reader.readAsText(file);
    }

    saveFile() {
        const code = document.getElementById("codeEditor").value;
        const filename = this.currentFile || "untitled.ss";
        const blob = new Blob([code], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
        this.updateConsole(`Saved: ${filename}`, "success");
    }

    onCodeChange() {
        this.currentCode = document.getElementById("codeEditor").value;
        this.updateLineNumbers();
        this.updateClasses();
        this.highlightCode();
    }

    updateLineNumbers() {
        const code = this.currentCode;
        const lines = code.split('\n');
        const lineNumberDiv = document.getElementById("lineNumbers");
        lineNumberDiv.innerHTML = lines.map((_, i) => `<div>${i + 1}</div>`).join("");
    }

    updateClasses() {
        this.classes = ClassDetector.detect(this.currentCode);
        this.renderClassList();
    }

    renderClassList() {
        const classList = document.getElementById("classList");
        classList.innerHTML = this.classes.map(className => {
            const color = this.getClassColor(className);
            const isSelected = className === this.selectedClass;
            return `
                <div class="class-item ${isSelected ? 'selected' : ''}" data-class="${className}">
                    <div class="class-color-dot ${className === 'main' ? 'main' : ''}" style="background-color: ${color}"></div>
                    <span>${className}</span>
                </div>
            `;
        }).join("");

        document.querySelectorAll(".class-item").forEach(item => {
            item.addEventListener("click", (e) => {
                const className = item.getAttribute("data-class");
                this.selectClass(className);
            });
        });
    }

    selectClass(className) {
        this.selectedClass = className;
        this.renderClassList();
        this.highlightCode();
    }

    highlightCode() {
        const lines = this.currentCode.split('\n');
        const layer = document.getElementById("highlightLayer");
        let html = "";

        if (this.selectedClass) {
            const classLines = ClassDetector.getClassLines(this.currentCode, this.selectedClass);
            const color = this.getClassColor(this.selectedClass);

            lines.forEach((line, idx) => {
                if (classLines.includes(idx)) {
                    html += `<div class="highlight-line" style="background-color: ${color}20">${this.escapeHtml(line)}\n</div>`;
                } else {
                    html += `<div>${this.escapeHtml(line)}\n</div>`;
                }
            });
        } else {
            lines.forEach(line => {
                html += `<div>${this.escapeHtml(line)}\n</div>`;
            });
        }

        layer.innerHTML = html;
    }

    syncScroll() {
        const editor = document.getElementById("codeEditor");
        const layer = document.getElementById("highlightLayer");
        layer.scrollTop = editor.scrollTop;
        layer.scrollLeft = editor.scrollLeft;
    }

    play() {
        try {
            const code = document.getElementById("codeEditor").value;
            this.parser = new SWSParser();
            this.events = this.parser.parse(code);
            this.tempoMap = this.parser.tempoMap;

            if (this.events.length === 0) {
                this.updateConsole("No events to play", "warning");
                return;
            }

            document.getElementById("playBtn").disabled = true;
            document.getElementById("stopBtn").disabled = false;
            this.updateConsole("Playing...", "info");

            this.renderer.play(this.events, this.tempoMap, (line) => {
                this.highlightCurrentLine(line);
            });

            setTimeout(() => {
                if (this.renderer.isPlaying === false) {
                    this.stop();
                }
            }, this.tempoMap.beatToSeconds(Math.max(...this.events.map(e => e.end))) * 1000 + 100);

        } catch (e) {
            this.updateConsole(`Error: ${e.message}`, "error");
        }
    }

    highlightCurrentLine(line) {
        const layer = document.getElementById("highlightLayer");
        const lines = layer.querySelectorAll("div");

        lines.forEach((div, idx) => {
            div.classList.remove("current");
            if (idx + 1 === line) {
                div.classList.add("current");
            }
        });
    }

    stop() {
        this.renderer.stop();
        document.getElementById("playBtn").disabled = false;
        document.getElementById("stopBtn").disabled = true;
        this.updateConsole("Stopped", "info");
        this.highlightCode();
    }

    updateConsole(message, type = "info") {
        const console = document.getElementById("consoleOutput");
        const line = document.createElement("div");
        line.className = `console-line ${type}`;
        line.textContent = message;
        console.appendChild(line);
        console.scrollTop = console.scrollHeight;
    }

    getClassColor(className) {
        if (className === "main") return "#999";
        return this.classColors[className] || SWS_CONFIG.COLORS[0].hex;
    }

    saveClassColors() {
        localStorage.setItem("swsClassColors", JSON.stringify(this.classColors));
    }

    loadClassColors() {
        try {
            return JSON.parse(localStorage.getItem("swsClassColors")) || {};
        } catch {
            return {};
        }
    }

    escapeHtml(text) {
        const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
        return text.replace(/[&<>"']/g, m => map[m]);
    }
}

// Initialize on page load
document.addEventListener("DOMContentLoaded", () => {
    window.swsConsole = new SWSWebConsole();
});