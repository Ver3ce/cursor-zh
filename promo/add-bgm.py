# -*- coding: utf-8 -*-
"""为 04-vertical.mp4 生成原创可商用配乐并合成。节奏对齐汉化前后切换（约 2.2s）。"""
import os
import subprocess
import wave

import imageio_ffmpeg
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
VIDEO = os.path.join(HERE, "04-vertical.mp4")
WAV = os.path.join(HERE, "bgm-tech-reveal.wav")
OUT = os.path.join(HERE, "04-vertical-bgm.mp4")

SR = 44100
DUR = 6.73
BPM = 112
BEAT = 60.0 / BPM
REVEAL = 2.20


def midi(n):
    return 440.0 * (2 ** ((n - 69) / 12.0))


def one_pole_lp(x, cutoff):
    if x.size == 0:
        return x
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    y[0] = (1 - a) * x[0]
    for i in range(1, len(x)):
        y[i] = (1 - a) * x[i] + a * y[i - 1]
    return y


def one_pole_hp(x, cutoff):
    return x - one_pole_lp(x, cutoff)


def adsr(n, a, d, s, r, peak=1.0):
    env = np.zeros(n, dtype=np.float64)
    na, nd, nr = int(a * SR), int(d * SR), int(r * SR)
    ns = max(0, n - na - nd - nr)
    i = 0
    if na:
        env[i : i + na] = np.linspace(0, peak, na, endpoint=False)
        i += na
    if nd:
        env[i : i + nd] = np.linspace(peak, peak * s, nd, endpoint=False)
        i += nd
    if ns:
        env[i : i + ns] = peak * s
        i += ns
    if nr and i < n:
        env[i : i + min(nr, n - i)] = np.linspace(peak * s, 0, min(nr, n - i), endpoint=True)
    return env


def place(buf, sig, t0):
    i = int(t0 * SR)
    n = min(len(sig), len(buf) - i)
    if i >= 0 and n > 0:
        buf[i : i + n] += sig[:n]


def fade(n, fi=0.12, fo=0.55):
    e = np.ones(n)
    a, b = int(fi * SR), int(fo * SR)
    if a:
        e[:a] *= np.linspace(0, 1, a)
    if b:
        e[-b:] *= np.linspace(1, 0, b)
    return e


def pad_tone(freq, n, detune=0.0):
    t = np.arange(n) / SR
    f = freq * (2 ** (detune / 1200.0))
    vib = 1 + 0.003 * np.sin(2 * np.pi * 0.18 * t)
    sig = np.zeros(n)
    for k, amp in ((1, 1.0), (2, 0.22), (3, 0.10), (4, 0.05)):
        sig += amp * np.sin(2 * np.pi * f * k * t * vib)
    sig *= adsr(n, 0.35, 0.8, 0.72, 1.1)
    return one_pole_lp(sig, 1800)


def pluck(freq, n):
    t = np.arange(n) / SR
    env = np.exp(-t * 7.2)
    sig = np.sin(2 * np.pi * freq * t) + 0.28 * np.sin(2 * np.pi * freq * 2 * t)
    click = np.exp(-t * 90) * np.sin(2 * np.pi * freq * 3 * t) * 0.18
    return one_pole_lp((sig + click) * env, 4200)


def kick(n):
    t = np.arange(n) / SR
    f = 118 * np.exp(-t * 18) + 38
    return np.sin(2 * np.pi * f * t) * np.exp(-t * 10)


def hat(n, bright=1.0):
    rng = np.random.default_rng(3)
    x = one_pole_hp(rng.standard_normal(n), 5000 * bright)
    t = np.arange(n) / SR
    return x * np.exp(-t * 55)


def clap(n):
    rng = np.random.default_rng(9)
    t = np.arange(n) / SR
    bursts = np.zeros(n)
    for off in (0.0, 0.012, 0.026):
        i = int(off * SR)
        if i < n:
            bursts[i:] += np.exp(-(t[: n - i]) * 38)
    return one_pole_hp(rng.standard_normal(n) * bursts, 900) * 0.55


def noise_whoosh(n):
    rng = np.random.default_rng(21)
    x = rng.standard_normal(n)
    t = np.arange(n) / SR
    # 截止频率随时间打开
    cuts = 400 + 5200 * (t / t[-1]) ** 1.6
    y = np.zeros(n)
    z = 0.0
    for i in range(n):
        a = np.exp(-2 * np.pi * cuts[i] / SR)
        z = (1 - a) * x[i] + a * z
        y[i] = z
    env = (t / t[-1]) ** 1.35 * (1 - t / t[-1]) ** 0.15
    return y * env


def bell(freq, n):
    t = np.arange(n) / SR
    sig = (
        np.sin(2 * np.pi * freq * t)
        + 0.35 * np.sin(2 * np.pi * freq * 2.76 * t)
        + 0.12 * np.sin(2 * np.pi * freq * 5.4 * t)
    )
    return sig * np.exp(-t * 4.8)


def render():
    n = int(DUR * SR)
    L = np.zeros(n)
    R = np.zeros(n)

    # 和弦：Am9 → Fmaj7（切换点）→ Cadd9 → Gsus
    # 对齐画面：0–2.2s 英文，2.2s 起切到中文
    chords = [
        (0.00, 2.20, [45, 48, 52, 55, 59]),       # A2 C3 E3 G3 B3
        (2.20, 4.29, [41, 45, 48, 52, 55]),       # F2 A2 C3 E3 G3
        (4.29, 6.73, [48, 52, 55, 59, 62]),       # C3 E3 G3 B3 D4
    ]
    for t0, t1, notes in chords:
        ln = int((t1 - t0 + 0.15) * SR)
        acc_l = np.zeros(ln)
        acc_r = np.zeros(ln)
        for i, note in enumerate(notes):
            acc_l += pad_tone(midi(note), ln, detune=-6 + i) * (0.22 if i == 0 else 0.16)
            acc_r += pad_tone(midi(note), ln, detune=5 - i * 0.4) * (0.22 if i == 0 else 0.16)
        place(L, acc_l, t0)
        place(R, acc_r, t0)

    # 琶音：八分音符，跟着当前和弦
    eighth = BEAT / 2
    arp_degrees = [0, 2, 1, 4, 2, 3, 1, 4]
    t = 0.0
    step = 0
    while t < DUR - 0.05:
        notes = chords[0][2]
        for t0, t1, ns in chords:
            if t0 - 1e-6 <= t < t1:
                notes = ns
                break
        freq = midi(notes[arp_degrees[step % len(arp_degrees)]] + 12)
        pn = int(0.42 * SR)
        p = pluck(freq, pn) * (0.20 if t < REVEAL else 0.26)
        place(L, p * 0.92, t)
        place(R, p * 1.08, t + 0.012)
        t += eighth
        step += 1

    # 低音
    for t0, t1, notes in chords:
        ln = int((t1 - t0) * SR)
        tt = np.arange(ln) / SR
        bass = np.sin(2 * np.pi * midi(notes[0]) * tt) * adsr(ln, 0.04, 0.2, 0.65, 0.25) * 0.22
        place(L, bass, t0)
        place(R, bass, t0)

    # 轻打击：底鼓 1、3 拍；拍手从切换点起
    klen, hlen, clen = int(0.28 * SR), int(0.09 * SR), int(0.32 * SR)
    beat_i = 0
    bt = 0.0
    while bt < DUR:
        k = kick(klen)
        if beat_i % 2 == 0:
            place(L, k * 0.28, bt)
            place(R, k * 0.28, bt)
        h = hat(hlen, bright=0.85 + 0.2 * (beat_i % 2)) * (0.045 if beat_i % 2 == 0 else 0.07)
        place(L, h * 1.05, bt)
        place(R, h * 0.95, bt + 0.004)
        if beat_i >= 4 and beat_i % 2 == 1:
            c = clap(clen) * 0.16
            place(L, c, bt)
            place(R, c * 0.9, bt + 0.006)
        bt += BEAT
        beat_i += 1

    # 切换前的 sweep + 切换点铃音
    whoosh = noise_whoosh(int(1.15 * SR)) * 0.18
    place(L, whoosh * 1.05, REVEAL - 1.15)
    place(R, whoosh * 0.95, REVEAL - 1.13)
    for note, amp in ((72, 0.20), (76, 0.14), (79, 0.10)):
        b = bell(midi(note), int(1.6 * SR)) * amp
        place(L, b * 0.9, REVEAL)
        place(R, b * 1.1, REVEAL + 0.008)

    # 立体声微延迟 + 母带
    delay = int(0.018 * SR)
    L2 = L.copy()
    R2 = R.copy()
    R2[delay:] += L[:-delay] * 0.12
    L2[delay:] += R[:-delay] * 0.10
    mix = np.stack([one_pole_hp(L2, 70), one_pole_hp(R2, 70)], axis=1)
    mix *= fade(n)[:, None]

    peak = np.max(np.abs(mix)) + 1e-9
    mix = mix / peak * 0.78
    mix = np.tanh(mix * 1.15) / np.tanh(1.15)
    peak = np.max(np.abs(mix)) + 1e-9
    mix = mix / peak * 0.89
    return mix


def write_wav(path, stereo):
    pcm = np.clip(stereo, -1, 1)
    pcm = (pcm * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def mux():
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run(
        [
            ff, "-y", "-loglevel", "error",
            "-i", VIDEO,
            "-i", WAV,
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
            "-map", "0:v:0", "-map", "1:a:0",
            "-shortest",
            "-movflags", "+faststart",
            OUT,
        ],
        check=True,
    )


if __name__ == "__main__":
    audio = render()
    write_wav(WAV, audio)
    mux()
    print(f"wav  {os.path.getsize(WAV)/1024:.0f} KB  {WAV}")
    print(f"mp4  {os.path.getsize(OUT)/1024:.0f} KB  {OUT}")
