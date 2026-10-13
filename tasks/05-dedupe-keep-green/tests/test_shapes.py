import inspect
import math

import shapes


def test_circle_area():
    assert abs(shapes.circle_area(2) - math.pi * 4) < 1e-9


def test_sphere_volume():
    assert abs(shapes.sphere_volume(3) - (4 / 3) * math.pi * 27) < 1e-9


def test_pi_is_defined_once():
    # The duplication is the bug: the literal must not be repeated per function.
    src = inspect.getsource(shapes)
    assert src.count("3.141592653589793") <= 1
