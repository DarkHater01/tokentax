import argparse


def build_parser():
    p = argparse.ArgumentParser(prog="demo")
    p.add_argument("name")
    p.add_argument("--shout", action="store_true")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args.name.upper() if args.shout else args.name
