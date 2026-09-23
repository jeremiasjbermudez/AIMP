"""Download one model file from Hugging Face into a ComfyUI models folder.

Called by fetch-assets.ps1, one file at a time, so a failure names the file
that failed rather than aborting a batch.

The path inside the repository is recorded in assets.json where it is known.
When it is not, the repository is listed and the file matched by name - which
is a fact about that repository rather than a guessed path.

Usage:
  python fetch-model.py --repo Comfy-Org/MiniMax-H3 --file x.safetensors --into <folder>
                        [--path split_files/vae/x.safetensors]
                        [--revision <commit>] [--sha256 <hex>]

--revision downloads the file as it was at that commit of the repository, and
--sha256 checks it once it is in place: a repository can replace a file under
the same name, and a half-copied file loads as a corrupt model.
"""
import argparse
import hashlib
import os
import shutil
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True)
    ap.add_argument('--file', required=True, help='the filename ComfyUI expects')
    ap.add_argument('--into', required=True, help='the models subfolder to place it in')
    ap.add_argument('--path', default=None, help='its path inside the repo, if known')
    ap.add_argument('--revision', default=None, help='the repository commit to download from')
    ap.add_argument('--sha256', default=None, help='the checksum the file must have')
    a = ap.parse_args()

    try:
        from huggingface_hub import HfApi, hf_hub_download
    except ImportError:
        print('huggingface_hub is not installed. Run: pip install huggingface_hub', file=sys.stderr)
        return 2

    api = HfApi()
    path = a.path
    if not path:
        try:
            files = api.list_repo_files(a.repo, revision=a.revision)
        except Exception as e:
            print(f'could not read {a.repo}: {e}', file=sys.stderr)
            return 1
        matches = [f for f in files if os.path.basename(f) == a.file]
        if not matches:
            print(f'{a.file} is not in {a.repo}', file=sys.stderr)
            return 1
        path = matches[0]

    destination = os.path.join(a.into, a.file)
    if os.path.exists(destination):
        print(f'already there: {destination}')
        return 0
    os.makedirs(a.into, exist_ok=True)

    try:
        # Downloaded to the shared cache first, then copied into place: the
        # cache is what lets a second machine, or a re-run, skip the transfer.
        cached = hf_hub_download(repo_id=a.repo, filename=path, revision=a.revision)
    except Exception as e:
        print(f'download failed for {a.repo}/{path}: {e}', file=sys.stderr)
        return 1

    # Copied rather than linked: ComfyUI reads these directly and a link across
    # drives is not something to rely on. Copied under a temporary name and
    # renamed once checked, because ComfyUI lists a file the moment it appears
    # and a half-written one fails to load.
    partial = destination + '.part'
    shutil.copyfile(cached, partial)
    if a.sha256:
        digest = hashlib.sha256()
        with open(partial, 'rb') as f:
            for chunk in iter(lambda: f.read(16 * 1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != a.sha256.lower():
            os.remove(partial)
            print(f'{a.file}: checksum mismatch - expected {a.sha256}, got {digest.hexdigest()}. '
                  'Not installed.', file=sys.stderr)
            return 1
    os.replace(partial, destination)
    size = os.path.getsize(destination) / 1e9
    print(f'{a.file} -> {a.into}  ({size:.2f} GB)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
