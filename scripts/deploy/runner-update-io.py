#!/usr/bin/env python3
"""Host updater boundary: untrusted volume I/O and a direct control-plane probe."""
import json
import os
import re
import secrets
import stat
import sys
import urllib.request
from urllib.parse import urlsplit


def directory(path):
    # Walk from / without following *any* symlink. Keep the final directory open,
    # so renaming/replacing a parent cannot redirect subsequent writes.
    if not os.path.isabs(path):
        raise ValueError('Expected an absolute Docker mount path')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split('/'):
            if not part:
                continue
            if part in ('.', '..'):
                raise ValueError('Invalid mount path')
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def status(path):
    parent = directory(path)
    try:
        fd = os.open('update-status.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd) as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise ValueError('Status must be a regular file')
            raw = source.read(65537)
            if len(raw) > 65536:
                raise ValueError('Status is too large')
            value = json.loads(raw)
        print(json.dumps(value))
    finally:
        os.close(parent)


def feedback(path, target, state, error, attempt):
    parent = directory(path)
    name = '.updater-' + secrets.token_hex(24)
    created = False
    try:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        created = True
        with os.fdopen(fd, 'w') as output:
            output.write(json.dumps(dict(target=target, state=state, error=error, attempt=attempt)) + '\n')
            output.flush()
            os.fchmod(output.fileno(), 0o644)
            os.fsync(output.fileno())
            entry = os.stat(name, dir_fd=parent, follow_symlinks=False)
            opened = os.fstat(output.fileno())
            if (entry.st_dev, entry.st_ino) != (opened.st_dev, opened.st_ino):
                raise ValueError('Feedback temporary file was replaced')
            # Even a replacement after this check cannot redirect a root write:
            # rename replaces a symlink itself and never follows its target.
            os.replace(name, 'updater-result.json', src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        if created:
            try:
                os.unlink(name, dir_fd=parent)
            except FileNotFoundError:
                pass
        os.close(parent)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError('Control-plane redirects are not allowed')


def target():
    # Docker's container configuration is host-owned, unlike files in its volumes.
    env = dict(item.split('=', 1) for item in json.load(sys.stdin)[0]['Config']['Env'] if '=' in item)
    base = env['CORRAL_SERVER_URL'].rstrip('/')
    url = urlsplit(base)
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment or url.path:
        raise ValueError('Expected the configured private control-plane origin')
    request = urllib.request.Request(base + '/runner/version', headers={'Authorization': 'Bearer ' + env['CORRAL_RUNNER_TOKEN']})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=10) as response:
        commit = json.loads(response.read(8192))['commit']
    if not isinstance(commit, str) or not re.fullmatch('[0-9a-f]{40}', commit):
        raise ValueError('Control plane did not report a release commit')
    print(commit)


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'target':
            target()
        elif sys.argv[1] == 'status':
            status(sys.argv[2])
        elif sys.argv[1] == 'feedback':
            feedback(*sys.argv[2:])
        else:
            raise ValueError('Unknown updater operation')
    except Exception:
        # Never print container configuration or authentication headers.
        sys.exit('Host updater boundary operation failed; check mount paths and control-plane connectivity')
