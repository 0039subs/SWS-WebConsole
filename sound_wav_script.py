# Sound Wav Script (renamed)
# Formerly: SOUND-WAV-SCRIPT.py
# Now: sound_wav_script.py
# v0.2 - Stable Edition (Track-based class system + UST import support)
# Security and path-hardening applied for web console usage

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

try:
    import chardet
except Exception:
    chardet = None

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

# File safety limits
MAX_FILE_READ_BYTES = 10 * 1024 * 1024  # 10 MB

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

        # ensure path is not absolute or with drive on Windows
        if os.path.isabs(self.filename):
            output_path = os.path.abspath(self.filename)
        else:
            output_path = os.path.abspath(os.path.join(ss_dir, self.filename))

        # prevent path traversal: normalized path must start with ss_dir
        try:
            norm_ss_dir = os.path.normpath(ss_dir)
            norm_output = os.path.normpath(output_path)
            if not os.path.commonpath([norm_ss_dir, norm_output]) == norm_ss_dir:
                raise ValueError("output path escapes project directory")
        except Exception:
            raise ValueError("invalid or unsafe output path")

        if self.type == "wav":
            if not output_path.lower().endswith(".wav"):
                output_path += ".wav"
        elif self.type == "midi":
            if not output_path.lower().endswith(('.mid', '.midi')):
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
        
{