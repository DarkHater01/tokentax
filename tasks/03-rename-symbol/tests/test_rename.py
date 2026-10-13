import greet
import app


def test_old_name_gone():
    assert not hasattr(greet, "hello")


def test_new_name():
    assert greet.greet("x") == "hi x"


def test_app_uses_new_name():
    assert app.run("x") == "hi x"
