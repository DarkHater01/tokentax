import argparse


def build_parser():
    p = argparse.ArgumentParser(prog="demo")
    p.add_argument("name")
    return p


def main(argv=None):
    return build_parser().parse_args(argv).name
