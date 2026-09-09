"""Regenerate bundled Japanese reports using Open JTalk and a licensed voice."""
import argparse
from array import array
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import wave

parser = argparse.ArgumentParser()
parser.add_argument('--executable', default='open_jtalk')
parser.add_argument('--dictionary', required=True)
parser.add_argument('--voice', required=True)
args = parser.parse_args()
out = Path(__file__).resolve().parents[1] / 'assets' / 'voice'
reports = json.loads((out / 'reports.json').read_text())
with tempfile.TemporaryDirectory() as tmp:
    for name, text in reports.items():
        raw = Path(tmp) / 'speech.wav'
        subprocess.run([args.executable, '-x', args.dictionary, '-m', args.voice,
                        '-r', '1.12', '-ow', str(raw)], input=text.encode(), check=True)
        with wave.open(str(raw), 'rb') as source:
            assert source.getnchannels() == 1 and source.getsampwidth() == 2
            rate = source.getframerate()
            data = array('h', source.readframes(source.getnframes()))
        if sys.byteorder != 'little':
            data.byteswap()
        # Linear PCM resampling keeps generation dependency-free.
        step = rate / 22050
        result = array('h')
        for i in range(int(len(data) / step)):
            pos = i * step
            j = min(int(pos), len(data) - 2)
            result.append(round(data[j] * (1 - (pos - j)) + data[j + 1] * (pos - j)))
        peak = max(map(abs, result), default=1) or 1
        result = array('h', (round(v * (0.85 * 32767 / peak)) for v in result))
        if sys.byteorder != 'little':
            result.byteswap()
        with wave.open(str(out / f'{name}.wav'), 'wb') as dest:
            dest.setparams((1, 2, 22050, 0, 'NONE', 'not compressed'))
            dest.writeframes(result.tobytes())
print(f'Generated {len(reports)} Japanese reports in {out}')
