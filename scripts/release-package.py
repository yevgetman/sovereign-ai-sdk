#!/usr/bin/env python3
"""Portable neutral tar headers; preserves modes and internal links."""
import pathlib
import sys
import tarfile


def package(stage, output):
    root = pathlib.Path(stage).resolve()
    def neutral(info):
        if any(part.startswith('._') or part == '.DS_Store' for part in pathlib.PurePosixPath(info.name).parts):
            return None
        info.uid = info.gid = 0
        info.uname = info.gname = ''
        info.mtime = int(info.mtime)
        info.pax_headers = {key: value for key, value in info.pax_headers.items()
                            if key in {'path', 'linkpath', 'size'}}
        return info
    with tarfile.open(output, 'w:gz', format=tarfile.PAX_FORMAT) as archive:
        for entry in sorted(root.iterdir()):
            archive.add(entry, arcname=entry.name, filter=neutral)


if __name__ == '__main__':
    package(sys.argv[1], sys.argv[2])
