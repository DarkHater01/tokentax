from cli import build_parser, main


def test_flag_default_false():
    assert build_parser().parse_args(["bob"]).shout is False


def test_flag_present():
    assert build_parser().parse_args(["--shout", "bob"]).shout is True


def test_main_plain():
    assert main(["bob"]) == "bob"


def test_main_shout():
    assert main(["--shout", "bob"]) == "BOB"
