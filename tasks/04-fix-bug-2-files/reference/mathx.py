def clamp(x, lo=0, hi=10):
    """Return x clamped into the inclusive range [lo, hi]."""
    return max(lo, min(x, hi))
