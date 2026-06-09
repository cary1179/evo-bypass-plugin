#!/usr/bin/env python3
import argparse

import iterm2


DEFAULT_URL = 'https://www.google.com'
DEFAULT_DISPLAY_NAME = 'Agent MD Review'
DEFAULT_IDENTIFIER = 'com.example.agent-md-review'


def parse_args():
    parser = argparse.ArgumentParser(
        description='Register an iTerm2 Toolbelt WebView tool.'
    )
    parser.add_argument(
        '--url',
        default=DEFAULT_URL,
        help=f'WebView URL to register. Defaults to {DEFAULT_URL}.'
    )
    parser.add_argument(
        '--display-name',
        default=DEFAULT_DISPLAY_NAME,
        help=f'Toolbelt display name. Defaults to "{DEFAULT_DISPLAY_NAME}".'
    )
    parser.add_argument(
        '--identifier',
        default=DEFAULT_IDENTIFIER,
        help=f'Tool identifier. Defaults to "{DEFAULT_IDENTIFIER}".'
    )
    return parser.parse_args()


async def main(connection):
    args = parse_args()
    await iterm2.async_register_web_view_tool(
        connection=connection,
        display_name=args.display_name,
        identifier=args.identifier,
        reveal_if_already_registered=True,
        url=args.url
    )


iterm2.run_until_complete(main)
