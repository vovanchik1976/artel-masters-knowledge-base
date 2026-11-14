#!/usr/bin/env python3
"""Deterministic local water-drop cue: a short decaying sine with falling pitch."""
import math
import struct
import wave
from pathlib import Path

rate = 22050
phase = 0.0
samples = []
for i in range(int(rate * 0.32)):
    t = i / rate
    phase += 2 * math.pi * (900 + 1900 * math.exp(-t * 32)) / rate
    envelope = min(1, t * 700) * math.exp(-t * 16)
    samples.append(struct.pack('<h', int(12000 * envelope * math.sin(phase))))
target = Path(__file__).resolve().parents[1] / 'public/audio/water-drop.wav'
target.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(target), 'wb') as out:
    out.setnchannels(1)
    out.setsampwidth(2)
    out.setframerate(rate)
    out.writeframes(b''.join(samples))
