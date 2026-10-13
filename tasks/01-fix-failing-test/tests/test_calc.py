from calc import add


def test_add_positives():
    assert add(2, 3) == 5


def test_add_negatives():
    assert add(-1, 1) == 0


def test_add_zero():
    assert add(0, 0) == 0
