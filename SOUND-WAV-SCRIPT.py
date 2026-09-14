# SOUND-WAV-SCRIPT.py
# Sound Wav Script
# v0.2 - Stable Edition (Track-based class system + UST import support)
#
# Usage:
#   python SOUND-WAV-SCRIPT.py                    (interactive console)
#   python SOUND-WAV-SCRIPT.py main.ss            (direct file)
#   python SOUND-WAV-SCRIPT.py main.ust           (UST file)
#   SOUND-WAV-SCRIPT.exe main.ss                  (Windows EXE)
#   SOUND-WAV-SCRIPT.exe main.ust                 (Windows EXE - UST)

import sys
import os
import re
import math
import wave
import struct
import subprocess
import platform
import shutil
import json
import importlib.util
import time
import io
import tempfile
import copy
import chardet


# ============================================================
# SETTINGS
# ============================================================

SAMPLE_RATE = 44100
CHANNELS = 1
SAMPLE_WIDTH = 2

RESET = "\033[0m"

RAINBOW = [
    "\033[91m",
    "\033[93m",
    "\033[92m",
    "\033[96m",
    "\033[94m",
    "\033[95m",
]

console_color = None
rainbow_mode = False
rainbow_index = 0

VALID_INSTRUMENTS = {
    "piano", "grand_piano",
    "synth", "synth_lead", "synth_bass",
    "bass",
    "drum", "kick", "hihat", "hi_hat", "snare",
    "sine", "square", "triangle", "saw", "sawtooth"
}

# Default instrument for UST import
DEFAULT_UST_INSTRUMENT = "synth"


# ============================================================
# CONSOLE
# ============================================================

def clear_screen():
    """画面をクリア"""
    if platform.system() == "Windows":
        os.system("cls")
    else:
        os.system("clear")


def set_console_color(value):
    """コンソール色を設定（対話型コンソール用）"""
    global console_color
    global rainbow_mode

    value = value.strip()

    if value.lower() == "rainbow":
        rainbow_mode = True
        console_color = None
        clear_screen()
        cprint("Switched to rainbow mode")
        return True

    rainbow_mode = False

    if value.startswith("#"):
        value = value[1:]

    if not re.fullmatch(r"[0-9a-fA-F]{6}", value):
        cprint(f"invalid color: {value}")
        return False

    r = int(value[0:2], 16)
    g = int(value[2:4], 16)
    b = int(value[4:6], 16)

    console_color = f"\033[38;2;{r};{g};{b}m"
    
    clear_screen()
    cprint(f"Color changed to #{value.upper()}")
    return True


def cprint(text=""):
    """カラフル印字"""
    global rainbow_index

    if rainbow_mode:
        color = RAINBOW[
            rainbow_index % len(RAINBOW)
        ]

        rainbow_index += 1

        print(
            color
            + str(text)
            + RESET
        )

    elif console_color:
        print(
            console_color
            + str(text)
            + RESET
        )

    else:
        print(text)


# ============================================================
# ERROR
# ============================================================

class SWSError(Exception):
    pass


def sws_error(line, error_type, message):
    raise SWSError(
        (line, error_type, message)
    )


def show_error(error_tuple):
    """エラーを見やすく表示"""
    line, error_type, message = error_tuple
    cprint("=" * 40)
    cprint("SWS ERROR")
    cprint("=" * 40)
    cprint(f"Line: {line}")
    cprint(f"Type: {error_type}")
    cprint(f"Message: {message}")
    cprint("=" * 40)
    time.sleep(2)


def show_warning(message):
    """警告を表示"""
    cprint("=" * 40)
    cprint("SWS WARNING")
    cprint("=" * 40)
    cprint(message)
    cprint("=" * 40)
    time.sleep(1)


# ============================================================
# NOTE DATA
# ============================================================

class NoteData:
    """音符単位の属性を管理"""

    def __init__(self, pitch, slur=False, key_bypass=False, lyric=None, key="C"):
        self.pitch = pitch
        self.slur = slur
        self.key_bypass = key_bypass
        self.lyric = lyric
        self.key = key

    def to_dict(self):
        return {
            "pitch": self.pitch,
            "slur": self.slur,
            "key_bypass": self.key_bypass,
            "lyric": self.lyric,
            "key": self.key
        }


# ============================================================
# OUTPUT REQUEST
# ============================================================

class OutputRequest:
    """出力要求を内部モデル化"""

    def __init__(self, request_type, filename, line, class_name=None):
        self.type = request_type
        self.filename = filename
        self.line = line
        self.class_name = class_name

    def get_output_path(self, ss_filename):
        """SSSファイルを基準に出力パスを計算"""
        ss_dir = os.path.dirname(os.path.abspath(ss_filename))
        
        if self.filename.startswith(os.path.sep) or (os.name == 'nt' and len(self.filename) > 1 and self.filename[1] == ':'):
            output_path = self.filename
        else:
            output_path = os.path.join(ss_dir, self.filename)
        
        if self.type == "wav":
            if not output_path.lower().endswith(".wav"):
                output_path += ".wav"
        elif self.type == "midi":
            if not output_path.lower().endswith((".mid", ".midi")):
                output_path += ".mid"
        elif self.type == "ust":
            if not output_path.lower().endswith(".ust"):
                output_path += ".ust"
        
        return output_path


# ============================================================
# NOTE TABLE & KEY SCALES
# ============================================================

NOTE_TABLE = {
    "C": 0, "C#": 1, "Db": 1,
    "D": 2, "D#": 3, "Eb": 3,
    "E": 4, "F": 5, "F#": 6,
    "Gb": 6, "G": 7, "G#": 8,
    "Ab": 8, "A": 9, "A#": 10,
    "Bb": 10, "B": 11,
}

KEY_SCALES = {
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
}


def note_to_midi(note, key="C", bypass=False):
    """音名とオクターブからMIDI値を計算（key補正対応）"""

    match = re.fullmatch(
        r"([A-Ga-g](?:#|b)?)(-?\d+)",
        note.strip()
    )

    if not match:
        raise ValueError(f"invalid pitch: {note}")

    name = match.group(1)
    octave = int(match.group(2))
    name = name[0].upper() + name[1:]

    if name not in NOTE_TABLE:
        raise ValueError(f"invalid pitch: {note}")

    base_midi = NOTE_TABLE[name]
    midi_value = (octave + 1) * 12 + base_midi

    if not bypass and key in KEY_SCALES:
        scale = KEY_SCALES[key]
        semitone_in_octave = base_midi % 12

        if semitone_in_octave not in scale:
            best_note = min(scale, key=lambda x: abs(x - semitone_in_octave))
            midi_value = (octave + 1) * 12 + best_note

    if midi_value < 0 or midi_value > 127:
        raise ValueError(f"pitch out of MIDI range: {note}")

    return midi_value


def note_to_frequency(note, key="C", bypass=False):
    """MIDIからHz周波数に変換"""

    midi = note_to_midi(note, key, bypass)

    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def midi_to_note_name(midi_num):
    """MIDI番号を音名に変換"""
    note_names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    octave = (midi_num // 12) - 1
    note = note_names[midi_num % 12]
    return f"{note}{octave}"


# ============================================================
# LENGTH
# ============================================================

def length_to_beats(value):
    """分母からビート数に変換"""

    value = str(value).strip()
    dotted = value.endswith("+")

    if dotted:
        value = value[:-1]

    if not value.isdigit():
        raise ValueError(f"invalid note length: {value}")

    denominator = int(value)

    if denominator <= 0:
        raise ValueError("note length must be greater than 0")

    beats = 4.0 / denominator

    if dotted:
        beats *= 1.5

    return beats


def ust_length_to_beats(ust_length):
    """UST Length（UST Lengthが480=1beat）をSWSビートに変換"""
    try:
        length_val = int(ust_length)
    except ValueError:
        raise ValueError(f"invalid UST Length: {ust_length}")
    
    if length_val <= 0:
        raise ValueError("UST Length must be greater than 0")
    
    # 480 = 1 beat
    beats = length_val / 480.0
    return beats


# ============================================================
# TEMPO MAP
# ============================================================

class TempoMap:
    """複数テンポセグメントを管理"""

    def __init__(self, initial_tempo=120.0):
        if initial_tempo <= 0:
            raise ValueError("tempo must be greater than 0")
        if not math.isfinite(initial_tempo):
            raise ValueError("tempo must be finite")
        self.segments = [(0.0, initial_tempo)]
        self.tempoconst_set = True

    def set_tempoconst(self, tempo):
        """初期テンポ設定（1回のみ）"""
        if not self.tempoconst_set:
            raise ValueError("tempoconst can only be set once")
        if tempo <= 0:
            raise ValueError("tempo must be greater than 0")
        if not math.isfinite(tempo):
            raise ValueError("tempo must be finite")
        self.segments = [(0.0, tempo)]
        self.tempoconst_set = False

    def set_tempo(self, beat_position, tempo):
        """新しいテンポセグメントを追加（newtempo）"""
        if tempo <= 0:
            raise ValueError("tempo must be greater than 0")
        if not math.isfinite(tempo):
            raise ValueError("tempo must be finite")

        self.segments = [
            (b, t) for b, t in self.segments
            if b != beat_position
        ]
        self.segments.append((beat_position, tempo))
        self.segments.sort()

    def beat_to_seconds(self, beat_position):
        """beatから実秒数に変換"""
        if beat_position < 0:
            return 0.0

        total_seconds = 0.0

        for i in range(len(self.segments)):
            segment_beat, tempo = self.segments[i]

            if beat_position <= segment_beat:
                break

            if i + 1 < len(self.segments):
                next_beat = self.segments[i + 1][0]
                beats_in_segment = min(next_beat - segment_beat, beat_position - segment_beat)
            else:
                beats_in_segment = beat_position - segment_beat

            seconds_in_segment = beats_in_segment * 60.0 / tempo
            total_seconds += seconds_in_segment

        return total_seconds

    def beat_to_ust_length(self, beat_duration):
        """SWSのbeat長をUST Lengthに変換（基準：4分音符=480）"""
        return int(beat_duration * 480)

    def get_current_tempo(self, beat_position):
        """指定位置でのテンポを取得"""
        for i in range(len(self.segments) - 1, -1, -1):
            seg_beat, tempo = self.segments[i]
            if beat_position >= seg_beat:
                return tempo
        return self.segments[0][1]

    def beat_to_midi_ticks(self, beat_position, ppq=480):
        """beatからMIDI ticks（PPQ基準）に変換"""
        return int(beat_position * ppq)


# ============================================================
# SOUND EVENT
# ============================================================

class SoundEvent:

    def __init__(self, instrument, start, duration, notes, line, class_name=None):
        self.instrument = instrument
        self.start = start
        self.duration = duration
        self.notes = notes
        self.line = line
        self.class_name = class_name

    @property
    def end(self):
        return self.start + self.duration

    def to_dict(self):
        """JSON互換辞書に変換"""
        notes_list = []
        for note in self.notes:
            if isinstance(note, NoteData):
                notes_list.append(note.to_dict())
            else:
                notes_list.append({"pitch": note, "slur": False, "key_bypass": False, "lyric": None, "key": "C"})

        return {
            "instrument": self.instrument,
            "start": self.start,
            "duration": self.duration,
            "notes": notes_list,
            "line": self.line,
            "class": self.class_name
        }


# ============================================================
# PARSER HELPERS
# ============================================================

def safe_split_cnt(text):
    """安全に-cnt-で分割（文字列・括弧を考慮）"""
    result = []
    current = ""
    
    bracket_depth = 0
    quote = False
    i = 0
    
    while i < len(text):
        char = text[i]
        
        if char == '"' and (i == 0 or text[i-1] != '\\'):
            quote = not quote
            current += char
            i += 1
            continue
        
        if not quote:
            if char == '[':
                bracket_depth += 1
            elif char == ']':
                bracket_depth -= 1
            
            if text[i:i+6] == "-cnt-" and bracket_depth == 0:
                result.append(current.strip())
                current = ""
                i += 6
                continue
        
        current += char
        i += 1
    
    if current.strip():
        result.append(current.strip())
    
    return result


def split_arguments(text):
    """括弧・括正確に解析してカンマで分割"""

    result = []
    current = ""

    bracket_depth = 0
    paren_depth = 0
    quote = False

    for i, char in enumerate(text):

        if char == '"' and (i == 0 or text[i-1] != '\\'):
            quote = not quote
            current += char
            continue

        if not quote:
            if char == "[":
                bracket_depth += 1
            elif char == "]":
                bracket_depth -= 1
                if bracket_depth < 0:
                    raise ValueError("unmatched ]")
            elif char == "(":
                paren_depth += 1
            elif char == ")":
                paren_depth -= 1
                if paren_depth < 0:
                    raise ValueError("unmatched )")

            if char == "," and bracket_depth == 0 and paren_depth == 0:
                result.append(current.strip())
                current = ""
                continue

        current += char

    if bracket_depth != 0:
        raise ValueError("unmatched [")
    if paren_depth != 0:
        raise ValueError("unmatched (")
    
    if current.strip():
        result.append(current.strip())

    return result


def remove_comments(line, line_number):
    """<...>形式のコメントを除去（ネスト禁止、文字列内は無視）"""

    result = ""
    i = 0
    in_string = False

    while i < len(line):

        char = line[i]

        if char == '"':
            in_string = not in_string
            result += char
            i += 1
            continue

        if not in_string and char == "<":

            i += 1
            found_close = False

            while i < len(line):
                if line[i] == "<":
                    sws_error(line_number, "SyntaxError", "comment nesting is not allowed")
                if line[i] == ">":
                    found_close = True
                    i += 1
                    break
                i += 1

            if not found_close:
                sws_error(line_number, "SyntaxError", "unclosed comment")

            continue

        result += char
        i += 1

    return result.strip()


def detect_file_encoding(filepath):
    """ファイルの文字コードを判定"""
    try:
        with open(filepath, 'rb') as f:
            raw_data = f.read()
        
        detected = chardet.detect(raw_data)
        encoding = detected.get('encoding', 'utf-8')
        
        if encoding is None:
            encoding = 'utf-8'
        
        return encoding
    except Exception:
        return 'utf-8'


# ============================================================
# UST PARSER
# ============================================================

class USTParser:
    """UST（UTAU Sequence Text）形式ファイルを解析"""

    def __init__(self):
        self.events = []
        self.tempo = 120.0
        self.current_beat = 0.0

    def parse_file(self, filename):
        """USTファイルを解析してSWSイベントへ変換"""

        if not os.path.isfile(filename):
            sws_error(1, "FileNotFoundError", f"file not found: {filename}")

        # 文字コード判定
        encoding = detect_file_encoding(filename)

        try:
            with open(filename, "r", encoding=encoding, errors='replace') as f:
                lines = f.readlines()
        except Exception as e:
            sws_error(1, "FileError", f"failed to read UST file: {str(e)}")

        # パース
        section = None
        current_note = {}
        line_number = 0

        for line in lines:
            line_number += 1
            line = line.strip()

            if not line:
                continue

            # セクション開始
            if line.startswith("[#"):
                if not line.endswith("]"):
                    sws_error(line_number, "SyntaxError", "invalid UST section header")

                section = line[2:-1]

                if section == "TRACKEND":
                    break

                if section == "SETTING":
                    section = "SETTING"
                    continue

                # ノート開始
                if section.startswith("NOTE"):
                    # 前のノートを保存
                    if current_note:
                        try:
                            self._process_note(current_note, line_number)
                        except Exception as e:
                            sws_error(line_number, "NoteError", str(e))
                    
                    current_note = {}
                    continue

            # キー＝値形式でパース
            if "=" in line:
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip()

                if section == "SETTING":
                    if key == "Tempo":
                        try:
                            self.tempo = float(value)
                            if self.tempo <= 0 or self.tempo > 500:
                                raise ValueError("invalid tempo")
                        except ValueError:
                            sws_error(line_number, "ValueError", f"invalid Tempo value: {value}")

                elif section and section.startswith("NOTE"):
                    current_note[key] = value

        # 最後のノートを処理
        if current_note:
            try:
                self._process_note(current_note, line_number)
            except Exception as e:
                sws_error(line_number, "NoteError", str(e))

        return self.events

    def _process_note(self, note_dict, line_number):
        """USTノートをSWSイベントへ変換"""

        # 必須情報の取得
        lyric = note_dict.get("Lyric", "").strip()
        
        try:
            note_num = int(note_dict.get("NoteNum", "60"))
        except ValueError:
            sws_error(line_number, "ValueError", f"invalid NoteNum: {note_dict.get('NoteNum')}")

        if note_num < 0 or note_num > 127:
            sws_error(line_number, "ValueError", f"NoteNum out of range: {note_num}")

        try:
            length = int(note_dict.get("Length", "480"))
        except ValueError:
            sws_error(line_number, "ValueError", f"invalid Length: {note_dict.get('Length')}")

        if length <= 0:
            sws_error(line_number, "ValueError", "Length must be greater than 0")

        # 長さをビートに変換
        beats = ust_length_to_beats(length)

        # 休符判定
        is_rest = lyric.upper() == "R"

        if is_rest:
            # 休符イベント
            instrument = "null"
            notes = []
        else:
            # 音符イベント
            instrument = DEFAULT_UST_INSTRUMENT
            pitch = midi_to_note_name(note_num)
            
            note_data = NoteData(
                pitch=pitch,
                slur=False,
                key_bypass=True,  # USTの絶対音高を維持
                lyric=lyric if lyric else None,
                key="C"
            )
            notes = [note_data]

        # イベント作成
        event = SoundEvent(
            instrument=instrument,
            start=self.current_beat,
            duration=beats,
            notes=notes,
            line=line_number,
            class_name="main"  # UST読み込みはmainトラック
        )

        self.events.append(event)
        self.current_beat += beats


# ============================================================
# COMPILER - Track-based class system
# ============================================================

class Compiler:

    def __init__(self):
        self.tempo_map = TempoMap(120.0)
        self.events = []
        self.main_cursor = 0.0
        self.track_cursors = {}  # class_name -> cursor position
        self.chips = {}
        self.chips_line = {}
        self.key = "C"
        self.plugins_to_run = []
        self.output_requests = []
        self.current_ust_class = None
        self.recursion_stack = set()
        self.tempoconst_count = 0
        self.source_type = None  # "ss" or "ust"

    def compile_file(self, filename):
        """ファイルをコンパイル（.ss または .ust）"""

        ext = os.path.splitext(filename)[1].lower()

        if ext == ".ust":
            return self.compile_ust(filename)
        elif ext == ".ss":
            return self.compile_ss(filename)
        else:
            sws_error(1, "FileError", f"unsupported file format: {ext}")

    def compile_ust(self, filename):
        """USTファイルをコンパイル"""
        
        self.source_type = "ust"

        try:
            parser = USTParser()
            self.events = parser.parse_file(filename)
            self.tempo_map = TempoMap(parser.tempo)

        except SWSError:
            raise
        except Exception as e:
            sws_error(1, "USTParseError", f"failed to parse UST: {str(e)}")

        return self.events

    def compile_ss(self, filename):
        """SWSファイルをコンパイル"""

        self.source_type = "ss"

        if not os.path.isfile(filename):
            sws_error(1, "FileNotFoundError", f"file not found: {filename}")

        try:
            with open(filename, "r", encoding="utf-8") as file:
                raw_lines = file.readlines()
        except UnicodeDecodeError as e:
            sws_error(1, "EncodingError", f"file encoding error: {str(e)}")
        except Exception as e:
            sws_error(1, "FileError", f"failed to read file: {str(e)}")

        lines = []

        for number, raw in enumerate(raw_lines, 1):
            try:
                line = remove_comments(raw, number)
            except SWSError as e:
                raise e

            if not line:
                continue

            lines.append((number, line))

        self.compile_lines(lines)

        return self.events

    def compile_lines(self, lines):

        i = 0

        while i < len(lines):

            line_number, line = lines[i]
            stripped = line.strip()

            if not stripped:
                i += 1
                continue

            # stray closing brace
            if stripped == "}":
                sws_error(line_number, "SyntaxError", "unexpected }")
            
            # chips declaration
            match = re.fullmatch(r'chips\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{', stripped)

            if match:
                name = match.group(1)
                
                if name in self.chips:
                    sws_error(line_number, "NameError", f"chips '{name}' is already declared at line {self.chips_line[name]}")
                
                block = []
                depth = 1
                i += 1

                while i < len(lines):
                    n, l = lines[i]
                    s = l.strip()

                    if s.endswith("{"):
                        depth += 1
                    if s == "}":
                        depth -= 1
                        if depth == 0:
                            break

                    block.append(lines[i])
                    i += 1

                if depth != 0:
                    sws_error(line_number, "SyntaxError", "chips block is not closed")

                self.chips[name] = block
                self.chips_line[name] = line_number
                i += 1
                continue

            # lp
            match = re.fullmatch(r'lp\s*\(\s*(\d+)\s*\)\s*\{', stripped)

            if match:
                count = int(match.group(1))

                if count <= 0:
                    sws_error(line_number, "ValueError", "lp count must be greater than 0")
                
                if count > 10000:
                    sws_error(line_number, "ValueError", "lp count is too large (max 10000)")

                block = []
                depth = 1
                i += 1

                while i < len(lines):
                    n, l = lines[i]
                    s = l.strip()

                    if s.endswith("{"):
                        depth += 1
                    if s == "}":
                        depth -= 1
                        if depth == 0:
                            break

                    block.append(lines[i])
                    i += 1

                if depth != 0:
                    sws_error(line_number, "SyntaxError", "lp block is not closed")

                for _ in range(count):
                    self.compile_lines(block)

                i += 1
                continue

            # tempoconst
            match = re.fullmatch(r'tempoconst\s*=\s*"([^"]+)"\s*;', stripped)

            if match:
                self.tempoconst_count += 1
                if self.tempoconst_count > 1:
                    sws_error(line_number, "ValueError", "tempoconst can only be set once")
                
                try:
                    value = float(match.group(1))
                except ValueError:
                    sws_error(line_number, "ValueError", "invalid tempo value (must be numeric)")

                if not math.isfinite(value):
                    sws_error(line_number, "ValueError", "tempo must be finite")
                if value <= 0:
                    sws_error(line_number, "ValueError", "tempo must be greater than 0")
                if value > 500:
                    sws_error(line_number, "ValueError", "tempo is too high (max 500 BPM)")

                self.tempo_map = TempoMap(value)
                i += 1
                continue

            # newtempo
            match = re.fullmatch(r'newtempo\s*=\s*"([^"]+)"\s*;', stripped)

            if match:
                try:
                    value = float(match.group(1))
                except ValueError:
                    sws_error(line_number, "ValueError", "invalid tempo value (must be numeric)")

                if not math.isfinite(value):
                    sws_error(line_number, "ValueError", "tempo must be finite")
                if value <= 0:
                    sws_error(line_number, "ValueError", "tempo must be greater than 0")
                if value > 500:
                    sws_error(line_number, "ValueError", "tempo is too high (max 500 BPM)")

                self.tempo_map.set_tempo(self.main_cursor, value)
                i += 1
                continue

            # key
            match = re.fullmatch(r'key\s*=\s*"([^"]+)"\s*;', stripped)

            if match:
                key_name = match.group(1)

                if not key_name:
                    sws_error(line_number, "ValueError", "key name cannot be empty")

                if key_name not in KEY_SCALES:
                    sws_error(line_number, "ValueError", f"invalid key: {key_name}")

                self.key = key_name
                i += 1
                continue

            # index.class
            match = re.fullmatch(r'index\.class\s*\(\s*"([^"]+)"\s*\)\s*;', stripped)

            if match:
                class_name = match.group(1)

                if not class_name:
                    sws_error(line_number, "ValueError", "class name cannot be empty")

                self.current_ust_class = class_name
                i += 1
                continue

            # output.wav
            match = re.fullmatch(r'output\.wav\s*\(\s*"([^"]+)"\s*\)\s*;', stripped)

            if match:
                filename = match.group(1)

                if not filename:
                    sws_error(line_number, "ValueError", "output.wav requires a filename")

                req = OutputRequest("wav", filename, line_number)
                self.output_requests.append(req)
                i += 1
                continue

            # output.midi
            match = re.fullmatch(r'output\.midi\s*\(\s*"([^"]+)"\s*\)\s*;', stripped)

            if match:
                filename = match.group(1)

                if not filename:
                    sws_error(line_number, "ValueError", "output.midi requires a filename")

                req = OutputRequest("midi", filename, line_number)
                self.output_requests.append(req)
                i += 1
                continue

            # output.ust
            match = re.fullmatch(r'output\.ust\s*\(\s*"([^"]+)"\s*\)\s*;', stripped)

            if match:
                filename = match.group(1)

                if not filename:
                    sws_error(line_number, "ValueError", "output.ust requires a filename")

                req = OutputRequest("ust", filename, line_number, self.current_ust_class)
                self.output_requests.append(req)
                i += 1
                continue

            # plugin
            match = re.fullmatch(r'plugin\s*\(\s*"([^"]+)"\s*\)\s*;', stripped)

            if match:
                plugin_name = match.group(1)
                self.plugins_to_run.append((plugin_name, line_number))
                i += 1
                continue

            # chips call
            match = re.fullmatch(r'chips\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*;', stripped)

            if match:
                name = match.group(1)

                if name not in self.chips:
                    sws_error(line_number, "NameError", f"chips '{name}' is not declared yet")

                if name in self.recursion_stack:
                    sws_error(line_number, "RecursionError", f"chips '{name}' has circular dependency")

                self.recursion_stack.add(name)
                try:
                    self.compile_lines(self.chips[name])
                finally:
                    self.recursion_stack.discard(name)

                i += 1
                continue

            # sleep
            match = re.fullmatch(r'sleep\s*\(\s*([0-9]+\+?)\s*\)\s*;', stripped)

            if match:
                length = match.group(1)

                try:
                    beats = length_to_beats(length)
                except ValueError as e:
                    sws_error(line_number, "ValueError", str(e))

                self.main_cursor += beats
                i += 1
                continue

            # snd
            if stripped.startswith("snd("):
                if not stripped.endswith(";"):
                    sws_error(line_number, "SyntaxError", "missing ';'")

                self.compile_snd_expression(line_number, stripped[:-1].strip())
                i += 1
                continue

            sws_error(line_number, "SyntaxError", f"unknown statement: {stripped}")

        return self.events

    def compile_snd_expression(self, line_number, expression):

        try:
            parts = safe_split_cnt(expression)
        except ValueError as e:
            sws_error(line_number, "SyntaxError", str(e))

        if len(parts) == 1:
            event = self.parse_snd(line_number, parts[0])
            self.events.append(event)
            
            # Update appropriate cursor
            if event.class_name is None:
                self.main_cursor = event.end
            else:
                self.track_cursors[event.class_name] = event.end
            return

        # cnt group - all events start at same position
        cnt_group = []
        for part in parts:
            event = self.parse_snd(line_number, part)
            cnt_group.append(event)

        self.events.extend(cnt_group)

        # Update cursors for each class in the group
        # Find max end time for each class
        class_ends = {}
        main_end = None

        for event in cnt_group:
            if event.class_name is None:
                if main_end is None:
                    main_end = event.end
                else:
                    main_end = max(main_end, event.end)
            else:
                if event.class_name not in class_ends:
                    class_ends[event.class_name] = event.end
                else:
                    class_ends[event.class_name] = max(class_ends[event.class_name], event.end)

        # Update main cursor if there were unclassed events
        if main_end is not None:
            self.main_cursor = main_end

        # Update track cursors
        for class_name, end_pos in class_ends.items():
            self.track_cursors[class_name] = end_pos

    def parse_snd(self, line_number, expression):

        if not (expression.startswith("snd(") and expression.endswith(")")):
            sws_error(line_number, "SyntaxError", "invalid snd()")

        inside = expression[4:-1]

        try:
            args = split_arguments(inside)
        except ValueError as e:
            sws_error(line_number, "SyntaxError", f"snd argument error: {str(e)}")

        if len(args) < 3:
            sws_error(line_number, "SyntaxError", "snd() requires at least 3 arguments (instrument, length, pitch)")

        # instrument
        instrument_match = re.fullmatch(r'"([^"]+)"', args[0].strip())

        if not instrument_match:
            sws_error(line_number, "SyntaxError", 'instrument must be written as "name"')

        instrument = instrument_match.group(1).lower()

        if not instrument:
            sws_error(line_number, "ValueError", "instrument name cannot be empty")

        if instrument not in VALID_INSTRUMENTS:
            sws_error(line_number, "ValueError", f"unknown instrument: {instrument}")

        # duration
        try:
            duration = length_to_beats(args[1])
        except ValueError as e:
            sws_error(line_number, "ValueError", str(e))

        # pitch
        pitch_arg = args[2].strip()
        notes = []

        if pitch_arg == "null":
            notes = []
        elif pitch_arg.startswith("fsn="):
            value = pitch_arg[4:].strip()

            if not (value.startswith("[") and value.endswith("]")):
                sws_error(line_number, "SyntaxError", "invalid fsn (must be [note1,note2,...])")

            content = value[1:-1].strip()

            if not content:
                sws_error(line_number, "ValueError", "fsn cannot be empty")

            raw_notes = [x.strip() for x in content.split(",")]

            if len(raw_notes) > 128:
                sws_error(line_number, "ValueError", "fsn has too many notes (max 128)")

            for raw_note in raw_notes:
                if raw_note == "null":
                    sws_error(line_number, "ValueError", "null is not allowed inside fsn")
                note_obj = self.parse_note(raw_note, line_number)
                notes.append(note_obj)
        else:
            note_obj = self.parse_note(pitch_arg, line_number)
            notes.append(note_obj)

        # Parse attributes
        class_name = None
        lyric = None
        seen_attrs = set()

        for arg in args[3:]:
            if "=" not in arg:
                sws_error(line_number, "SyntaxError", f"invalid snd attribute: {arg}")

            attr_name, attr_value = arg.split("=", 1)
            attr_name = attr_name.strip()

            if not attr_name:
                sws_error(line_number, "SyntaxError", "attribute name cannot be empty")

            if attr_name in seen_attrs:
                sws_error(line_number, "SyntaxError", f"duplicate attribute: {attr_name}")

            seen_attrs.add(attr_name)

            if attr_name == "class":
                match = re.fullmatch(r'"([^"]*)"', attr_value.strip())
                if not match:
                    sws_error(line_number, "SyntaxError", 'class must be written as "name"')
                class_name = match.group(1)
                if not class_name:
                    sws_error(line_number, "ValueError", "class name cannot be empty")

            elif attr_name == "Lyric":
                match = re.fullmatch(r'"([^"]*)"', attr_value.strip())
                if not match:
                    sws_error(line_number, "SyntaxError", 'Lyric must be written as "text"')
                lyric = match.group(1)

            else:
                sws_error(line_number, "SyntaxError", f"unknown snd attribute: {attr_name}")

        # Apply lyric to all notes
        if lyric is not None:
            for note in notes:
                if isinstance(note, NoteData):
                    note.lyric = lyric

        # Validate pitch
        for note in notes:
            if note.pitch == "null":
                continue

            try:
                note_to_frequency(note.pitch, note.key, note.key_bypass)
            except ValueError as e:
                sws_error(line_number, "ValueError", str(e))

        # Determine start position based on class
        if class_name is not None:
            # Track-based: use track cursor if exists, otherwise initialize to main cursor
            if class_name not in self.track_cursors:
                self.track_cursors[class_name] = self.main_cursor
            start = self.track_cursors[class_name]
        else:
            # No class: use main cursor
            start = self.main_cursor

        event = SoundEvent(instrument, start, duration, notes, line_number, class_name)

        return event

    def parse_note(self, raw_note, line_number):
        """単一の音符を解析"""

        note = raw_note
        slur = False
        key_bypass = False

        if note.endswith("~!") or note.endswith("!~"):
            slur = True
            key_bypass = True
            note = note[:-2]
        elif note.endswith("~"):
            slur = True
            note = note[:-1]
        elif note.endswith("!"):
            key_bypass = True
            note = note[:-1]

        if note != "null":
            try:
                note_to_midi(note, self.key, key_bypass)
            except ValueError as e:
                sws_error(line_number, "ValueError", str(e))

        return NoteData(note, slur, key_bypass, lyric=None, key=self.key)


# ============================================================
# SYNTH
# ============================================================

def envelope(t, duration):
    if duration <= 0:
        return 0.0

    attack = min(0.02, duration * 0.15)
    release = min(0.10, duration * 0.25)

    if t < attack:
        return t / attack

    if t > duration - release:
        return max(0.0, (duration - t) / release)

    return 1.0


def synth_wave(instrument, frequency, t):
    name = instrument.lower()

    if name in ("sine", "sin"):
        return math.sin(2 * math.pi * frequency * t)

    if name in ("square", "sq"):
        return 1.0 if math.sin(2 * math.pi * frequency * t) >= 0 else -1.0

    if name in ("triangle", "tri"):
        return 2 / math.pi * math.asin(math.sin(2 * math.pi * frequency * t))

    if name in ("saw", "sawtooth"):
        phase = (frequency * t) % 1.0
        return 2 * phase - 1

    if name in ("synth", "synth_lead"):
        return (
            math.sin(2 * math.pi * frequency * t)
            + 0.35 * math.sin(2 * math.pi * frequency * 2 * t)
        )

    if name in ("bass", "synth_bass"):
        return (
            math.sin(2 * math.pi * frequency * t)
            + 0.35 * math.sin(math.pi * frequency * t)
        )

    if name in ("piano", "grand_piano"):
        f = frequency
        return (
            math.sin(2 * math.pi * f * t)
            + 0.45 * math.sin(2 * math.pi * f * 2 * t)
            + 0.25 * math.sin(2 * math.pi * f * 3 * t)
            + 0.12 * math.sin(2 * math.pi * f * 4 * t)
        ) * math.exp(-1.8 * t)

    if name == "kick":
        f = frequency * (1 + 4 * math.exp(-25 * t))
        return math.sin(2 * math.pi * f * t) * math.exp(-10 * t)

    if name == "snare":
        return (
            (math.sin(2 * math.pi * 200 * t)
             + math.sin(2 * math.pi * 300 * t))
            * math.exp(-8 * t)
        )

    if name in ("hihat", "hi_hat"):
        return (
            (math.sin(2 * math.pi * 8000 * t)
             + math.sin(2 * math.pi * 12000 * t))
            * math.exp(-20 * t)
        )

    if name == "drum":
        f = frequency * (1 + 3 * math.exp(-20 * t))
        return math.sin(2 * math.pi * f * t) * math.exp(-8 * t)

    return math.sin(2 * math.pi * frequency * t)


# ============================================================
# SLUR ANALYSIS
# ============================================================

def analyze_slurs(events):
    """スラー対象を特定し、不正なスラーはエラーにする"""
    
    for i, event in enumerate(events):
        for note in event.notes:
            if isinstance(note, NoteData) and note.slur:
                # スラー先を探す
                found_slur_target = False
                
                # 同じ開始時刻で次のイベントを探す
                for j in range(i + 1, len(events)):
                    next_event = events[j]
                    
                    # 異なる開始時刻に到達したらスラー失敗
                    if next_event.start > event.start:
                        break
                    
                    # 同じ開始時刻で、時間的連続なら成立
                    if (next_event.start + next_event.duration == event.start + event.duration
                        and note.pitch == next_event.notes[0].pitch if next_event.notes else False):
                        found_slur_target = True
                        break
                
                # 時間的連続で同じ音の次のイベントを探す
                if not found_slur_target:
                    for j in range(i + 1, len(events)):
                        next_event = events[j]
                        
                        # 現在のイベント終了時刻から始まる
                        if (next_event.start == event.end 
                            and next_event.notes 
                            and note.pitch == next_event.notes[0].pitch):
                            found_slur_target = True
                            break
                        
                        # スラー対象が見つからない場合、次のイベント以降は対象外
                        if next_event.start > event.end:
                            break
                
                if not found_slur_target:
                    raise ValueError(f"slur target not found for {note.pitch} at line {event.line}")


# ============================================================
# MIDI GENERATOR
# ============================================================

def write_variable_length(value):
    """MIDI variable length quantityを生成"""
    result = bytearray()
    result.append(value & 0x7F)
    value >>= 7
    
    while value:
        result.append((value & 0x7F) | 0x80)
        value >>= 7
    
    result.reverse()
    return bytes(result)


class MIDIGenerator:
    """MIDI形式ファイルを生成"""

    def __init__(self, events, tempo_map, key):
        self.events = events
        self.tempo_map = tempo_map
        self.key = key
        self.ppq = 480

    def generate(self, filename):
        """MIDIファイルを生成"""

        # イベントキュー（統合）
        event_queue = []

        # テンポイベント（priority=0）
        for seg_beat, tempo in self.tempo_map.segments:
            tick = int(seg_beat * self.ppq)
            microseconds_per_beat = int(60000000 / tempo)
            
            event = bytearray([
                0xFF, 0x51, 0x03,
                (microseconds_per_beat >> 16) & 0xFF,
                (microseconds_per_beat >> 8) & 0xFF,
                microseconds_per_beat & 0xFF
            ])
            
            event_queue.append((tick, 0, event))

        # ノートイベント
        for event in self.events:
            if not event.notes or event.notes[0].pitch == "null":
                continue

            start_tick = int(event.start * self.ppq)
            end_tick = int(event.end * self.ppq)

            for note in event.notes:
                if note.pitch == "null":
                    continue

                midi_note = note_to_midi(note.pitch, note.key, note.key_bypass)

                # Note On (priority=2)
                note_on = bytearray([0x90, midi_note, 100])
                event_queue.append((start_tick, 2, note_on))

                # Note Off (priority=1)
                note_off = bytearray([0x80, midi_note, 0])
                event_queue.append((end_tick, 1, note_off))

        # イベントをソート（tick順、同じtickならpriority順）
        event_queue.sort(key=lambda x: (x[0], x[1]))

        # トラックデータを生成
        track_data = bytearray()
        current_tick = 0

        for tick, priority, event in event_queue:
            delta = tick - current_tick
            track_data.extend(write_variable_length(delta))
            track_data.extend(event)
            current_tick = tick

        # End of Track
        track_data.extend(bytes([0x00, 0xFF, 0x2F, 0x00]))

        # ヘッダ
        header = bytearray([
            0x4D, 0x54, 0x68, 0x64,
            0x00, 0x00, 0x00, 0x06,
            0x00, 0x00,
            0x00, 0x01,
            (self.ppq >> 8) & 0xFF,
            self.ppq & 0xFF
        ])

        # トラックヘッダ
        track_header = bytearray([
            0x4D, 0x54, 0x72, 0x6B,
            (len(track_data) >> 24) & 0xFF,
            (len(track_data) >> 16) & 0xFF,
            (len(track_data) >> 8) & 0xFF,
            len(track_data) & 0xFF
        ])

        # 一時ファイルへ書き込み、成功時にreplace
        temp_fd, temp_path = tempfile.mkstemp(suffix='.mid')
        try:
            with os.fdopen(temp_fd, 'wb') as f:
                f.write(header)
                f.write(track_header)
                f.write(track_data)
                f.flush()
                os.fsync(f.fileno())
            
            # ファイルハンドルが完全にクローズされたことを確認
            # Windowsでは一時的なファイルロックが残る場合があるため、
            # os.replace() が成功するまで少し待ってリトライする

            for attempt in range(10):
                try:
                    os.replace(temp_path, filename)
                    break
                except (PermissionError, OSError):
                    if attempt >= 9:
                        raise
                    time.sleep(0.1)
        except Exception as e:
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except:
                    pass
            raise Exception(f"Failed to generate MIDI file: {str(e)}")


# ============================================================
# UST GENERATOR
# ============================================================

class USTGenerator:
    """UST形式ファイルを生成"""

    def __init__(self, events, tempo_map, key, class_filter=None):
        self.events = events
        self.tempo_map = tempo_map
        self.key = key
        self.class_filter = class_filter

    def generate(self, filename):
        """USTファイルを生成"""

        # クラスフィルタリング
        filtered_events = []
        if self.class_filter:
            for event in self.events:
                if event.class_name == self.class_filter:
                    filtered_events.append(event)
            
            if not filtered_events:
                raise ValueError(f"UST class '{self.class_filter}' not found")
        else:
            filtered_events = self.events

        # イベントを開始位置順にソート
        sorted_events = sorted(filtered_events, key=lambda e: (e.start, e.line))

        # USTヘッダ
        ust_lines = []
        ust_lines.append("[#VERSION]")
        ust_lines.append("UST Version1.2")
        ust_lines.append("")
        ust_lines.append("[#SETTING]")
        
        initial_tempo = 120.0
        if self.tempo_map.segments:
            initial_tempo = self.tempo_map.segments[0][1]
        
        ust_lines.append(f"Tempo={initial_tempo:.2f}")
        ust_lines.append("Tracks=1")
        ust_lines.append("ProjectName=SoundWavScript")
        ust_lines.append("VoiceDir=%VOICE%uta")
        ust_lines.append("OutFile=")
        ust_lines.append("CacheDir=sample.cache")
        ust_lines.append("Tool1=wavtool.exe")
        ust_lines.append("Tool2=resampler.exe")
        ust_lines.append("Mode2=True")
        ust_lines.append("")

        # タイムラインを構築
        note_index = 0
        current_beat = 0.0
        
        for event in sorted_events:
            # 空白部分を休符で埋める
            if event.start > current_beat:
                gap = event.start - current_beat
                gap_length = self.tempo_map.beat_to_ust_length(gap)
                
                ust_lines.append(f"[#{note_index:04d}]")
                ust_lines.append(f"Length={gap_length}")
                ust_lines.append(f"Lyric=R")
                ust_lines.append("Intensity=100")
                ust_lines.append("Modulation=0")
                ust_lines.append("")
                
                note_index += 1
                current_beat += gap

            # イベント処理
            if not event.notes or event.notes[0].pitch == "null":
                # 休符イベント
                ust_length = self.tempo_map.beat_to_ust_length(event.duration)
                
                ust_lines.append(f"[#{note_index:04d}]")
                ust_lines.append(f"Length={ust_length}")
                ust_lines.append(f"Lyric=R")
                ust_lines.append("Intensity=100")
                ust_lines.append("Modulation=0")
                ust_lines.append("")
                
                note_index += 1
                current_beat = event.end
                continue

            # 複数音は1ノートに
            ust_length = self.tempo_map.beat_to_ust_length(event.duration)

            # NoteNum：一番下の音
            midi_numbers = []
            for note in event.notes:
                if note.pitch != "null":
                    midi_num = note_to_midi(note.pitch, note.key, note.key_bypass)
                    midi_numbers.append(midi_num)
            
            if midi_numbers:
                note_num = min(midi_numbers)
            else:
                note_num = 60

            # Lyric
            if len(event.notes) > 1:
                # 複数音は低い順に音名連結
                note_pitches = []
                for midi_num in sorted(midi_numbers):
                    note_pitches.append(midi_to_note_name(midi_num))
                lyric = "".join(note_pitches)
            elif event.notes[0].lyric:
                lyric = event.notes[0].lyric
            else:
                lyric = "R"

            ust_lines.append(f"[#{note_index:04d}]")
            ust_lines.append(f"Length={ust_length}")
            ust_lines.append(f"Lyric={lyric}")
            ust_lines.append(f"NoteNum={note_num}")
            ust_lines.append("Intensity=100")
            ust_lines.append("Modulation=0")
            ust_lines.append("")

            note_index += 1
            current_beat = event.end

        ust_lines.append("[#TRACKEND]")
        ust_lines.append("")

        # 一時ファイルへ書き込み、成功時にreplace
        temp_fd, temp_path = tempfile.mkstemp(suffix='.ust')
        try:
            with os.fdopen(temp_fd, 'w', encoding='utf-8') as f:
                f.write("\n".join(ust_lines))
                f.flush()
                os.fsync(f.fileno())

            for attempt in range(10):
                try:
                    os.replace(temp_path, filename)
                    break
                except (PermissionError, OSError):
                    if attempt >= 9:
                        raise
                    time.sleep(0.1)
        except Exception as e:
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except:
                    pass
            raise Exception(f"Failed to generate UST file: {str(e)}")


# ============================================================
# WAV RENDERER
# ============================================================

class Renderer:

    def __init__(self, events, tempo_map, key):
        self.events = events
        self.tempo_map = tempo_map
        self.key = key

    def render(self, filename):

        if not self.events:
            raise ValueError("no sound events")

        total_beats = max(event.end for event in self.events)

        if total_beats <= 0:
            raise ValueError("total duration is zero")

        total_seconds = self.tempo_map.beat_to_seconds(total_beats)

        total_samples = int(total_seconds * SAMPLE_RATE) + 1

        buffer = [0.0 for _ in range(total_samples)]

        for event in self.events:

            if not event.notes:
                continue

            start_seconds = self.tempo_map.beat_to_seconds(event.start)
            end_seconds = self.tempo_map.beat_to_seconds(event.end)

            duration_seconds = end_seconds - start_seconds

            if duration_seconds <= 0:
                continue

            start_sample = int(start_seconds * SAMPLE_RATE)
            count = int(duration_seconds * SAMPLE_RATE)

            for note in event.notes:

                pitch = note.pitch if isinstance(note, NoteData) else note

                if pitch == "null":
                    continue

                frequency = note_to_frequency(pitch, note.key, note.key_bypass)

                for i in range(count):

                    index = start_sample + i

                    if index >= len(buffer):
                        break

                    t = i / SAMPLE_RATE

                    value = synth_wave(event.instrument, frequency, t)

                    value *= envelope(t, duration_seconds)

                    value *= 0.18

                    buffer[index] += value

        # Normalize
        peak = max((abs(x) for x in buffer), default=0.0)

        if peak > 0.95:
            scale = 0.95 / peak
            buffer = [x * scale for x in buffer]

        # 一時ファイルへ書き込み、成功時にreplace
        # Windows WinError 32対策：mkstemp() が開いたファイルハンドルを先に閉じる
        temp_fd, temp_path = tempfile.mkstemp(suffix='.wav')
        os.close(temp_fd)

        try:
            with wave.open(temp_path, "wb") as wf:
                wf.setnchannels(CHANNELS)
                wf.setsampwidth(SAMPLE_WIDTH)
                wf.setframerate(SAMPLE_RATE)

                data = bytearray()

                for sample in buffer:
                    sample = max(-1.0, min(1.0, sample))
                    value = int(sample * 32767)
                    data.extend(struct.pack("<h", value))

                wf.writeframes(data)
                wf.flush()

            # wavファイルの書き込みが完全に完了してからreplace
            for attempt in range(10):
                try:
                    os.replace(temp_path, filename)
                    break
                except (PermissionError, OSError):
                    if attempt >= 9:
                        raise
                    time.sleep(0.1)
        except Exception as e:
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except:
                    pass
            raise Exception(f"Failed to generate WAV file: {str(e)}")


# ============================================================
# PLUGIN SYSTEM
# ============================================================

def load_plugin(plugin_name, line_number):
    """plugins/plugin_name.pyを動的読み込み"""

    if not re.fullmatch(r"[A-Za-z0-9_]+", plugin_name):
        sws_error(line_number, "ValueError", f"invalid plugin name: {plugin_name}")

    plugins_dir = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "plugins"
    )

    plugin_path = os.path.join(plugins_dir, f"{plugin_name}.py")

    if not os.path.isfile(plugin_path):
        sws_error(line_number, "FileNotFoundError", f"plugin '{plugin_name}' not found at {plugin_path}")

    spec = importlib.util.spec_from_file_location(plugin_name, plugin_path)

    if spec is None or spec.loader is None:
        sws_error(line_number, "ImportError", f"plugin '{plugin_name}' failed to load")

    module = importlib.util.module_from_spec(spec)
    
    try:
        spec.loader.exec_module(module)
    except Exception as e:
        sws_error(line_number, "RuntimeError", f"plugin '{plugin_name}' import error: {str(e)}")

    if not hasattr(module, "run"):
        sws_error(line_number, "AttributeError", f"plugin '{plugin_name}' does not have run() function")

    return module


def events_to_plugin_data(events, compiler):
    """イベントをPlugin API互換データに変換"""

    initial_tempo = 120.0
    if compiler.tempo_map.segments:
        initial_tempo = compiler.tempo_map.segments[0][1]

    data = {
        "sws_version": "0.2",
        "api_version": 1,
        "type": "song",
        "project": {
            "tempo": initial_tempo,
            "key": compiler.key
        },
        "events": [event.to_dict() for event in events]
    }

    return data


def run_plugins(plugin_list, events, compiler):
    """プラグインを実行（deep copyで独立性を保証）"""

    if not plugin_list:
        return

    for plugin_name, line_number in plugin_list:
        try:
            module = load_plugin(plugin_name, line_number)
            
            # deep copyしてプラグインに渡す（独立性を保証）
            data = events_to_plugin_data(events, compiler)
            data = copy.deepcopy(data)
            
            module.run(data)

        except SWSError as e:
            raise e

        except Exception as e:
            sws_error(line_number, "RuntimeError", f"plugin '{plugin_name}' failed: {str(e)}")


# ============================================================
# PLAYER
# ============================================================

def play_audio(filename):

    system = platform.system()

    try:

        if system == "Windows":
            import winsound
            winsound.PlaySound(filename, winsound.SND_FILENAME)
            return

        if system == "Darwin":
            subprocess.run(["afplay", filename], check=False)
            return

        if shutil.which("aplay"):
            subprocess.run(["aplay", filename], check=False)
            return

        if shutil.which("paplay"):
            subprocess.run(["paplay", filename], check=False)
            return

        if shutil.which("ffplay"):
            subprocess.run(["ffplay", "-nodisp", "-autoexit", filename], check=False)
            return

        cprint("warning: audio player not found.")

    except Exception as e:
        cprint(f"warning: playback error: {e}")


# ============================================================
# LOG
# ============================================================

def format_beats(beats):
    """ビート値を表示用に整形"""
    if beats == 1.0:
        return "1 beat"
    else:
        return f"{beats:g} beat"


def format_pitch_for_log(notes):
    """イベントの音符を表示用にフォーマット"""

    if not notes:
        return "null"

    pitches = []
    for note in notes:
        if isinstance(note, NoteData):
            pitches.append(note.pitch)
        else:
            pitches.append(str(note))

    if len(pitches) == 1:
        return pitches[0]
    else:
        return "[" + ", ".join(pitches) + "]"


def print_success(event):
    """sound success ログ（解析成功のみ）"""

    pitch = format_pitch_for_log(event.notes)
    length = format_beats(event.duration)

    log_str = f"sound success:{event.line},{pitch},{length}"

    if event.class_name is not None:
        log_str += f",class={event.class_name}"
    else:
        log_str += ",class=main"

    cprint(log_str)


def print_output_success(request_type, output_path):
    """出力成功ログ（実際の保存成功時のみ）"""
    cprint(f"output success:{request_type},{output_path}")


# ============================================================
# COMPILATION PIPELINE
# ============================================================

def compile_and_run(filename):
    """ファイルをコンパイル・実行（.ss または .ust）"""

    try:
        compiler = Compiler()
        events = compiler.compile_file(filename)

    except SWSError as e:
        show_error(e.args[0])
        return False

    except Exception as e:
        cprint(f"compiler error: {e}")
        time.sleep(2)
        return False

    # Print success logs for compiled events
    for event in events:
        print_success(event)

    # Slur analysis
    try:
        analyze_slurs(events)
    except ValueError as e:
        sws_error(events[0].line if events else 1, "SlurError", str(e))
        show_error((events[0].line if events else 1, "SlurError", str(e)))
        return False

    # Plugin
    try:
        run_plugins(compiler.plugins_to_run, events, compiler)

    except SWSError as e:
        show_error(e.args[0])
        return False

    except Exception as e:
        cprint(f"plugin execution error: {e}")
        time.sleep(2)
        return False

    # Output Processing
    has_wav_output = any(req.type == "wav" for req in compiler.output_requests)
    has_midi_output = any(req.type == "midi" for req in compiler.output_requests)
    has_ust_output = any(req.type == "ust" for req in compiler.output_requests)

    wav_output_path = None

    # WAV生成
    if has_wav_output:
        try:
            renderer = Renderer(events, compiler.tempo_map, compiler.key)

            for req in compiler.output_requests:
                if req.type == "wav":
                    output_path = req.get_output_path(filename)

                    cprint(f"rendering: {output_path}")

                    # 親ディレクトリ作成
                    output_dir = os.path.dirname(output_path)
                    if output_dir and not os.path.exists(output_dir):
                        try:
                            os.makedirs(output_dir, exist_ok=True)
                        except Exception as e:
                            cprint(f"error: failed to create directory: {e}")
                            return False

                    renderer.render(output_path)
                    print_output_success("wav", output_path)
                    wav_output_path = output_path

        except Exception as e:
            cprint(f"WAV render error: {e}")
            time.sleep(2)
            return False

    # MIDI生成
    if has_midi_output:
        try:
            for req in compiler.output_requests:
                if req.type == "midi":
                    output_path = req.get_output_path(filename)

                    cprint(f"generating: {output_path}")

                    # 親ディレクトリ作成
                    output_dir = os.path.dirname(output_path)
                    if output_dir and not os.path.exists(output_dir):
                        try:
                            os.makedirs(output_dir, exist_ok=True)
                        except Exception as e:
                            cprint(f"error: failed to create directory: {e}")
                            return False

                    midi_gen = MIDIGenerator(events, compiler.tempo_map, compiler.key)
                    midi_gen.generate(output_path)
                    print_output_success("midi", output_path)

        except Exception as e:
            cprint(f"MIDI generation error: {e}")
            time.sleep(2)
            return False

    # UST生成
    if has_ust_output:
        try:
            for req in compiler.output_requests:
                if req.type == "ust":
                    output_path = req.get_output_path(filename)

                    cprint(f"generating: {output_path}")

                    # 親ディレクトリ作成
                    output_dir = os.path.dirname(output_path)
                    if output_dir and not os.path.exists(output_dir):
                        try:
                            os.makedirs(output_dir, exist_ok=True)
                        except Exception as e:
                            cprint(f"error: failed to create directory: {e}")
                            return False

                    ust_gen = USTGenerator(events, compiler.tempo_map, compiler.key, req.class_name)
                    ust_gen.generate(output_path)
                    print_output_success("ust", output_path)

        except Exception as e:
            cprint(f"UST generation error: {e}")
            time.sleep(2)
            return False

    # Playback (WAV only, after all output complete)
    if wav_output_path and os.path.exists(wav_output_path):
        cprint("playing...")
        play_audio(wav_output_path)

    cprint("sound complete.")

    return True


# ============================================================
# INTERACTIVE CONSOLE - Terminal Commands (not .ss commands)
# ============================================================

def interactive_console():
    """対話型コンソール"""

    cprint("==============================")
    cprint(" Sound Wav Script v0.2")
    cprint(" Interactive Console")
    cprint("==============================")
    cprint("")
    cprint("Terminal Commands:")
    cprint("  color RRGGBB  - Set console color (e.g. color FF0000)")
    cprint("  color rainbow - Rainbow mode")
    cprint("  run filename  - Compile and run .ss or .ust file")
    cprint("  help          - Show this help")
    cprint("  exit          - Exit")
    cprint("")

    while True:
        try:
            user_input = input("SWS> ").strip()

            if not user_input:
                continue

            # Parse command
            parts = user_input.split(maxsplit=1)
            command = parts[0].lower()

            if command == "exit":
                cprint("Exiting SWS.")
                break

            elif command == "help":
                cprint("Terminal Commands:")
                cprint("  color RRGGBB  - Set console color (e.g. color FF0000)")
                cprint("  color rainbow - Rainbow mode")
                cprint("  run filename  - Compile and run .ss or .ust file")
                cprint("  help          - Show this help")
                cprint("  exit          - Exit")

            elif command == "color":
                if len(parts) < 2:
                    cprint("error: color requires a value (RRGGBB or 'rainbow')")
                    continue
                color_value = parts[1]
                set_console_color(color_value)

            elif command == "run":
                if len(parts) < 2:
                    cprint("error: run requires a filename")
                    continue
                filename = parts[1]
                if os.path.isfile(filename):
                    compile_and_run(filename)
                else:
                    cprint(f"error: file not found: {filename}")

            else:
                cprint(f"error: unknown command: {command}")
                cprint("type 'help' for available commands")

        except KeyboardInterrupt:
            cprint("\nExiting SWS.")
            break
        except Exception as e:
            cprint(f"error: {e}")


# ============================================================
# MAIN
# ============================================================

def main():

    if len(sys.argv) >= 2:
        # Direct file execution
        filename = sys.argv[1]

        if not os.path.isfile(filename):
            cprint(f"error: file not found: {filename}")
            return 1

        ext = os.path.splitext(filename)[1].lower()
        if ext not in [".ss", ".ust"]:
            cprint(f"error: unsupported file format: {ext}")
            return 1

        cprint("==============================")
        cprint(" Sound Wav Script v0.2")
        cprint("==============================")

        if compile_and_run(filename):
            return 0
        else:
            return 1

    else:
        # Interactive console
        interactive_console()
        return 0


# ============================================================
# ENTRY
# ============================================================

if __name__ == "__main__":

    try:
        sys.exit(main())

    except KeyboardInterrupt:
        cprint("\nSWS stopped.")
        sys.exit(130)