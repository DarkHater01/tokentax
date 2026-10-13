from mathx import clamp
from use import normalize


def test_clamp_inside():
    assert clamp(5) == 5


def test_clamp_low():
    assert clamp(-3) == 0


def test_clamp_high():
    assert clamp(99) == 10


def test_normalize():
    assert normalize([-1, 5, 42]) == [0, 5, 10]
