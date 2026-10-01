#!/usr/bin/env python3
"""Portable neutral tar headers; preserves modes and internal links."""
import pathlib
import json
import posixpath
import sys
import tarfile
import zipfile


def verify_version(artifact, expected, target):
    """Read only bounded release metadata after the complete scanner succeeds."""
    limits = {'version': 128, 'build-inputs.json': 16 * 1024**2}
    found = {}

    def read(name, size, stream):
        if name in found or size > limits[name] or stream is None:
            raise ValueError('invalid release metadata')
        data = stream.read(limits[name] + 1)
        if len(data) != size or len(data) > limits[name]:
            raise ValueError('invalid release metadata')
        found[name] = data

    if zipfile.is_zipfile(artifact):
        with zipfile.ZipFile(artifact) as archive:
            for member in archive.infolist():
                name = posixpath.normpath(member.filename)
                if name in limits:
                    # No link may stand in for the version/provenance files.
                    if (member.external_attr >> 16) & 0o170000 == 0o120000:
                        raise ValueError('invalid release metadata')
                    with archive.open(member) as stream:
                        read(name, member.file_size, stream)
    else:
        with tarfile.open(artifact, 'r|*') as archive:
            for member in archive:
                name = posixpath.normpath(member.name)
                if name in limits:
                    if not member.isfile():
                        raise ValueError('invalid release metadata')
                    with archive.extractfile(member) as stream:
                        read(name, member.size, stream)
    if set(found) != set(limits):
        raise ValueError('missing release metadata')
    provenance = json.loads(found['build-inputs.json'])
    if (found['version'].decode('utf-8').strip() != expected or
            provenance.get('version') != expected or provenance.get('target') != target):
        raise ValueError('release metadata does not match requested version/target')


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
    if sys.argv[1] == '--verify-version':
        try:
            verify_version(*sys.argv[2:5])
        except (ValueError, OSError, EOFError, UnicodeError, tarfile.TarError, zipfile.BadZipFile, AttributeError):
            print('release version/provenance verification failed', file=sys.stderr)
            sys.exit(1)
    else:
        package(sys.argv[1], sys.argv[2])
