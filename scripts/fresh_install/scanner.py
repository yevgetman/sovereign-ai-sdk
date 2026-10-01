"""Bounded artifact inspection. Never extract archive paths to a filesystem.

Spooling is seekable for ZIP and recursion, but memory is bounded by chunk_size.
Temporary bytes and expanded bytes have separate cumulative limits. A finite
known-residue policy cannot establish absence of arbitrary secrets.
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import pathlib
import posixpath
import re
import stat
import tarfile
import tempfile
import zipfile

SCANNER_VERSION = "1.0.1"
DEFAULT_LIMITS = dict(chunk_size=1024 * 1024, max_depth=12, max_members=200000,
                      max_expanded_bytes=32 * 1024**3, max_temporary_bytes=32 * 1024**3,
                      max_diagnostics=200, max_metadata_bytes=16 * 1024**2)
_POLICY_FILE = pathlib.Path(__file__).with_name("policy.json")
_POLICY_BYTES = _POLICY_FILE.read_bytes()
POLICY = json.loads(_POLICY_BYTES)


class LimitError(Exception):
    pass


def _safe(value):
    """Control-escaped paths with private markers replaced, no payload windows."""
    value = str(value)
    value = re.sub(r"/(?:Users|home)/[^/\s!]+", "<builder-home>", value)
    for needles in POLICY["rules"].values():
        for needle in needles:
            value = re.sub(re.escape(needle), "<private-marker>", value, flags=re.IGNORECASE if needle.lower() == "juliewajo" else 0)
    return value.encode("unicode_escape").decode("ascii")[:1024]


def _norm(name):
    if not name or name.startswith(("/", "\\")) or "\\" in name or re.match(r"^[A-Za-z]:", name):
        return None
    normalized = posixpath.normpath(name)
    if normalized == ".." or normalized.startswith("../"):
        return None
    return normalized.removeprefix("./")


class Matcher:
    def __init__(self, scanner, label):
        self.scanner, self.label, self.tail = scanner, label, b""
        self.context = 0

    def feed(self, data, final=False):
        buf = self.tail + data
        # Keep a window large enough for supported identifiers across boundaries.
        # Home/namespace decisions at an unfinished boundary wait for the next chunk.
        cutoff = len(buf) if final else max(0, len(buf) - 4096)
        for encoding in POLICY["encodings"]:
            unit = 1 if encoding == "utf-8" else 2
            # Byte-oriented patterns retain both UTF-16 alignments in executables.
            for rule, needles in POLICY["rules"].items():
                for needle in needles:
                    encoded = needle.encode(encoding)
                    start = 0
                    while True:
                        search_buf = buf.lower() if rule in POLICY.get("case_insensitive_rules", []) else buf
                        idx = search_buf.find(encoded.lower() if rule in POLICY.get("case_insensitive_rules", []) else encoded, start)
                        if idx < 0 or idx >= cutoff:
                            break
                        private_checkout = True
                        if rule == "private-checkout":
                            after = buf[idx + len(encoded):idx + len(encoded) + unit].decode(encoding, errors="ignore")
                            before = buf[max(0, idx - unit):idx].decode(encoding, errors="ignore")
                            private_checkout = not (after and (after.isalnum() or after in "._-")) and not (before and before.isalnum())
                        if idx >= self.context and private_checkout and (rule != "operator-namespace" or not self.approved_span(buf, idx, encoding)):
                            self.scanner.find(self.label, rule)
                        start = idx + max(1, len(encoded))
            for root in ("/Users/", "/home/"):
                prefix = root.encode(encoding)
                start = 0
                while True:
                    idx = buf.find(prefix, start)
                    if idx < 0 or idx >= cutoff:
                        break
                    rest = buf[idx + len(prefix):]
                    try:
                        decoded = rest[:2048 * unit].decode(encoding, errors="ignore")
                    except UnicodeError:
                        decoded = ""
                    account = re.match(r"[^/\s\x00\x01-\x1f\"\'<>:;]+", decoded)
                    if idx >= self.context and account and account.group() != "runner":
                        self.scanner.find(self.label, "builder-home")
                    start = idx + len(prefix)
        keep = max(0, cutoff - 256)
        self.tail = buf[keep:]
        self.context = cutoff - keep

    @classmethod
    def approved_span(cls, buf, idx, encoding):
        if cls._approved(buf, idx, encoding):
            return True
        if encoding == "utf-8" and cls._approved_go(buf, idx):
            return True
        # ASCII UTF-16 tokens can match in both endian encodings shifted by a
        # byte. Check the corresponding span instead of inventing a second
        # namespace from the padding byte before the actual encoded text.
        if encoding.startswith("utf-16"):
            alternate = "utf-16-be" if encoding.endswith("le") else "utf-16-le"
            needle = "yevgetman".encode(alternate)
            for shifted in (idx - 1, idx + 1):
                if shifted >= 0 and buf[shifted:shifted + len(needle)] == needle and cls._approved(buf, shifted, alternate):
                    return True
        return False

    @staticmethod
    def _approved_go(buf, idx):
        """Recognize only explicitly approved Go symbol/import-name formats.

        Go internal/abi.Name stores flags, canonical unsigned varint length,
        then the exact name bytes. Import-path records have flags zero. Unlike
        a text boundary exception, this validates the entire bounded record.
        References: Go src/internal/abi/type.go and cmd/compile/reflectdata.
        """
        for exception in POLICY["exceptions"]:
            kind = exception["type"]
            if kind not in ("go-import-name", "go-equality-symbol"):
                continue
            text = exception["value"]
            token = text.encode("utf-8")
            begin = idx - text.index("yevgetman")
            if begin < 0 or buf[begin:begin + len(token)] != token:
                continue
            if kind == "go-equality-symbol":
                prefix = b"type:.eq."
                start = begin - len(prefix)
                if start < 0 or buf[start:begin] != prefix or (start and buf[start - 1] != 0):
                    continue
                end = buf.find(b"\0", begin, begin + 1025)
                if end < 0:
                    continue
                suffix = buf[begin + len(token):end]
                # Go compiler types/fmt.go appends middle-dot plus digits to
                # function-scope type names (for example laneEntry\u00b71).
                if re.fullmatch(rb"(?:/[A-Za-z0-9_-]+)+(?:\.[A-Za-z0-9_]+)+(?:\xc2\xb7[0-9]+)?", suffix):
                    return True
                continue
            for width in (1, 2):
                header = begin - width - 1
                if header < 0 or buf[header] != 0:
                    continue
                encoded = buf[header + 1:begin]
                if any(byte < 128 for byte in encoded[:-1]) or encoded[-1] >= 128:
                    continue
                length = sum((byte & 127) << (7 * shift) for shift, byte in enumerate(encoded))
                if length > 1024 or length < len(token) or (width > 1 and length < 128):
                    continue
                end = begin + length
                if end > len(buf):
                    continue
                name = buf[begin:end]
                suffix = name[len(token):]
                if not re.fullmatch(rb"(?:/[A-Za-z0-9_-]+)*", suffix):
                    continue
                # A corrupt shorter length must not manufacture a boundary in
                # the middle of a longer import path. Adjacent encoded records
                # start with a control-valued flags byte, not path characters.
                if end < len(buf) and (buf[end:end + 1].isalnum() or buf[end] in b"._/-@"):
                    continue
                return True
        return False

    @staticmethod
    def _approved(buf, idx, encoding):
        for exception in POLICY["exceptions"]:
            if exception["type"] != "namespace":
                continue
            text = exception["value"]
            token = text.encode(encoding)
            offset = text.index("yevgetman") * (1 if encoding == "utf-8" else 2)
            begin = idx - offset
            if begin < 0 or buf[begin:begin + len(token)] != token:
                continue
            # A multi-byte Go Name length must not fall back to text-token
            # approval when its final byte is NUL or invalid UTF-8. The typed
            # validator below decides canonical length and complete record.
            if encoding == "utf-8" and text.startswith("github.com/"):
                binary_length = any(
                    begin >= width + 1 and buf[begin - width - 1] == 0
                    and all(byte & 128 for byte in buf[begin - width:begin - 1])
                    for width in range(2, 6)
                )
                if binary_length:
                    continue
            unit = 1 if encoding == "utf-8" else 2
            before = buf[max(0, begin - unit):begin].decode(encoding, errors="ignore")
            after = buf[begin + len(token):begin + len(token) + unit].decode(encoding, errors="ignore")
            if before and (before.isalnum() or before in "._/@-"):
                continue
            if after and (after.isalnum() or after in "._-"):
                continue
            if text.startswith("github") and after == "@":
                continue
            if text.startswith("@") and after == "/":
                continue
            return True
        return False


class Scanner:
    def __init__(self, architecture, limits):
        self.limits = dict(DEFAULT_LIMITS)
        if limits:
            if set(limits) - set(self.limits):
                raise ValueError("unknown scan limit")
            self.limits.update(limits)
        if any(not isinstance(v, int) or v <= 0 for v in self.limits.values()):
            raise ValueError("scan limits must be positive integers")
        self.found = set()
        self.inventory = []
        self.names = set()
        self.raw_names = set()
        self.raw_files = set()
        self.temporary = 0
        self.receipt = dict(schema_version=1, policy_version=POLICY["version"],
                            policy_sha256=hashlib.sha256(_POLICY_BYTES).hexdigest(),
                            scanner_version=SCANNER_VERSION, architecture=architecture,
                            limits=self.limits, coverage=dict(files=0, bytes=0, archive_members=0,
                            metadata=0, links=0), exclusions=[], findings=[], errors=[],
                            findings_count_unit="file/rule pairs")

    def find(self, path, rule):
        key = (path, rule)
        if key not in self.found:
            self.found.add(key)
            if len(self.receipt["findings"]) < self.limits["max_diagnostics"]:
                self.receipt["findings"].append(dict(path=_safe(path), rule=rule))

    def error(self, path, code):
        if len(self.receipt["errors"]) < self.limits["max_diagnostics"]:
            self.receipt["errors"].append(dict(path=_safe(path), code=code))
        self.error_count += 1

    def metadata(self, label, value):
        self.receipt["coverage"]["metadata"] += 1
        matcher = Matcher(self, label)
        matcher.feed(str(value).encode("utf-8", "surrogateescape"), final=True)

    def entry(self, label, kind, **extra):
        if len(self.inventory) >= self.limits["max_members"]:
            raise LimitError("member-limit")
        self.raw_names.add(label)
        if kind not in ("directory", "link"):
            self.raw_files.add(label)
        self.names.add(_safe(label))
        self.inventory.append(dict(path=_safe(label), path_sha256=hashlib.sha256(label.encode("utf-8", "surrogateescape")).hexdigest(), kind=kind, **extra))

    def chunks(self, stream, label, *, spool=False, match=True):
        matcher, digest, size = Matcher(self, label), hashlib.sha256(), 0
        target = tempfile.TemporaryFile() if spool else None
        try:
            while True:
                data = stream.read(self.limits["chunk_size"])
                if not data:
                    break
                size += len(data)
                self.receipt["coverage"]["bytes"] += len(data)
                if self.receipt["coverage"]["bytes"] > self.limits["max_expanded_bytes"]:
                    raise LimitError("expanded-byte-limit")
                digest.update(data)
                if match:
                    matcher.feed(data)
                if target:
                    self.temporary += len(data)
                    if self.temporary > self.limits["max_temporary_bytes"]:
                        raise LimitError("temporary-byte-limit")
                    target.write(data)
            if match:
                matcher.feed(b"", final=True)
            if target:
                target.seek(0)
            return digest.hexdigest(), size, target
        except BaseException:
            if target:
                target.close()
            raise

    @staticmethod
    def kind(header, label):
        low = label.lower()
        if low.endswith(".dmg") or header.startswith(b"koly"):
            return "unsupported-dmg"
        if header.startswith(b"\x1f\x8b"):
            return "gzip"
        if header.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
            return "zip"
        if len(header) >= 262 and header[257:262] == b"ustar" or low.endswith(".tar") and len(header) >= 512 and not any(header[:512]):
            return "tar"
        if low.endswith(".tar"):
            return "tar"
        if len(header) >= 512:
            try:
                tarfile.TarInfo.frombuf(header[:512], "utf-8", "surrogateescape")
                return "tar"
            except tarfile.TarError:
                pass
        if low.endswith((".tar.gz", ".tgz", ".zip", ".gz")):
            return "malformed-archive"
        if low.endswith((".7z", ".rar", ".xz", ".bz2", ".zst", ".iso")) or header.startswith((b"7z\xbc\xaf\x27\x1c", b"Rar!", b"\xfd7zXZ", b"BZh", b"\x28\xb5\x2f\xfd")):
            return "unsupported-container"
        return "file"

    def payload(self, stream, label, depth, mode=None):
        self.receipt["coverage"]["files"] += 1
        # Buffer only the signature, then stream the full input exactly once.
        header = stream.read(512)
        kind = self.kind(header, label)
        class Prefix:
            def __init__(self): self.prefix = header
            def read(inner, count):
                if inner.prefix:
                    out, inner.prefix = inner.prefix[:count], inner.prefix[count:]
                    return out
                return stream.read(count)
        digest, size, spool = self.chunks(Prefix(), label, spool=kind != "file", match=kind == "file")
        try:
            self.entry(label, kind, sha256=digest, size=size, mode=mode)
        except BaseException:
            if spool:
                spool.close()
            raise
        if kind == "file":
            return digest
        with spool:
            if kind.startswith(("unsupported", "malformed")):
                self.error(label, kind)
                return digest
            if depth >= self.limits["max_depth"]:
                self.error(label, "archive-depth-limit")
                return digest
            try:
                self.archive(spool, label, kind, depth + 1)
            except (OSError, EOFError, tarfile.TarError, zipfile.BadZipFile, RuntimeError, ValueError, UnicodeError):
                self.error(label, "archive-parser-error")
        return digest

    def archive(self, stream, label, kind, depth):
        if kind == "gzip":
            self.gzip_metadata(stream, label)
            stream.seek(0)
            # Drain gzip explicitly to verify checksum/footer even if tar stops early.
            with gzip.GzipFile(fileobj=stream) as decompressed:
                child = label.removesuffix(".gz") if label.endswith(".gz") else label + "!decompressed"
                self.payload(decompressed, child, depth)
            return
        links, entries = [], {}
        if kind == "tar":
            self.preflight_tar(stream, label)
            stream.seek(0)
            with tarfile.open(fileobj=stream, mode="r|*") as archive:
                for member in archive:
                    self.member_count(label)
                    path = label + "!" + member.name
                    self.metadata(path, member.name)
                    self.metadata(path, member.uname)
                    self.metadata(path, member.gname)
                    for key, value in member.pax_headers.items():
                        self.metadata(path, key)
                        self.metadata(path, value)
                    if member.uid != 0 or member.gid != 0 or member.uname not in ("", "root") or member.gname not in ("", "root"):
                        self.find(path, "archive-ownership")
                    normalized = _norm(member.name)
                    if normalized is None:
                        self.find(path, "unsafe-member-path")
                    elif normalized in entries:
                        self.error(path, "duplicate-member")
                    else:
                        entries[normalized] = "link" if member.issym() or member.islnk() else "file" if member.isfile() else "directory"
                    if member.isfile():
                        extracted = archive.extractfile(member)
                        if extracted is None:
                            self.error(path, "missing-member-payload")
                        else:
                            with extracted: self.payload(extracted, path, depth, member.mode)
                    elif member.isdir():
                        self.entry(path, "directory")
                    elif member.issym() or member.islnk():
                        self.link(path, member.linkname)
                        self.entry(path, "link", target=_safe(member.linkname), target_sha256=hashlib.sha256(member.linkname.encode("utf-8", "surrogateescape")).hexdigest())
                        links.append((normalized, member.linkname, member.issym(), path))
                    else:
                        self.error(path, "unsupported-member-type")
                for key, value in archive.pax_headers.items():
                    self.metadata(label, key)
                    self.metadata(label, value)
            # r|* accepts a missing end marker. Require conventional two zero blocks.
            stream.seek(0, 2)
            length = stream.tell()
            if length < 1024 or length % 512:
                self.error(label, "truncated-tar")
            else:
                stream.seek(-1024, 2)
                if any(stream.read(1024)):
                    self.error(label, "missing-tar-end-marker")
        else:
            # Read only bounded EOCD/ZIP64 records before ZipFile allocates its
            # complete central directory. The stdlib parser itself has no limit.
            end = zipfile._EndRecData(stream)
            if end is None:
                raise zipfile.BadZipFile()
            if end[zipfile._ECD_ENTRIES_TOTAL] > self.limits["max_members"]:
                raise LimitError("archive-member-limit")
            if end[zipfile._ECD_SIZE] > self.limits["max_metadata_bytes"]:
                raise LimitError("archive-metadata-limit")
            stream.seek(0)
            with zipfile.ZipFile(stream) as archive:
                self.metadata(label, archive.comment.decode("utf-8", errors="replace"))
                for member in archive.infolist():
                    self.member_count(label)
                    path = label + "!" + member.filename
                    self.metadata(path, member.filename)
                    self.metadata(path, member.comment.decode("utf-8", errors="replace"))
                    extra_matcher = Matcher(self, path)
                    extra_matcher.feed(member.extra, final=True)
                    self.receipt["coverage"]["metadata"] += 1
                    self.zip_ownership(path, member.extra)
                    normalized = _norm(member.filename)
                    if normalized is None:
                        self.find(path, "unsafe-member-path")
                    elif normalized in entries:
                        self.error(path, "duplicate-member")
                    else:
                        entries[normalized] = "directory" if member.is_dir() else "file"
                    mode = member.external_attr >> 16
                    if stat.S_ISLNK(mode):
                        if member.file_size > 4096:
                            self.error(path, "link-target-limit")
                            continue
                        with archive.open(member) as target_stream:
                            target = target_stream.read().decode("utf-8", errors="strict")
                        self.link(path, target)
                        self.entry(path, "link", target=_safe(target), target_sha256=hashlib.sha256(target.encode("utf-8", "surrogateescape")).hexdigest())
                        entries[normalized] = "link"
                        links.append((normalized, target, True, path))
                    elif member.is_dir():
                        self.entry(path, "directory")
                    else:
                        with archive.open(member) as extracted:
                            self.payload(extracted, path, depth)
        self.validate_links(links, entries)

    def preflight_tar(self, stream, label):
        # tarfile eagerly reads PAX/GNU long-name bodies. Bound those reads before
        # calling it, and reject sparse extensions outside our shipped format set.
        stream.seek(0, 2)
        length = stream.tell()
        stream.seek(0)
        offset, headers = 0, 0
        while offset < length:
            block = stream.read(512)
            if len(block) != 512:
                raise EOFError()
            if not any(block):
                # A conventional tar ends with at least two zero blocks.
                if len(stream.read(512)) != 512:
                    raise EOFError()
                stream.seek(offset)
                while True:
                    tail = stream.read(self.limits["chunk_size"])
                    if not tail:
                        return
                    if any(tail):
                        raise ValueError("unexpected tar trailer")
            info = tarfile.TarInfo.frombuf(block, "utf-8", "surrogateescape")
            metadata_label = label + "!<container-metadata>"
            matcher = Matcher(self, metadata_label)
            matcher.feed(block, final=True)
            self.receipt["coverage"]["metadata"] += 1
            if info.uid != 0 or info.gid != 0 or info.uname not in ("", "root") or info.gname not in ("", "root"):
                self.find(metadata_label, "archive-ownership")
            headers += 1
            if headers > self.limits["max_members"]:
                raise LimitError("archive-member-limit")
            if info.type in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK) and info.size > self.limits["max_metadata_bytes"]:
                raise LimitError("archive-metadata-limit")
            if info.type == tarfile.GNUTYPE_SPARSE or info.size < 0:
                raise ValueError("unsupported sparse or negative member")
            if info.type in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK):
                # Inspect raw extension records too: an overridden global PAX or
                # long-name record still ships bytes even if TarInfo discards it.
                metadata = stream.read(info.size)
                if len(metadata) != info.size:
                    raise EOFError()
                matcher = Matcher(self, metadata_label)
                matcher.feed(metadata, final=True)
                self.receipt["coverage"]["metadata"] += 1
                if info.type in (tarfile.XHDTYPE, tarfile.XGLTYPE):
                    for key, value in re.findall(rb"(?:^|\n)\d+ (uid|gid|uname|gname)=([^\n]*)\n", metadata):
                        if key in (b"uid", b"gid"):
                            try:
                                clean = int(value) == 0
                            except ValueError:
                                self.error(metadata_label, "invalid-pax-ownership")
                                clean = False
                        else:
                            clean = value in (b"", b"root")
                        if not clean:
                            self.find(metadata_label, "archive-ownership")
            offset += 512 + ((info.size + 511) // 512) * 512
            if offset > length:
                raise EOFError()
            stream.seek(offset)
        raise EOFError()

    def zip_ownership(self, label, extra):
        offset = 0
        while offset + 4 <= len(extra):
            tag = int.from_bytes(extra[offset:offset + 2], "little")
            size = int.from_bytes(extra[offset + 2:offset + 4], "little")
            data = extra[offset + 4:offset + 4 + size]
            if len(data) != size:
                self.error(label, "invalid-zip-extra")
                return
            if tag == 0x7875 and (len(data) < 3 or data[0] != 1):
                self.error(label, "unsupported-zip-ownership")
            elif tag == 0x7875 and len(data) >= 3:
                uid_size = data[1]
                gid_offset = 2 + uid_size
                if gid_offset >= len(data):
                    self.error(label, "invalid-zip-ownership")
                else:
                    gid_size = data[gid_offset]
                    if gid_offset + 1 + gid_size > len(data):
                        self.error(label, "invalid-zip-ownership")
                    elif any(data[2:gid_offset]) or any(data[gid_offset + 1:gid_offset + 1 + gid_size]):
                        self.find(label, "archive-ownership")
            elif tag == 0x7855:
                if len(data) != 4:
                    self.error(label, "invalid-zip-ownership")
                elif any(data):
                    self.find(label, "archive-ownership")
            elif tag == 0x000d and len(data) < 12:
                self.error(label, "invalid-zip-ownership")
            elif tag in (0x000d, 0x5855) and len(data) >= 12:
                if any(data[8:12]):
                    self.find(label, "archive-ownership")
            offset += 4 + size
        if offset != len(extra):
            self.error(label, "invalid-zip-extra")

    def gzip_metadata(self, stream, label):
        header = stream.read(10)
        if len(header) != 10 or header[3] & 0xe0:
            raise ValueError("invalid gzip header")
        flags = header[3]
        if flags & 4:
            size_bytes = stream.read(2)
            if len(size_bytes) != 2:
                raise EOFError()
            size = int.from_bytes(size_bytes, "little")
            data = stream.read(size)
            if len(data) != size:
                raise EOFError()
            matcher = Matcher(self, label)
            matcher.feed(data, final=True)
            self.receipt["coverage"]["metadata"] += 1
        for flag in (8, 16):
            if flags & flag:
                matcher = Matcher(self, label)
                self.receipt["coverage"]["metadata"] += 1
                buffer = bytearray()
                while True:
                    value = stream.read(1)
                    if not value:
                        raise EOFError()
                    if value == b"\0":
                        matcher.feed(bytes(buffer), final=True)
                        break
                    buffer.extend(value)
                    if stream.tell() > self.limits["max_metadata_bytes"]:
                        raise LimitError("archive-metadata-limit")
                    if len(buffer) >= self.limits["chunk_size"]:
                        matcher.feed(bytes(buffer))
                        buffer.clear()
        if flags & 2 and len(stream.read(2)) != 2:
            raise EOFError()

    def member_count(self, label):
        self.receipt["coverage"]["archive_members"] += 1
        if self.receipt["coverage"]["archive_members"] > self.limits["max_members"]:
            raise LimitError("archive-member-limit")

    def link(self, path, target):
        self.receipt["coverage"]["links"] += 1
        self.metadata(path, target)

    def validate_links(self, links, entries):
        targets = {}
        for name, target, relative, path in links:
            resolved = _norm(posixpath.join(posixpath.dirname(name or ""), target) if relative else target)
            # Absolute targets are prohibited even when join could normalize them.
            if target.startswith(("/", "\\")) or resolved is None:
                self.find(path, "escaping-link")
                continue
            targets[name] = resolved
        for name, target, relative, path in links:
            if name not in targets:
                continue
            seen, current, cyclic = {name}, targets[name], False
            while True:
                parts = current.split("/")
                prefix = next(("/".join(parts[:i]) for i in range(1, len(parts) + 1) if "/".join(parts[:i]) in targets), None)
                if prefix is None:
                    break
                if prefix in seen:
                    cyclic = True
                    break
                seen.add(prefix)
                suffix = current[len(prefix):].lstrip("/")
                current = posixpath.join(targets[prefix], suffix) if suffix else targets[prefix]
            if cyclic:
                self.error(path, "cyclic-link")
            elif current not in entries and not any(entry.startswith(current + "/") for entry in entries):
                self.error(path, "broken-link")
            elif entries.get(current) == "file":
                self.raw_files.add(path)

    def directory(self, root):
        root = pathlib.Path(root).resolve()
        directory_snapshots = []
        for folder, dirs, files in os.walk(root, followlinks=False, onerror=lambda _: self.error(".", "directory-read-error")):
            directory_snapshots.append((pathlib.Path(folder), pathlib.Path(folder).stat()))
            for name in sorted(dirs + files):
                path = pathlib.Path(folder) / name
                label = path.relative_to(root).as_posix()
                self.metadata(label, label)
                before = path.lstat()
                if stat.S_ISLNK(before.st_mode):
                    target = os.readlink(path)
                    self.link(label, target)
                    self.entry(label, "link", target=_safe(target), target_sha256=hashlib.sha256(target.encode("utf-8", "surrogateescape")).hexdigest())
                    try:
                        resolved = path.resolve(strict=True)
                        if os.path.isabs(target) or not resolved.is_relative_to(root):
                            self.find(label, "escaping-link")
                        elif resolved.is_file():
                            self.raw_files.add(label)
                        elif not resolved.is_dir():
                            self.error(label, "unsupported-link-target")
                    except (OSError, RuntimeError):
                        self.error(label, "broken-or-cyclic-link")
                elif stat.S_ISDIR(before.st_mode):
                    self.entry(label, "directory", mode=before.st_mode & 0o7777)
                elif stat.S_ISREG(before.st_mode):
                    try:
                        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                        with os.fdopen(os.open(path, flags), "rb") as stream:
                            opened = os.fstat(stream.fileno())
                            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                                self.error(label, "changed-file")
                                continue
                            self.payload(stream, label, 0, before.st_mode & 0o7777)
                            after = os.fstat(stream.fileno())
                        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_mode) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_mode):
                            self.error(label, "changed-file")
                    except (OSError, ValueError):
                        self.error(label, "file-read-error")
                else:
                    self.error(label, "unsupported-file-type")
        for folder, before in directory_snapshots:
            try:
                after = folder.stat()
                if (before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns):
                    self.error(folder.relative_to(root), "changed-directory")
            except OSError:
                self.error(folder.relative_to(root), "changed-directory")


def scan_path(path, required_paths=(), architecture=None, limits=None):
    """Return a JSON-serializable receipt, never a false clean on coverage failure.

    Required paths match exact relative inventory paths, an archive member suffix
    after ``!``, or an entire nested archive label. Require files, not directory
    presence alone. Caller component inventory is recorded in the receipt.
    """
    required_paths = tuple(required_paths)
    scanner = Scanner(architecture, limits)
    scanner.error_count = 0
    scanner.receipt["required_paths"] = [_safe(p) for p in required_paths]
    target = pathlib.Path(path)
    scanner.receipt["input_kind"] = "directory" if target.is_dir() else "artifact"
    try:
        if target.is_symlink():
            scanner.error(".", "symlink-input")
        elif target.is_dir():
            scanner.directory(target)
        elif target.is_file():
            before = target.stat()
            with target.open("rb") as stream:
                digest = scanner.payload(stream, target.name, 0)
                after = os.fstat(stream.fileno())
            scanner.receipt["artifact_sha256"] = digest
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_mode) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_mode):
                scanner.error(".", "changed-file")
        else:
            scanner.error(".", "missing-input")
    except LimitError as error:
        scanner.error(".", str(error))
    except (OSError, EOFError, ValueError, tarfile.TarError, zipfile.BadZipFile):
        scanner.error(".", "input-read-or-parser-error")
    if not scanner.receipt["coverage"]["files"]:
        scanner.error(".", "empty-file-coverage")
    for required in required_paths:
        if not any(name == required or name.endswith("!" + required) for name in scanner.raw_files):
            scanner.error(required, "missing-required-path")
    inventory = sorted(scanner.inventory, key=lambda item: (item["path"], item["kind"]))
    scanner.receipt["inventory"] = inventory
    scanner.receipt["inventory_sha256"] = hashlib.sha256(json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    scanner.receipt["findings_count"] = len(scanner.found)
    scanner.receipt["errors_count"] = scanner.error_count
    result = "incomplete" if scanner.error_count else "findings" if scanner.found else "clean"
    scanner.receipt.update(result=result, exit_code={"clean": 0, "findings": 1, "incomplete": 2}[result])
    return scanner.receipt
