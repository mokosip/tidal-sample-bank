import re

from .analysis import Features

# Ordered: first match wins.
_NAME_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(p), t)
    for p, t in [
        (r"bass", "bass"),
        (r"kick|^\d*bd", "kick"),
        (r"^\d*(sn|sd|cp)|clap", "snare"),
        (r"^\d*(hh|cy|oh)|hat|^ho$|cymbal|ride|crash|^(cc|cr)$", "hat"),
        (r"^808(ht|mt|lt|lc|mc)$|^(ht|mt|lt|cb)$", "perc"),
        (r"break|amen|loop", "loop"),
        (r"numbers|speak|speech|diphone|voice|vox|mouth|alphabet|kurt", "voice"),
        (r"piano|arp|pad|key|gtr|sax|sitar|superpiano|notes|moog|juno|pluck", "tonal"),
        (r"tabla|conga|perc|drum|tok|clak|hand|bottle|glass", "perc"),
        (r"nature|bird|wind|fire|sea|rain|vinyl|noise", "texture"),
    ]
]


def guess_type(bank: str, f: Features | None) -> str:
    name = bank.lower()
    for rx, t in _NAME_RULES:
        if rx.search(name):
            return t
    if f is None:
        return "other"
    if f.duration > 2.0:
        return "texture"
    if f.centroid > 4000:
        return "hat"
    if f.centroid < 300:
        return "kick"
    if f.attack < 0.02:
        return "perc"
    return "other"
