from mathx import clamp


def normalize(values):
    return [clamp(v) for v in values]
